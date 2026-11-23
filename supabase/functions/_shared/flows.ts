// Бизнес-логика, общая для api, bot и cron.
import { ADMIN_IDS, appButton, db, esc, fmtWhen, KASPI_PAY_URL, money, notifyAdmins, send, tg } from "./util.ts";
import { crmSyncStatus } from "./crm_api.ts";

export type Actor = "cleaner" | "client" | "admin" | "system";

// deno-lint-ignore no-explicit-any
export type Order = Record<string, any>;

// Меняет статус, только если заказ всё ещё в одном из ожидаемых статусов. Пишет журнал.
export async function setStatus(
  order: Order,
  allowedFrom: string[],
  to: string,
  actor: Actor,
  patch: Record<string, unknown> = {},
  comment?: string,
): Promise<Order | null> {
  if (!allowedFrom.includes(order.status)) return null;
  const { data, error } = await db.from("orders")
    .update({ status: to, ...patch })
    .eq("id", order.id)
    .eq("status", order.status)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  await db.from("order_events").insert({
    order_id: order.id,
    actor,
    cleaner_id: order.cleaner_id ?? null,
    from_status: order.status,
    to_status: to,
    comment: comment ?? null,
  });
  await crmSyncStatus(data, to);
  return data;
}

export async function logEvent(order: Order, actor: Actor, from: string, to: string, comment?: string) {
  await db.from("order_events").insert({
    order_id: order.id, actor, cleaner_id: order.cleaner_id ?? null, from_status: from, to_status: to, comment: comment ?? null,
  });
}

export const orderLine = (o: Order) =>
  `№${o.id} · ${fmtWhen(o.scheduled_at)} · ${esc(o.district)} · ${o.area_m2} м² · <b>${money(o.payout_cleaner)}</b>`;

// Рассылка нового (или вернувшегося в ленту) заказа активным клинерам подходящего уровня
export async function broadcastOrder(o: Order, title = "Новая уборка") {
  const { data: cleaners } = await db.from("cleaners")
    .select("tg_id, level").eq("status", "active");
  const rank = { new: 0, standard: 1, pro: 2 } as Record<string, number>;
  const targets = (cleaners ?? []).filter((c) => rank[c.level] >= rank[o.min_level]);
  await Promise.all(targets.map((c) =>
    send(c.tg_id, `🧽 <b>${title}</b>\n${orderLine(o)}`, { reply_markup: appButton("Смотреть") })
  ));
  return targets.length;
}

async function clientOf(o: Order) {
  if (!o.client_id) return null;
  const { data } = await db.from("clients").select("*").eq("id", o.client_id).maybeSingle();
  return data;
}

async function cleanerOf(o: Order) {
  if (!o.cleaner_id) return null;
  const { data } = await db.from("cleaners").select("*").eq("id", o.cleaner_id).maybeSingle();
  return data;
}

export async function notifyClientTaken(o: Order) {
  const [client, cleaner] = await Promise.all([clientOf(o), cleanerOf(o)]);
  if (client?.tg_id && cleaner) {
    await send(client.tg_id,
      `Ваша уборка ${fmtWhen(o.scheduled_at)} подтверждена.\nКлинер: <b>${esc(cleaner.name)}</b>, рейтинг ${Number(cleaner.rating).toFixed(1)}`);
  }
}

export async function notifyClientOnWay(o: Order) {
  const client = await clientOf(o);
  if (client?.tg_id) await send(client.tg_id, "Клинер выехал к вам 🚗");
}

