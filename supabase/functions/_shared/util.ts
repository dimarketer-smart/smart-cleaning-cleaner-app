// Общие помощники: база, Telegram, форматирование, проверка initData.
import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
export const BOT_USERNAME = Deno.env.get("BOT_USERNAME") ?? "";
export const WEBAPP_URL = Deno.env.get("WEBAPP_URL") ?? "";
export const KASPI_PAY_URL = Deno.env.get("KASPI_PAY_URL") ?? "";
export const ADMIN_IDS: number[] = (Deno.env.get("ADMIN_TG_IDS") ?? "")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

export const TZ = "Asia/Oral";
export const TZ_OFFSET = "+05:00";

// ── Telegram ───────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.error("telegram", method, JSON.stringify(j));
  return j;
}

export function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

export function notifyAdmins(text: string, extra: Record<string, unknown> = {}) {
  return Promise.all(ADMIN_IDS.map((id) => send(id, text, extra)));
}

export const isAdmin = (tgId: number) => ADMIN_IDS.includes(tgId);

export const appButton = (text = "Открыть приложение") => ({
  inline_keyboard: [[{ text, web_app: { url: WEBAPP_URL } }]],
});

// ── Форматирование ─────────────────────────────────────────
export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const money = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";

export function fmtWhen(iso: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

// Дата в часовом поясе Уральска как YYYY-MM-DD и текущий час
export function localParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// ── initData от Telegram Mini App ──────────────────────────
async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
const hex = (b: Uint8Array<ArrayBuffer>) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

// Возвращает пользователя, если подпись верна и данным меньше суток; иначе null.
export async function verifyInitData(initData: string): Promise<TgUser | null> {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dataCheck = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT_TOKEN);
  const sig = hex(await hmac(secret, dataCheck));
  if (sig !== hash) return null;
  const authDate = Number(p.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    return JSON.parse(p.get("user") ?? "null");
  } catch {
    return null;
  }
}
