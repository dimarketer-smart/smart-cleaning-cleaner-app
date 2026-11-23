// Импорт заказов из сделок CRM Big Prodast. Запускается из cron раз в 10 минут.
// Сделка на этапе CRM_STAGE → заказ в ленте клинеров (один раз на сделку).
import { BOT_USERNAME, db, esc, money, notifyAdmins } from "./util.ts";
import { broadcastOrder, orderLine } from "./flows.ts";
import { CRM_API_KEY, CRM_STAGE, crmTool, stageName } from "./crm_api.ts";

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

// Запасной путь: AI-бот CRM пишет адрес, м² и пожелания в «Заметку о клиенте» свободным текстом.
// Фраза кончается на «;», перенос строки или точку перед новым предложением («кв. 51» не обрывается).
// Точка после сокращений («ул. Абая», «пр. Достык», «д. 3») конец фразы не означает.
const ABBR = String.raw`(?<!(?:^|[\s,(])(?:ул|пр|пр-т|просп|д|дом|кв|мкр|корп|к|стр|пер|б-р|бул|ш|пл|эт|под))`;
const END = String.raw`(?=;|\n|${ABBR}\.\s+[А-ЯЁA-Z]|\.?$)`;
const grab = (text: string, re: RegExp) => (text.match(re)?.[1] ?? "").trim().replace(/[.,]$/, "").slice(0, 200);