// Фото «после» для приёмки: клиенту, а если клиент не подключён к боту — админам
export async function sendForReview(o: Order) {
  const { data: photos } = await db.from("photos")
    .select("storage_path, zone").eq("order_id", o.id).eq("kind", "after").order("created_at");
  const paths = (photos ?? []).map((p) => p.storage_path);
  let urls: string[] = [];
  if (paths.length) {
    const { data } = await db.storage.from("photos").createSignedUrls(paths, 60 * 60 * 24);
    urls = (data ?? []).map((d) => d.signedUrl).filter(Boolean) as string[];
  }
  const client = await clientOf(o);
  const comment = o.cleaner_comment ? `\nКомментарий клинера: ${esc(o.cleaner_comment)}` : "";

  const sendAlbum = async (chatId: number) => {
    for (let i = 0; i < urls.length; i += 10) {
      await tg("sendMediaGroup", {
        chat_id: chatId,
        media: urls.slice(i, i + 10).map((u) => ({ type: "photo", media: u })),
      });
    }
  };

  if (client?.tg_id) {
    await sendAlbum(client.tg_id);
    await send(client.tg_id,
      `Уборка №${o.id} готова ✨${comment}\n\nОцените работу. Если не ответите за 2 часа, мы примем её автоматически.`,
      {
        reply_markup: {
          inline_keyboard: [
            [1, 2, 3, 4, 5].map((n) => ({ text: `${n} ★`, callback_data: `rate:${o.id}:${n}` })),
            [{ text: "Есть замечание", callback_data: `issue:${o.id}` }],
          ],
        },
      });
  } else {
    for (const id of ADMIN_IDS) await sendAlbum(id);
    await notifyAdmins(
      `Заказ сдан, клиент не подключён к боту:\n${orderLine(o)}${comment}\nПримите работу после звонка клиенту.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "Принять", callback_data: `adm_accept:${o.id}` },
            { text: "На переделку", callback_data: `adm_rework:${o.id}` },
          ]],
        },
      },
    );
  }
}

// Приёмка работы: оценка, выплата в очередь, пересчёт рейтинга, уведомления
export async function acceptOrder(o: Order, actor: Actor, rating?: number) {
  const patch: Record<string, unknown> = { accepted_at: new Date().toISOString() };
  if (rating) patch.client_rating = rating;
  const updated = await setStatus(o, ["submitted"], "accepted", actor, patch,
    rating ? `оценка ${rating}` : actor === "system" ? "автоприёмка через 2 часа" : undefined);
  if (!updated) return null;

  await db.from("payouts").upsert(
    { cleaner_id: updated.cleaner_id, order_id: updated.id, amount: updated.payout_cleaner },
    { onConflict: "order_id", ignoreDuplicates: true },
  );
  await db.rpc("recalc_cleaner", { p_cleaner: updated.cleaner_id });

  const [cleaner, client] = await Promise.all([cleanerOf(updated), clientOf(updated)]);
  if (cleaner) {
    await send(cleaner.tg_id,
      `✅ Уборка №${updated.id} принята${rating ? `, оценка ${rating}` : ""}.\nК выплате: <b>${money(updated.payout_cleaner)}</b>`);
  }
  if (client?.tg_id) {
    const pay = KASPI_PAY_URL ? `\n\nОплатить: ${KASPI_PAY_URL}` : "";
    await send(client.tg_id,
      `Спасибо! Работа принята.${pay}\n\nПодарок другу: купон на 5 000 ₸ на первую уборку — просто перешлите это сообщение.`);
  }
  await notifyAdmins(`Принято: ${orderLine(updated)}${rating ? ` · оценка ${rating}` : ""}\nПроверьте оплату клиента и выплатите в /payouts`);
  return updated;
}

export async function sendToRework(o: Order, actor: Actor, comment?: string) {
  const updated = await setStatus(o, ["submitted"], "rework", actor,
    comment ? { client_comment: comment } : {}, comment);
  if (!updated) return null;
  const cleaner = await cleanerOf(updated);
  const text = `⚠️ Замечание по уборке №${updated.id}${comment ? `:\n«${esc(comment)}»` : ""}\nПеределка в течение 24 часов, выплата ждёт её сдачи.`;
  if (cleaner) await send(cleaner.tg_id, text, { reply_markup: appButton("Открыть заказ") });
  await notifyAdmins(`Претензия: ${orderLine(updated)}${comment ? `\n«${esc(comment)}»` : ""}`);
  return updated;
}

// Возврат заказа в ленту: отказ клинера или нет подтверждения. Штраф, если до начала меньше суток.
export async function releaseOrder(o: Order, actor: Actor, reason: string) {
  const hoursLeft = (new Date(o.scheduled_at).getTime() - Date.now()) / 3_600_000;
  const late = hoursLeft < 24;
  const cleanerId = o.cleaner_id;
  const updated = await setStatus(o, ["taken", "confirmed"], "open", actor, {
    cleaner_id: null, taken_at: null, confirmed_at: null, reminded_confirm: false, reminded_2h: false,
  }, reason);
  if (!updated) return null;
  if (late && cleanerId) {
    const { data: c } = await db.from("cleaners").select("penalty").eq("id", cleanerId).maybeSingle();
    await db.from("cleaners").update({ penalty: Number(c?.penalty ?? 0) + 0.2 }).eq("id", cleanerId);
    await db.rpc("recalc_cleaner", { p_cleaner: cleanerId });
  }
  await notifyAdmins(`↩️ Заказ вернулся в ленту (${esc(reason)}):\n${orderLine(updated)}`);
  if (hoursLeft > 0) await broadcastOrder(updated, "Снова свободна уборка");
  return { order: updated, penalized: late };
}
