// Клиент API CRM Big Prodast (https://docs.bigprodast.com/api/) и обратная запись статуса заказа в сделку.
// Импортирует только util.ts, чтобы flows.ts мог звать crmSyncStatus без циклических импортов.
import { esc, notifyAdmins } from "./util.ts";

const CRM_BASE = (Deno.env.get("CRM_BASE_URL") ?? "https://crm.bigprodast.com/api/v1").replace(/\/$/, "");
export const CRM_API_KEY = Deno.env.get("CRM_API_KEY") ?? "";

// Этап, с которого забираем сделки, и этапы, куда двигаем сделку по ходу заказа. Все — id этапов из GET /stages.
export const CRM_STAGE_ID = Deno.env.get("CRM_STAGE_ID") ?? "";
const CRM_STAGE_TAKEN = Deno.env.get("CRM_STAGE_TAKEN") ?? "";
const CRM_STAGE_DONE = Deno.env.get("CRM_STAGE_DONE") ?? "";

export class CrmError extends Error {
  constructor(public status: number, public body: unknown) {
    // deno-lint-ignore no-explicit-any
    const m = (body as any)?.message;
    super(`CRM ${status}: ${Array.isArray(m) ? m.join("; ") : m ?? JSON.stringify(body)}`);
  }
}

// deno-lint-ignore no-explicit-any
export async function crm(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  if (!CRM_API_KEY) throw new Error("CRM_API_KEY не задан");
  const r = await fetch(`${CRM_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${CRM_API_KEY}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) throw new CrmError(r.status, json);
  return json;
}

// Статус заказа → этап сделки. Нет настройки этапа — ничего не делаем.
const STAGE_FOR_STATUS: Record<string, string> = {
  taken: CRM_STAGE_TAKEN,
  accepted: CRM_STAGE_DONE,
  open: CRM_STAGE_TAKEN ? CRM_STAGE_ID : "", // вернулся в ленту — сделку обратно на этап импорта
};

// Вызывается после успешной смены статуса. Ошибка CRM не ломает работу бота: пишем в лог и админу.
// deno-lint-ignore no-explicit-any
export async function crmSyncStatus(order: Record<string, any>, to: string) {
  const stageId = STAGE_FOR_STATUS[to];
  if (!order.crm_deal_id || !stageId || !CRM_API_KEY) return;
  try {
    await crm(`/deals/${order.crm_deal_id}/move`, { method: "PATCH", body: { stageId } });
  } catch (e) {
    console.error("crm move", order.id, to, e);
    const num = order.crm_deal_number ? `#${order.crm_deal_number}` : order.crm_deal_id;
    await notifyAdmins(`⚠️ Не удалось перенести сделку ${esc(num)} в CRM (заказ №${order.id} → ${to}):\n${esc((e as Error).message)}`);
  }
}
