// Запускается по расписанию каждые 10 минут (pg_cron → pg_net, см. README).
// Напоминания, снятие неподтверждённых заказов, тревоги админу, автоприёмка через 2 часа.
import { db, esc, localParts, notifyAdmins, send } from "../_shared/util.ts";
import { acceptOrder, orderLine, releaseOrder } from "../_shared/flows.ts";
import { discoverCrm, importFromCrm } from "../_shared/crm.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const H = 3_600_000;

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  // Справка для настройки импорта: ?crm=discover — этапы CRM и названия доп. полей (без данных клиентов)
  if (new URL(req.url).searchParams.get("crm") === "discover") {
    try {
      return Response.json(await discoverCrm());
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
  }
  const log: string[] = [];
  const run = async (name: string, fn: () => Promise<number>) => {
    try { log.push(`${name}: ${await fn()}`); } catch (e) {
      console.error(name, e);
      // deno-lint-ignore no-explicit-any
      log.push(`${name}: error — ${(e as any)?.message ?? JSON.stringify(e)}`);
    }
  };

  const now = new Date();
  const local = localParts(now);
  const tomorrow = localParts(new Date(now.getTime() + 24 * H)).date;
  // Новые сделки из CRM → заказы в ленте
  await run("crm_import", importFromCrm);

  const cleanerTg = async (id: string) =>
    (await db.from("cleaners").select("tg_id").eq("id", id).maybeSingle()).data?.tg_id as number | undefined;

  // 18:00 — просим подтвердить завтрашние заказы
  await run("confirm_reminders", async () => {
    if (local.hour < 18) return 0;
    const { data } = await db.from("orders").select("*").eq("status", "taken").eq("reminded_confirm", false);
    let n = 0;
    for (const o of data ?? []) {
      if (localParts(new Date(o.scheduled_at)).date !== tomorrow) continue;
      const tgId = await cleanerTg(o.cleaner_id);
      if (tgId) {
        await send(tgId, `Подтвердите завтрашнюю уборку до 21:00:\n${orderLine(o)}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: "Подтверждаю", callback_data: `confirm:${o.id}` },
              { text: "Не смогу", callback_data: `cantgo:${o.id}` },
            ]],
          },
        });
      }
      await db.from("orders").update({ reminded_confirm: true }).eq("id", o.id);
      n++;
    }
    return n;
  });

  // 21:00 — не подтвердил: заказ возвращается в ленту со штрафом
  await run("confirm_deadline", async () => {
    if (local.hour < 21) return 0;
    const { data } = await db.from("orders").select("*").eq("status", "taken").eq("reminded_confirm", true);
    let n = 0;
    for (const o of data ?? []) {
      if (localParts(new Date(o.scheduled_at)).date !== tomorrow) continue;
      const tgId = await cleanerTg(o.cleaner_id);
      const r = await releaseOrder(o, "system", "нет подтверждения до 21:00");
      if (r && tgId) await send(tgId, `Заказ №${o.id} снят: не было подтверждения до 21:00. Рейтинг −0,2.`);
      n++;
    }
    return n;
  });

  // За 2 часа — напоминание с адресом
  await run("remind_2h", async () => {
    const soon = new Date(now.getTime() + 2 * H).toISOString();
    const { data } = await db.from("orders").select("*").eq("status", "confirmed")
      .eq("reminded_2h", false).lte("scheduled_at", soon).gt("scheduled_at", now.toISOString());
    for (const o of data ?? []) {
      const tgId = await cleanerTg(o.cleaner_id);
      if (tgId) await send(tgId, `Через 2 часа уборка:\n${orderLine(o)}\nАдрес: ${esc(o.address)}`);
      await db.from("orders").update({ reminded_2h: true }).eq("id", o.id);
    }
    return data?.length ?? 0;
  });

  // Не на месте через 15 минут после начала
  await run("late_alerts", async () => {
    const lateTs = new Date(now.getTime() - 15 * 60_000).toISOString();
    const { data } = await db.from("orders").select("*").in("status", ["taken", "confirmed", "on_way"])
      .eq("alerted_late", false).lte("scheduled_at", lateTs);
    for (const o of data ?? []) {
      await notifyAdmins(`🚨 Клинер не отметился на объекте:\n${orderLine(o)}\nСтатус: ${o.status}`);
      await db.from("orders").update({ alerted_late: true }).eq("id", o.id);
    }
    return data?.length ?? 0;
  });

  // Заказ никто не взял за 2 часа
  await run("unclaimed_alerts", async () => {
    const old = new Date(now.getTime() - 2 * H).toISOString();
    const { data } = await db.from("orders").select("*").eq("status", "open")
      .eq("alerted_unclaimed", false).lte("created_at", old).gt("scheduled_at", now.toISOString());
    for (const o of data ?? []) {
      await notifyAdmins(`⏳ Заказ 2 часа без клинера:\n${orderLine(o)}`);
      await db.from("orders").update({ alerted_unclaimed: true }).eq("id", o.id);
    }
    return data?.length ?? 0;
  });

  // Клиент молчит 2 часа после сдачи — принимаем автоматически
  await run("auto_accept", async () => {
    const old = new Date(now.getTime() - 2 * H).toISOString();
    const { data } = await db.from("orders").select("*").eq("status", "submitted").lte("submitted_at", old);
    let n = 0;
    for (const o of data ?? []) if (await acceptOrder(o, "system")) n++;
    return n;
  });

  return new Response(log.join("\n"));
});
