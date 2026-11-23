// Импорт заказов из сделок CRM Big Prodast. Запускается из cron раз в 10 минут.
// Сделка на этапе CRM_STAGE_ID → заказ в ленте клинеров (один раз на сделку).
import { BOT_USERNAME, db, esc, money, notifyAdmins } from "./util.ts";
import { broadcastOrder, orderLine } from "./flows.ts";
import { crm, CRM_API_KEY, CRM_STAGE_ID } from "./crm_api.ts";

// Названия доп. полей в CRM. Сравнение без регистра; подходит поле, чьё название совпадает или начинается с варианта.
// Переопределяется секретом CRM_FIELDS, например {"address":["Адрес уборки"],"payout":["Клинеру"]}.
const DEFAULT_FIELDS: Record<string, string[]> = {
  address: ["адрес"],
  district: ["район", "микрорайон"],
  area: ["площадь", "м²", "м2", "квадратура"],
  rooms: ["комнат", "кол-во комнат", "количество комнат"],
  notes: ["пожелания", "комментарий"],
  payout: ["выплата клинеру", "выплата", "клинеру"],
};
const FIELDS: Record<string, string[]> = (() => {
  try {
    const custom = JSON.parse(Deno.env.get("CRM_FIELDS") ?? "{}");
    const out = { ...DEFAULT_FIELDS };
    for (const [k, v] of Object.entries(custom)) {
      out[k] = (Array.isArray(v) ? v : [v]).map((s) => String(s).toLowerCase().trim());
    }
    return out;
  } catch {
    console.error("CRM_FIELDS: не JSON, беру поля по умолчанию");
    return DEFAULT_FIELDS;
  }
})();

// Если выплаты нет в поле сделки — процент от суммы сделки (например, 65). Пусто — выплата обязательна в поле.
const PAYOUT_PERCENT = Number(Deno.env.get("CRM_PAYOUT_PERCENT") ?? "");

type Field = { label?: string; value?: string };
// deno-lint-ignore no-explicit-any
type Deal = Record<string, any>;

function fieldsOf(deal: Deal): Field[] {
  return [...(deal.customFields ?? []), ...(deal.contact?.customFields ?? [])];
}

function pick(deal: Deal, key: string): string {
  const names = FIELDS[key] ?? [];
  const all = fieldsOf(deal);
  for (const n of names) {
    const exact = all.find((f) => (f.label ?? "").trim().toLowerCase() === n);
    if (exact?.value?.trim()) return exact.value.trim();
  }
  for (const n of names) {
    const loose = all.find((f) => (f.label ?? "").trim().toLowerCase().startsWith(n));
    if (loose?.value?.trim()) return loose.value.trim();
  }
  return "";
}