export function parseNote(note: string) {
  const t = note ?? "";
  return {
    address: grab(t, new RegExp(String.raw`адрес[уa]?\s*[:—-]?\s*(.+?)${END}`, "i")),
    area: grab(t, /(\d{1,4}(?:[.,]\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i),
    rooms: grab(t, /(\d{1,2})\s*-?\s*(?:комн|к\b|-?комнатн)/i),
    district: grab(t, /(?:мкр\.?|микрорайон|район)\s*[:—-]?\s*([^,.;\n]{2,60})/i),
    notes: grab(t, new RegExp(String.raw`пожелани[еяй]\S*\s*[:—-]?\s*(.+?)${END}`, "i")),
  };
}

// Сделка → поля заказа или список того, чего не хватает
function mapDeal(deal: Deal): { order?: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const note = parseNote(deal.contact?.notes ?? "");
  const address = pick(deal, "address") || note.address;
  const area = Math.round(num(pick(deal, "area") || note.area));
  const roomsRaw = pick(deal, "rooms") || note.rooms;
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
  if (!address) missing.push("адрес (поле «Адрес» или «адрес: …» в заметке о клиенте)");
  if (!(area > 0)) missing.push("площадь (поле «Площадь» или «80 м²» в заметке о клиенте)");
  if (roomsRaw && !Number.isFinite(rooms)) missing.push(`поле «${FIELDS.rooms[0]}» — число`);
  if (!Number.isFinite(payout)) missing.push(`поле «${FIELDS.payout[0]}»${PAYOUT_PERCENT ? "" : " (или настройте процент)"}`);
  if (missing.length) return { missing };

  return {
    missing,
    order: {
      crm_deal_id: deal.id,
      crm_deal_number: deal.number ?? null,
      district: pick(deal, "district") || note.district || "район не указан",
      address,
      area_m2: area,
      rooms,
      scheduled_at: new Date(deal.scheduledAt).toISOString(),
      price_client: price,
      payout_cleaner: payout,
      // Видны клинерам в ленте до взятия заказа — только пожелания, не вся заметка (там адрес и телефон)
      notes: pick(deal, "notes") || note.notes || null,
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
  const { data: prev, error: e1 } = await db.from("crm_import_issues").select("reason").eq("deal_id", deal.id).maybeSingle();
  if (e1) throw e1;
  if (prev?.reason === reason) return; // уже писали ровно об этом
  const { error: e2 } = await db.from("crm_import_issues").upsert({
    deal_id: deal.id, deal_number: deal.number ?? null, reason, updated_at: new Date().toISOString(),
  });
  if (e2) throw e2;
  const who = [deal.contact?.name, deal.title].filter(Boolean).map(esc).join(" · ");
  await notifyAdmins(`⚠️ Сделка #${deal.number ?? "?"} ${who} стоит на этапе импорта, но заказ не создан.\nНе хватает: ${esc(reason)}\nПоправьте сделку в CRM — через 10 минут попробую снова.`);
}

// Открытые сделки на этапе (find_deals ищет по части названия — отсекаем чужие этапы)
async function dealsOnStage(idOrName: string) {
  const stage = await stageName(idOrName);
  if (!stage) throw new Error(`в CRM нет этапа ${idOrName} (секрет CRM_STAGE)`);
  const res = await crmTool("find_deals", { period: "all_time", status: "open", stageName: stage });
  if (res?.truncated) console.warn("crm find_deals: список обрезан", res.shown, "из", res.total);
  // deno-lint-ignore no-explicit-any
  return ((res?.deals ?? []) as any[]).filter((d) => String(d.stage ?? "").trim().toLowerCase() === stage.toLowerCase());
}

// Полная сделка: карточка сделки + доп. поля из карточки клиента, в одном виде с REST API
async function loadDeal(number: number): Promise<Deal | null> {
  const card = await crmTool("deal_card", { number });
  const d = card?.deal;
  if (!d) return null;
  let customFields: Field[] = [];
  const query = d.phone || d.client;
  if (query && d.contactId) {
    const cc = await crmTool("contact_card", { query });
    // deno-lint-ignore no-explicit-any
    const c = (cc?.contacts ?? []).find((x: any) => x.id === d.contactId);
    customFields = c?.customFields ?? [];
  }
  return {
    id: d.id, number: d.number, status: d.status, title: null,
    amount: d.amount ?? null, scheduledAt: d.scheduledAt ?? null,
    contact: { name: d.client ?? null, phone: d.phone ?? null, notes: d.clientNotes ?? "", customFields },
  };
}

export async function importFromCrm(): Promise<number> {
  if (!CRM_API_KEY || !CRM_STAGE) return 0;
  const list = await dealsOnStage(CRM_STAGE);
  if (!list.length) return 0;

  const ids = list.map((d) => d.id);
  const { data: existing, error: exErr } = await db.from("orders").select("crm_deal_id").in("crm_deal_id", ids);
  if (exErr) throw exErr;
  const done = new Set((existing ?? []).map((r) => r.crm_deal_id));

  let created = 0;
  for (const item of list) {
    if (done.has(item.id)) continue;
    const deal = await loadDeal(item.number);
    if (!deal || deal.status !== "open") continue;
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
      `📥 Заказ из CRM (сделка #${deal.number ?? "?"}):\n${orderLine(o)}\nАдрес: ${esc(o.address)}${o.rooms ? ` · комнат: ${o.rooms}` : ""}${o.notes ? `\nПожелания: ${esc(o.notes)}` : ""}\nКлиенту ${money(o.price_client)} · разослан клинерам: ${sent}\nПроверьте, что всё распознано верно.\n\nСсылка для клиента (отправьте в WhatsApp):\nhttps://t.me/${BOT_USERNAME}?start=c_${client.link_token}`,
    );
    created++;
  }
  return created;
}

// Справка для настройки: этапы, сколько на них сделок и названия доп. полей у клиентов сделок на этапе импорта
// (или у первых открытых сделок). Значения полей и данные клиентов не отдаём.
export async function discoverCrm() {
  const [dir, funnel] = await Promise.all([crmTool("crm_directory"), crmTool("funnel")]);
  // deno-lint-ignore no-explicit-any
  const counts = new Map<string, number>((funnel?.stages ?? []).map((s: any) => [s.stage, s.deals]));
  const sample = CRM_STAGE
    ? await dealsOnStage(CRM_STAGE)
    : ((await crmTool("find_deals", { period: "all_time", status: "open", sort: "created_desc" }))?.deals ?? []);
  const labels: Record<string, number> = {};
  let withSchedule = 0, withAmount = 0, checked = 0;
  for (const item of sample.slice(0, 10)) {
    const deal = await loadDeal(item.number);
    if (!deal) continue;
    checked++;
    if (deal.scheduledAt) withSchedule++;
    if (deal.amount != null) withAmount++;
    for (const f of fieldsOf(deal)) {
      const l = (f.label ?? "").trim();
      if (l) labels[l] = (labels[l] ?? 0) + 1;
    }
  }
  return {
    // deno-lint-ignore no-explicit-any
    stages: (dir?.stages ?? []).map((s: any) => ({ name: s.name, openDeals: counts.get(s.name) ?? 0, closesAs: s.closesAs })),
    sample: { stage: CRM_STAGE || "(последние открытые)", checked, withSchedule, withAmount },
    customFieldLabels: labels,
    config: { stage: CRM_STAGE || null, fields: FIELDS, payoutPercent: PAYOUT_PERCENT || null },
  };
}
