// Связь с CRM Big Prodast через её MCP-сервер (https://crm.bigprodast.com/api/mcp).
// REST API (/api/v1) доступно только на тарифе «Максимальная», MCP — на любом, с тем же ключом bp_….
// Импортирует только util.ts, чтобы flows.ts мог звать crmSyncStatus без циклических импортов.
import { db, esc, notifyAdmins } from "./util.ts";

const CRM_MCP_URL = Deno.env.get("CRM_MCP_URL") ?? "https://crm.bigprodast.com/api/mcp";
export const CRM_API_KEY = Deno.env.get("CRM_API_KEY") ?? "";

// Этапы задаются названиями, как в CRM (регистр не важен).
export const CRM_STAGE = (Deno.env.get("CRM_STAGE") ?? "").trim();             // отсюда забираем сделки
const CRM_STAGE_TAKEN = (Deno.env.get("CRM_STAGE_TAKEN") ?? "").trim();       // клинер взял заказ
const CRM_STAGE_DONE = (Deno.env.get("CRM_STAGE_DONE") ?? "").trim();         // работа принята

export class CrmError extends Error {}

let rpcId = 0;

// Вызов инструмента MCP. Ответ инструмента — JSON в текстовом блоке.
// deno-lint-ignore no-explicit-any
export async function crmTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  if (!CRM_API_KEY) throw new CrmError("CRM_API_KEY не задан");
  const r = await fetch(CRM_MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CRM_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "smart-cleaning/1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await r.text();
  if (!r.ok) throw new CrmError(`CRM ${r.status}: ${raw.slice(0, 300)}`);
  // Ответ может прийти как JSON или как SSE (строки «data: {...}»)
  const payload = raw.trimStart().startsWith("{") ? raw : (raw.match(/^data: (.*)$/m)?.[1] ?? "");
  // deno-lint-ignore no-explicit-any
  let msg: any;
  try { msg = JSON.parse(payload); } catch { throw new CrmError(`CRM: непонятный ответ ${raw.slice(0, 200)}`); }
  if (msg.error) throw new CrmError(`CRM ${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  // deno-lint-ignore no-explicit-any
  const text = (msg.result?.content ?? []).map((c: any) => c.text ?? "").join("");
  if (msg.result?.isError) throw new CrmError(`CRM ${name}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Этап в секрете — id (рекомендуется) или название. id надёжнее: среда Edge Functions
// портит кириллицу в секретах (символ на границе 16 байт превращается в «��»).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Справочник этапов: id ↔ название. Кэш на 10 минут.
let stageCache: { at: number; byName: Map<string, string>; byId: Map<string, string> } | null = null;
async function stages() {
  if (!stageCache || Date.now() - stageCache.at > 10 * 60_000) {
    const dir = await crmTool("crm_directory");
    // deno-lint-ignore no-explicit-any
    const list = (dir.stages ?? []) as any[];
    stageCache = {
      at: Date.now(),
      byName: new Map(list.map((s) => [String(s.name).trim().toLowerCase(), s.id])),
      byId: new Map(list.map((s) => [s.id, String(s.name).trim()])),
    };
  }
  return stageCache;
}

export async function stageId(idOrName: string): Promise<string | null> {
  if (!idOrName) return null;
  const s = await stages();
  if (UUID.test(idOrName)) return s.byId.has(idOrName) ? idOrName : null;
  return s.byName.get(idOrName.toLowerCase()) ?? null;
}

export async function stageName(idOrName: string): Promise<string | null> {
  if (!idOrName) return null;
  if (!UUID.test(idOrName)) return idOrName;
  return (await stages()).byId.get(idOrName) ?? null;
}

// Статус заказа → этап сделки. Этап не настроен — ничего не делаем.
const STAGE_FOR_STATUS: Record<string, string> = {
  taken: CRM_STAGE_TAKEN,
  accepted: CRM_STAGE_DONE,
  open: CRM_STAGE_TAKEN ? CRM_STAGE : "", // вернулся в ленту — сделку обратно на этап импорта
};

// Вызывается после успешной смены статуса. Ошибка CRM не ломает работу бота:
// пишем её в crm_sync_errors (cron повторит перенос) и один раз сообщаем админу.
// deno-lint-ignore no-explicit-any
export async function crmSyncStatus(order: Record<string, any>, to: string): Promise<boolean> {
  const stage = STAGE_FOR_STATUS[to];
  if (!order.crm_deal_id || !stage || !CRM_API_KEY) return true;
  try {
    const id = await stageId(stage);
    if (!id) throw new CrmError(`в CRM нет этапа «${stage}» (секрет для статуса ${to})`);
    await crmTool("deal_move", { dealId: order.crm_deal_id, stageId: id });
    await db.from("crm_sync_errors").delete().eq("order_id", order.id);
    return true;
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.error("crm move", order.id, to, message);
    const { data: prev } = await db.from("crm_sync_errors").select("attempts, to_status").eq("order_id", order.id).maybeSingle();
    const first = !prev || prev.to_status !== to;
    await db.from("crm_sync_errors").upsert({
      order_id: order.id, to_status: to, error: message.slice(0, 1000),
      attempts: first ? 1 : (prev?.attempts ?? 0) + 1, updated_at: new Date().toISOString(),
    });
    if (first) {
      const num = order.crm_deal_number ? `#${order.crm_deal_number}` : order.crm_deal_id;
      await notifyAdmins(`⚠️ Не удалось перенести сделку ${esc(num)} в CRM (заказ №${order.id} → ${to}):\n${esc(message)}\nПопробую ещё раз через 10 минут.`);
    }
    return false;
  }
}

// Повтор неудачных переносов (из cron). Двигаем сделку по ТЕКУЩЕМУ статусу заказа.
export async function retryCrmSync(): Promise<number> {
  const { data, error } = await db.from("crm_sync_errors").select("order_id").lt("attempts", 30).limit(20);
  if (error) throw error;
  let ok = 0;
  for (const row of data ?? []) {
    const { data: order } = await db.from("orders").select("*").eq("id", row.order_id).maybeSingle();
    if (!order || !STAGE_FOR_STATUS[order.status]) {
      await db.from("crm_sync_errors").delete().eq("order_id", row.order_id);
      continue;
    }
    if (await crmSyncStatus(order, order.status)) ok++;
  }
  return ok;
}