const num = (s: string) => {
  const m = s.replace(/\s/g, "").replace(",", ".").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

// Сделка → поля заказа или список того, чего не хватает
function mapDeal(deal: Deal): { order?: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const address = pick(deal, "address");
  const area = Math.round(num(pick(deal, "area")));
  const roomsRaw = pick(deal, "rooms");
  const rooms = roomsRaw ? Math.round(num(roomsRaw)) : null;
  const price = deal.amount == null ? NaN : Math.round(Number(deal.amount));
  const payoutRaw = pick(deal, "payout");
  let payout = payoutRaw ? Math.round(num(payoutRaw)) : NaN;
  if (!Number.isFinite(payout) && Number.isFinite(PAYOUT_PERCENT) && PAYOUT_PERCENT > 0 && Number.isFinite(price)) {
    payout = Math.round((price * PAYOUT_PERCENT) / 100);
  }

  if (!deal.scheduledAt) missing.push("дата и время записи");
  else if (new Date(deal.scheduledAt).getTime() < Date.now()) missing.push("дата записи в будущем");
  if (!Number.isFinite(price)) missing.push("сумма сделки");
  if (!address) missing.push(`поле «${FIELDS.address[0]}»`);
  if (!(area > 0)) missing.push(`поле «${FIELDS.area[0]}» (число м²)`);
  if (roomsRaw && !Number.isFinite(rooms)) missing.push(`поле «${FIELDS.rooms[0]}» — число`);
  if (!Number.isFinite(payout)) missing.push(`поле «${FIELDS.payout[0]}»${PAYOUT_PERCENT ? "" : " (или настройте процент)"}`);
  if (missing.length) return { missing };

  return {
    missing,
    order: {
      crm_deal_id: deal.id,
      crm_deal_number: deal.number ?? null,
      district: pick(deal, "district") || "район не указан",
      address,
      area_m2: area,
      rooms,
      scheduled_at: new Date(deal.scheduledAt).toISOString(),
      price_client: price,
      payout_cleaner: payout,
      notes: pick(deal, "notes") || null,
    },
  };
}

async function findOrCreateClient(name: string | null, phone: string | null) {
  if (phone) {
    const { data } = await db.from("clients").select("id, link_token").eq("phone", phone).maybeSingle();
    if (data) return data;
  }
  const { data, error } = await db.from("clients")
    .insert({ name, phone, source: "crm" }).select("id, link_token").single();
  if (error) throw error;
  return data;
}

async function reportIssue(deal: Deal, reason: string) {
  const { data: prev } = await db.from("crm_import_issues").select("reason").eq("deal_id", deal.id).maybeSingle();
  if (prev?.reason === reason) return; // уже писали ровно об этом
  await db.from("crm_import_issues").upsert({
    deal_id: deal.id, deal_number: deal.number ?? null, reason, updated_at: new Date().toISOString(),
  });
  const who = [deal.contact?.name, deal.title].filter(Boolean).map(esc).join(" · ");
  await notifyAdmins(`⚠️ Сделка #${deal.number ?? "?"} ${who} стоит на этапе импорта, но заказ не создан.\nНе хватает: ${esc(reason)}\nПоправьте сделку в CRM — через 10 минут попробую снова.`);
}

export async function importFromCrm(): Promise<number> {
  if (!CRM_API_KEY || !CRM_STAGE_ID) return 0;
  const deals: Deal[] = await crm(`/deals?stageId=${encodeURIComponent(CRM_STAGE_ID)}`);
  if (!deals?.length) return 0;

  const ids = deals.map((d) => d.id);
  const { data: existing } = await db.from("orders").select("crm_deal_id").in("crm_deal_id", ids);
  const done = new Set((existing ?? []).map((r) => r.crm_deal_id));

  let created = 0;
  for (const deal of deals) {
    if (done.has(deal.id) || deal.status !== "open") continue;
    const { order, missing } = mapDeal(deal);
    if (!order) { await reportIssue(deal, missing.join(", ")); continue; }

    const phone = deal.contact?.phone ?? null;
    const client = await findOrCreateClient(deal.contact?.name ?? null, phone);
    const { data: o, error } = await db.from("orders").insert({ ...order, client_id: client.id }).select().single();
    if (error) {
      if (error.code === "23505") continue; // параллельный запуск уже создал заказ по этой сделке
      throw error;
    }
    await db.from("crm_import_issues").delete().eq("deal_id", deal.id);
    await db.from("order_events").insert({
      order_id: o.id, actor: "system", to_status: "open", comment: `из CRM, сделка #${deal.number ?? deal.id}`,
    });
    const sent = await broadcastOrder(o);
    await notifyAdmins(
      `📥 Заказ из CRM (сделка #${deal.number ?? "?"}):\n${orderLine(o)}\nКлиенту ${money(o.price_client)} · разослан клинерам: ${sent}\n\nСсылка для клиента (отправьте в WhatsApp):\nhttps://t.me/${BOT_USERNAME}?start=c_${client.link_token}`,
    );
    created++;
  }
  return created;
}

// Справка для настройки: воронки, этапы и названия доп. полей в открытых сделках. Значения полей не отдаём.
export async function discoverCrm() {
  const [pipelines, stages, deals] = await Promise.all([crm("/pipelines"), crm("/stages"), crm("/deals")]);
  const labels: Record<string, number> = {};
  for (const d of deals ?? []) {
    for (const f of fieldsOf(d)) {
      const l = (f.label ?? "").trim();
      if (l) labels[l] = (labels[l] ?? 0) + 1;
    }
  }
  // deno-lint-ignore no-explicit-any
  const stageView = (s: any) => ({
    id: s.id, name: s.name, closesAs: s.closesAs, requiredFields: s.requiredFields,
    // deno-lint-ignore no-explicit-any
    openDeals: (deals ?? []).filter((d: any) => d.stageId === s.id).length,
  });
  return {
    pipelines: [
      // deno-lint-ignore no-explicit-any
      ...(pipelines ?? []).map((p: any) => ({
        // deno-lint-ignore no-explicit-any
        name: p.name, stages: (stages ?? []).filter((s: any) => s.pipelineId === p.id).map(stageView),
      })),
      // deno-lint-ignore no-explicit-any
      { name: "(общий входящий)", stages: (stages ?? []).filter((s: any) => !s.pipelineId).map(stageView) },
    ],
    openDeals: deals?.length ?? 0,
    // deno-lint-ignore no-explicit-any
    dealsWithSchedule: (deals ?? []).filter((d: any) => d.scheduledAt).length,
    // deno-lint-ignore no-explicit-any
    dealsWithAmount: (deals ?? []).filter((d: any) => d.amount != null).length,
    customFieldLabels: labels,
    config: { stageId: CRM_STAGE_ID || null, fields: FIELDS, payoutPercent: PAYOUT_PERCENT || null },
  };
}
