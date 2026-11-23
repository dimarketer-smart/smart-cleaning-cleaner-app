// Telegram-бот: регистрация клинеров, привязка клиентов, админ-команды, чат-посредник, оценка, выплаты.
import {
  appButton, BOT_USERNAME, db, esc, isAdmin, money, notifyAdmins, send, tg, TZ_OFFSET,
} from "../_shared/util.ts";
import { acceptOrder, broadcastOrder, orderLine, releaseOrder, sendToRework, setStatus } from "../_shared/flows.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

const ADMIN_HELP = `<b>Команды администратора</b>
/new — создать заказ. Формат (поля через «|»):
<code>/new 24.11 10:00 | мкр. Строитель | ул. Примерная 1, кв 2, подъезд 1, этаж 3 | 54 | 2 | 18000 | 12000 | Айгерим, +77010000000 | пожелания</code>
дата время | район | адрес | м² | комнат | цена клиенту | выплата клинеру | клиент | пожелания (необязательно)
/orders — заказы на сегодня и завтра
/payouts — к выплате
/activate &lt;tg_id&gt; — активировать клинера
/block &lt;tg_id&gt; — заблокировать клинера`;

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok"); // Telegram всегда получает 200, иначе будет повторять апдейт
});

// deno-lint-ignore no-explicit-any
async function onMessage(m: any) {
  const from = m.from?.id as number;
  if (!from || m.chat?.type !== "private") return;
  const text: string = m.text ?? "";

  // Контакт для регистрации клинера
  if (m.contact) {
    if (m.contact.user_id !== from) return send(from, "Отправьте, пожалуйста, свой контакт кнопкой ниже.");
    return registerCleaner(from, m);
  }

  if (text.startsWith("/start")) return onStart(from, text.split(" ")[1] ?? "", m);

  if (isAdmin(from)) {
    if (text.startsWith("/new")) return adminNew(from, text);
    if (text.startsWith("/payouts")) return adminPayouts(from);
    if (text.startsWith("/orders")) return adminOrders(from);
    if (text.startsWith("/activate")) return adminSetStatus(from, text, "active");
    if (text.startsWith("/block")) return adminSetStatus(from, text, "blocked");
    if (text.startsWith("/help")) return send(from, ADMIN_HELP);
  }

  if (text.startsWith("/done")) {
    await db.from("bot_sessions").delete().eq("tg_id", from);
    return send(from, "Чат закрыт.");
  }

  if (text) return relay(from, text);
}

