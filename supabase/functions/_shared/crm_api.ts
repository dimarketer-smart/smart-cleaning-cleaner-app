// Связь с CRM Big Prodast через её MCP-сервер (https://crm.bigprodast.com/api/mcp).
// REST API (/api/v1) доступно только на тарифе «Максимальная», MCP — на любом, с тем же ключом bp_….
// Импортирует только util.ts, чтобы flows.ts мог звать crmSyncStatus без циклических импортов.
import { esc, notifyAdmins } from "./util.ts";

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

// Справочник этапов: название → id. Кэш на время жизни функции.
let stageCache: { at: number; byName: Map<string, string> } | null = null;
export async function stageId(name: string): Promise<string | null> {
  if (!name) return null;
  if (!stageCache || Date.now() - stageCache.at > 10 * 60_000) {
    const dir = await crmTool("crm_directory");
    // deno-lint-ignore no-explicit-any
    const byName = new Map<string, string>((dir.stages ?? []).map((s: any) => [String(s.name).trim().toLowerCase(), s.id]));
    stageCache = { at: Date.now(), byName };
  }
  return stageCache.byName.get(name.toLowerCase()) ?? null;
}

// Статус заказа → этап сделки. Этап не настроен — ничего не делаем.
const STAGE_FOR_STATUS: Record<string, string> = {
  taken: CRM_STAGE_TAKEN,
  accepted: CRM_STAGE_DONE,
  open: CRM_STAGE_TAKEN ? CRM_STAGE : "", // вернулся в ленту — сделку обратно на этап импорта
};

// Вызывается после успешной смены статуса. Ошибка CRM не ломает работу бота: пишем в лог и админу.
// deno-lint-ignore no-explicit-any
export async function crmSyncStatus(order: Record<string, any>, to: string) {
  const stageName = STAGE_FOR_STATUS[to];
  if (!order.crm_deal_id || !stageName || !CRM_API_KEY) return;
  try {
    const id = await stageId(stageName);
    if (!id) throw new CrmError(`в CRM нет этапа «${stageName}»`);
    await crmTool("deal_move", { dealId: order.crm_deal_id, stageId: id });
  } catch (e) {
    console.error("crm move", order.id, to, e);
    const num = order.crm_deal_number ? `#${order.crm_deal_number}` : order.crm_deal_id;
    await notifyAdmins(`⚠️ Не удалось перенести сделку ${esc(num)} в CRM (заказ №${order.id} → ${to}):\n${esc((e as Error).message)}`);
  }
}