async function onStart(from: number, payload: string, m: { from?: { first_name?: string } }) {
  // Клиент пришёл по ссылке из заказа: c_<token>
  if (payload.startsWith("c_")) {
    const { data: client } = await db.from("clients").select("id, name").eq("link_token", payload.slice(2)).maybeSingle();
    if (!client) return send(from, "Ссылка устарела. Напишите нам, и мы пришлём новую.");
    await db.from("clients").update({ tg_id: from }).eq("id", client.id);
    return send(from, "Готово! Сюда придут подтверждение уборки, фото результата и кнопки для оценки.");
  }
  if (isAdmin(from)) return send(from, ADMIN_HELP);

  const { data: cleaner } = await db.from("cleaners").select("status").eq("tg_id", from).maybeSingle();
  if (cleaner?.status === "active") {
    return send(from, "Привет! Заказы — в приложении.", { reply_markup: appButton() });
  }
  if (cleaner?.status === "pending") return send(from, "Заявка на рассмотрении. Напишем после пробной уборки.");
  if (cleaner?.status === "blocked") return send(from, "Доступ к заказам закрыт. Вопросы — администратору.");

  return send(from,
    `Здравствуйте${m.from?.first_name ? ", " + esc(m.from.first_name) : ""}! Это бот клинеров Smart Cleaning.\nЧтобы подать заявку, поделитесь номером телефона.`,
    {
      reply_markup: {
        keyboard: [[{ text: "Поделиться контактом", request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
}

// deno-lint-ignore no-explicit-any
async function registerCleaner(from: number, m: any) {
  const { data: existing } = await db.from("cleaners").select("id").eq("tg_id", from).maybeSingle();
  if (existing) return send(from, "Вы уже зарегистрированы.", { reply_markup: { remove_keyboard: true } });
  const name = [m.contact.first_name, m.contact.last_name].filter(Boolean).join(" ") || "Клинер";
  const phone = String(m.contact.phone_number ?? "");
  await db.from("cleaners").insert({ tg_id: from, name, phone });
  await send(from, "Спасибо! Заявка отправлена. Администратор свяжется с вами насчёт пробной уборки.",
    { reply_markup: { remove_keyboard: true } });
  await notifyAdmins(`Новый клинер: <b>${esc(name)}</b>, ${esc(phone)}\nАктивировать: <code>/activate ${from}</code>`);
}

// ── Админ ──────────────────────────────────────────────────
async function adminNew(from: number, text: string) {
  const parts = text.replace(/^\/new\s*/, "").split("|").map((s) => s.trim());
  if (parts.length < 8) return send(from, "Не хватает полей.\n\n" + ADMIN_HELP);
  const [when, district, address, area, rooms, price, payout, clientRaw, notes] = parts;

  const mt = when.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if (!mt) return send(from, "Дата должна быть в виде «24.11 10:00».");
  const pad = (s: string) => s.padStart(2, "0");
  const now = new Date();
  let year = Number(mt[3] ?? now.getFullYear());
  let scheduled = new Date(`${year}-${pad(mt[2])}-${pad(mt[1])}T${pad(mt[4])}:${mt[5]}:00${TZ_OFFSET}`);
  if (!mt[3] && scheduled.getTime() < now.getTime() - 86_400_000) {
    year += 1;
    scheduled = new Date(`${year}-${pad(mt[2])}-${pad(mt[1])}T${pad(mt[4])}:${mt[5]}:00${TZ_OFFSET}`);
  }
  if (isNaN(scheduled.getTime())) return send(from, "Не понял дату.");

  const nums = [area, rooms, price, payout].map((s) => Number(s.replace(/\s/g, "")));
  if (nums.some((n) => !Number.isFinite(n))) return send(from, "м², комнаты, цена и выплата — числа.");

  const phone = (clientRaw.match(/\+?\d[\d\s()-]{8,}/)?.[0] ?? "").replace(/[^\d+]/g, "");
  const clientName = clientRaw.replace(/,?\s*\+?\d[\d\s()-]{8,}/, "").trim() || null;
  let clientId: string | null = null;
  let token = "";
  if (phone) {
    const { data: found } = await db.from("clients").select("id, link_token, tg_id").eq("phone", phone).maybeSingle();
    if (found) { clientId = found.id; token = found.link_token; }
  }
  if (!clientId) {
    const { data: created, error } = await db.from("clients")
      .insert({ name: clientName, phone: phone || null, source: "admin" }).select("id, link_token").single();
    if (error) throw error;
    clientId = created.id; token = created.link_token;
  }

  const { data: order, error } = await db.from("orders").insert({
    client_id: clientId, district, address, area_m2: nums[0], rooms: nums[1],
    price_client: nums[2], payout_cleaner: nums[3], scheduled_at: scheduled.toISOString(), notes: notes || null,
  }).select().single();
  if (error) throw error;

  await db.from("order_events").insert({ order_id: order.id, actor: "admin", to_status: "open", comment: `создан ${from}` });
  const sent = await broadcastOrder(order);
  await send(from,
    `Заказ создан:\n${orderLine(order)}\nРазослан клинерам: ${sent}\n\nСсылка для клиента (отправьте в WhatsApp):\nhttps://t.me/${BOT_USERNAME}?start=c_${token}`);
}

async function adminPayouts(from: number) {
  const { data } = await db.from("payouts")
    .select("id, amount, order_id, cleaners(name, phone, kaspi)").eq("status", "pending").order("created_at");
  if (!data?.length) return send(from, "Выплат в очереди нет.");
  for (const p of data) {
    // deno-lint-ignore no-explicit-any
    const c = (p as any).cleaners;
    await send(from,
      `№${p.order_id} · <b>${money(p.amount)}</b>\n${esc(c?.name)} · Kaspi ${esc(c?.kaspi || c?.phone)}`,
      { reply_markup: { inline_keyboard: [[{ text: "Выплачено", callback_data: `pay:${p.id}` }]] } });
  }
}

async function adminOrders(from: number) {
  const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const { data } = await db.from("orders").select("*, cleaners(name)")
    .lte("scheduled_at", until).not("status", "in", "(paid,cancelled)").order("scheduled_at");
  if (!data?.length) return send(from, "На ближайшие два дня заказов нет.");
  const lines = data.map((o) =>
    // deno-lint-ignore no-explicit-any
    `${orderLine(o)}\n   ${o.status}${(o as any).cleaners?.name ? " · " + esc((o as any).cleaners.name) : ""}`
  );
  return send(from, lines.join("\n\n"));
}

async function adminSetStatus(from: number, text: string, status: "active" | "blocked") {
  const tgId = Number(text.split(/\s+/)[1]);
  if (!tgId) return send(from, "Укажите tg_id клинера.");
  const { data } = await db.from("cleaners").update({ status }).eq("tg_id", tgId).select("name").maybeSingle();
  if (!data) return send(from, "Клинер не найден.");
  await send(from, `${esc(data.name)}: ${status === "active" ? "активирован" : "заблокирован"}.`);
  if (status === "active") await send(tgId, "Вы допущены к заказам! Открывайте приложение.", { reply_markup: appButton() });
  else await send(tgId, "Доступ к заказам закрыт. Вопросы — администратору.");
}

// ── Чат-посредник и замечания ──────────────────────────────
async function relay(from: number, text: string) {
  const { data: session } = await db.from("bot_sessions").select("*").eq("tg_id", from).maybeSingle();

  // Клиент пишет текст замечания после «Есть замечание»
  if (session?.mode === "complaint") {
    await db.from("bot_sessions").delete().eq("tg_id", from);
    const comment = text.slice(0, 500);
    const { data: o } = await db.from("orders").select("id, cleaner_id, cleaners(tg_id)").eq("id", session.order_id).maybeSingle();
    if (o) {
      await db.from("orders").update({ client_comment: comment }).eq("id", o.id);
      await db.from("messages").insert({ order_id: o.id, sender: "client", text: comment });
      // deno-lint-ignore no-explicit-any
      const cleanerTg = (o as any).cleaners?.tg_id;
      if (cleanerTg) await send(cleanerTg, `Замечание клиента по №${o.id}:\n«${esc(comment)}»`, { reply_markup: appButton("Открыть заказ") });
      await notifyAdmins(`Замечание клиента по №${o.id}:\n«${esc(comment)}»`);
    }
    return send(from, "Спасибо, передали клинеру. Исправим в течение 24 часов.");
  }

  const { data: cleaner } = await db.from("cleaners").select("id, name").eq("tg_id", from).maybeSingle();

  // Клинер в режиме чата → клиенту
  if (cleaner && session?.mode === "chat") {
    const { data: o } = await db.from("orders").select("id, client_id, clients(tg_id)").eq("id", session.order_id).maybeSingle();
    if (!o) return;
    await db.from("messages").insert({ order_id: o.id, sender: "cleaner", text });
    // deno-lint-ignore no-explicit-any
    const clientTg = (o as any).clients?.tg_id;
    if (clientTg) await send(clientTg, `Клинер ${esc(cleaner.name)} (заказ №${o.id}):\n${esc(text)}`);
    else await notifyAdmins(`Клиент не в боте. Сообщение клинера по №${o.id}, перешлите в WhatsApp:\n${esc(text)}`);
    return send(from, "Отправлено. Закончить чат: /done");
  }

  // Клиент пишет → клинеру его текущего заказа
  const { data: client } = await db.from("clients").select("id").eq("tg_id", from).maybeSingle();
  if (client) {
    const { data: o } = await db.from("orders").select("id, cleaner_id, cleaners(tg_id)")
      .eq("client_id", client.id).in("status", ["taken", "confirmed", "on_way", "onsite", "submitted", "rework"])
      .order("scheduled_at").limit(1).maybeSingle();
    // deno-lint-ignore no-explicit-any
    const cleanerTg = (o as any)?.cleaners?.tg_id;
    if (o && cleanerTg) {
      await db.from("messages").insert({ order_id: o.id, sender: "client", text });
      await send(cleanerTg, `Клиент (заказ №${o.id}):\n${esc(text)}`);
      return send(from, "Передали клинеру.");
    }
    await notifyAdmins(`Сообщение от клиента:\n${esc(text)}`);
    return send(from, "Спасибо! Ответим в ближайшее время.");
  }

  if (cleaner) return send(from, "Чтобы написать клиенту, нажмите «Написать клиенту» в заказе.", { reply_markup: appButton() });
}

// ── Кнопки ─────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function onCallback(q: any) {
  const from = q.from.id as number;
  const [kind, idRaw, extra] = String(q.data ?? "").split(":");
  const id = Number(idRaw);
  let answer = "";

  const getOrder = async () => (await db.from("orders").select("*").eq("id", id).maybeSingle()).data;
  const clientOwns = async (o: { client_id: string | null }) => {
    if (!o.client_id) return false;
    const { data } = await db.from("clients").select("tg_id").eq("id", o.client_id).maybeSingle();
    return data?.tg_id === from;
  };
  const cleanerOwns = async (o: { cleaner_id: string | null }) => {
    if (!o.cleaner_id) return false;
    const { data } = await db.from("cleaners").select("tg_id").eq("id", o.cleaner_id).maybeSingle();
    return data?.tg_id === from;
  };
  const dropButtons = () =>
    tg("editMessageReplyMarkup", { chat_id: q.message?.chat?.id, message_id: q.message?.message_id, reply_markup: { inline_keyboard: [] } });

  if (kind === "rate" || kind === "issue") {
    const o = await getOrder();
    if (!o || !(await clientOwns(o))) answer = "Заказ не найден";
    else if (o.status !== "submitted") answer = "Оценка уже учтена";
    else if (kind === "rate" && Number(extra) >= 4) {
      await acceptOrder(o, "client", Number(extra));
      answer = "Спасибо за оценку!";
      await dropButtons();
    } else {
      // Оценка 1–3 или «Есть замечание» = претензия: сразу на переделку, детали клиент пишет следующим сообщением
      if (kind === "rate") await db.from("orders").update({ client_rating: Number(extra) }).eq("id", o.id);
      await sendToRework(o, "client", kind === "rate" ? `оценка ${extra}` : "есть замечание");
      await db.from("bot_sessions").upsert({ tg_id: from, mode: "complaint", order_id: o.id, updated_at: new Date().toISOString() });
      await send(from, "Напишите одним сообщением, что не так. Клинер исправит в течение 24 часов.");
      answer = "Опишите замечание";
      await dropButtons();
    }
  } else if (kind === "adm_accept" || kind === "adm_rework") {
    if (!isAdmin(from)) answer = "Нет доступа";
    else {
      const o = await getOrder();
      if (!o || o.status !== "submitted") answer = "Уже обработан";
      else if (kind === "adm_accept") { await acceptOrder(o, "admin"); answer = "Принято"; await dropButtons(); }
      else { await sendToRework(o, "admin", "замечание клиента по телефону"); answer = "Отправлено на переделку"; await dropButtons(); }
    }
  } else if (kind === "confirm" || kind === "cantgo") {
    const o = await getOrder();
    if (!o || !(await cleanerOwns(o))) answer = "Заказ не найден";
    else if (kind === "confirm") {
      const u = await setStatus(o, ["taken"], "confirmed", "cleaner", { confirmed_at: new Date().toISOString() });
      answer = u ? "Подтверждено" : "Уже подтверждён";
      await dropButtons();
    } else {
      const r = await releaseOrder(o, "cleaner", "отказ клинера");
      answer = r ? (r.penalized ? "Заказ снят, рейтинг −0,2" : "Заказ снят") : "Уже нельзя отменить";
      await dropButtons();
    }
  } else if (kind === "pay") {
    if (!isAdmin(from)) answer = "Нет доступа";
    else {
      const { data: p } = await db.from("payouts")
        .update({ status: "paid", paid_at: new Date().toISOString(), paid_by: from })
        .eq("id", id).eq("status", "pending").select("order_id, amount, cleaner_id").maybeSingle();
      if (!p) answer = "Уже выплачено";
      else {
        const { data: o } = await db.from("orders").select("*").eq("id", p.order_id).maybeSingle();
        if (o) await setStatus(o, ["accepted"], "paid", "admin", { paid_at: new Date().toISOString() });
        const { data: c } = await db.from("cleaners").select("tg_id").eq("id", p.cleaner_id).maybeSingle();
        if (c) await send(c.tg_id, `💸 Выплачено ${money(p.amount)} за заказ №${p.order_id}`);
        answer = "Отмечено";
        await dropButtons();
      }
    }
  }

  await tg("answerCallbackQuery", { callback_query_id: q.id, text: answer || undefined });
}
