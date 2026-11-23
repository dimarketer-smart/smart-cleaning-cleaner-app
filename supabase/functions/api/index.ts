// API для Mini App клинера. Каждый запрос: POST { initData, action, ...params }.
// Пользователь определяется только по подписанному initData от Telegram.
import { BOT_USERNAME, db, localParts, verifyInitData } from "../_shared/util.ts";
import {
  logEvent, notifyClientOnWay, notifyClientTaken, type Order, releaseOrder, sendForReview, setStatus,
} from "../_shared/flows.ts";
import { crmSyncStatus } from "../_shared/crm_api.ts";

const CORS = {
  "access-control-allow-origin": Deno.env.get("WEBAPP_ORIGIN") ?? "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

class ApiError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

const FEED_FIELDS = "id, type, district, area_m2, rooms, scheduled_at, payout_cleaner, min_level, notes, status";
const ACTIVE = ["taken", "confirmed", "on_way", "onsite", "rework"];
const ZONE_SLUG: Record<string, string> = { "Кухня": "kitchen", "Санузел": "bathroom", "Комнаты": "rooms", "Прихожая": "hall" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  try {
    const body = await req.json();
    const user = await verifyInitData(body.initData);
    if (!user) throw new ApiError("unauthorized", 401);

    const { data: cleaner } = await db.from("cleaners").select("*").eq("tg_id", user.id).maybeSingle();

    if (body.action === "me") {
      return json({ cleaner: cleaner ?? null, botUsername: BOT_USERNAME });
    }
    if (!cleaner) throw new ApiError("not_registered", 403);
    if (cleaner.status !== "active") throw new ApiError("not_active", 403);

    // Заказ этого клинера или ошибка
    const myOrder = async (id: number): Promise<Order> => {
      const { data } = await db.from("orders").select("*").eq("id", id).eq("cleaner_id", cleaner.id).maybeSingle();
      if (!data) throw new ApiError("not_found", 404);
      return data;
    };
    const must = (o: Order | null) => {
      if (!o) throw new ApiError("wrong_status", 409);
      return o;
    };

    switch (body.action) {
      case "feed": {
        const { data } = await db.from("orders").select(FEED_FIELDS)
          .eq("status", "open").gt("scheduled_at", new Date().toISOString())
          .lte("min_level", cleaner.level)
          .order("scheduled_at");
        return json({ orders: data ?? [] });
      }

      case "order": {
        const id = Number(body.id);
        const { data: o } = await db.from("orders").select("*").eq("id", id).maybeSingle();
        if (!o) throw new ApiError("not_found", 404);
        const mine = o.cleaner_id === cleaner.id;
        if (!mine && o.status !== "open") throw new ApiError("taken_by_other", 409);
        const [{ data: items }, { data: photos }] = await Promise.all([
          db.from("checklist_items").select("id, zone, title, sort, done").eq("order_id", id).order("sort"),
          mine ? db.from("photos").select("zone, kind").eq("order_id", id) : Promise.resolve({ data: [] }),
        ]);
        const safe = mine ? { ...o } : Object.fromEntries(FEED_FIELDS.split(", ").map((k) => [k, o[k]]));
        delete (safe as Order).client_id;
        return json({ order: safe, mine, items: items ?? [], photos: photos ?? [] });
      }

      case "my": {
        const { data } = await db.from("orders").select("*")
          .eq("cleaner_id", cleaner.id).in("status", [...ACTIVE, "submitted"]).order("scheduled_at");
        return json({ orders: (data ?? []).map((o) => ({ ...o, client_id: undefined })) });
      }

      case "take": {
        const { data, error } = await db.rpc("take_order", { p_order: Number(body.id), p_cleaner: cleaner.id });
        if (error) throw error;
        let o = Array.isArray(data) ? data[0] : data;
        if (!o) throw new ApiError("already_taken", 409);
        await logEvent(o, "cleaner", "open", "taken");
        await crmSyncStatus(o, "taken");
        // Отдельное подтверждение не нужно, если до уборки меньше 12 часов
        // или заказ на завтра взят уже после 18:00 (вечернее напоминание он бы и так получил сейчас)
        const nowLocal = localParts(new Date());
        const isTomorrow = localParts(new Date(o.scheduled_at)).date === localParts(new Date(Date.now() + 86_400_000)).date;
        if (new Date(o.scheduled_at).getTime() - Date.now() < 12 * 3_600_000 || (isTomorrow && nowLocal.hour >= 18)) {
          o = (await setStatus(o, ["taken"], "confirmed", "system", { confirmed_at: new Date().toISOString() },
            "меньше 12 часов до начала")) ?? o;
        }
        await notifyClientTaken(o);
        return json({ order: o });
      }

      case "confirm": {
        const o = await myOrder(Number(body.id));
        return json({ order: must(await setStatus(o, ["taken"], "confirmed", "cleaner", { confirmed_at: new Date().toISOString() })) });
      }

      case "on_way": {
        const o = await myOrder(Number(body.id));
        const u = must(await setStatus(o, ["confirmed"], "on_way", "cleaner", { on_way_at: new Date().toISOString() }));
        await notifyClientOnWay(u);
        return json({ order: u });
      }

      case "onsite": {
        const o = await myOrder(Number(body.id));
        const lat = Number.isFinite(body.lat) ? body.lat : null;
        const lng = Number.isFinite(body.lng) ? body.lng : null;
        return json({
          order: must(await setStatus(o, ["confirmed", "on_way"], "onsite", "cleaner",
            { onsite_at: new Date().toISOString(), onsite_lat: lat, onsite_lng: lng },
            lat === null ? "без геолокации" : undefined)),
        });
      }

      case "refuse": {
        const o = await myOrder(Number(body.id));
        const r = await releaseOrder(o, "cleaner", "отказ клинера");
        if (!r) throw new ApiError("wrong_status", 409);
        return json({ ok: true, penalized: r.penalized });
      }

      case "upload_url": {
        const o = await myOrder(Number(body.id));
        const kind = body.kind === "after" ? "after" : "before";
        const okStatus = kind === "before" ? ["onsite"] : ["onsite", "rework"];
        if (!okStatus.includes(o.status)) throw new ApiError("wrong_status", 409);
        const slug = ZONE_SLUG[body.zone];
        if (!slug) throw new ApiError("bad_zone");
        const path = `orders/${o.id}/${kind}/${slug}_${Date.now()}.jpg`;
        const { data, error } = await db.storage.from("photos").createSignedUploadUrl(path);
        if (error) throw error;
        return json({ signedUrl: data.signedUrl, path });
      }

      case "photo_done": {
        const o = await myOrder(Number(body.id));
        const kind = body.kind === "after" ? "after" : "before";
        const path = String(body.path ?? "");
        if (!path.startsWith(`orders/${o.id}/${kind}/`) || !ZONE_SLUG[body.zone]) throw new ApiError("bad_path");
        await db.from("photos").insert({ order_id: o.id, zone: body.zone, kind, storage_path: path });
        return json({ ok: true });
      }

      case "check": {
        const { data: item } = await db.from("checklist_items").select("id, order_id").eq("id", Number(body.itemId)).maybeSingle();
        if (!item) throw new ApiError("not_found", 404);
        const o = await myOrder(item.order_id);
        if (!["onsite", "rework"].includes(o.status)) throw new ApiError("wrong_status", 409);
        const done = !!body.done;
        await db.from("checklist_items").update({ done, done_at: done ? new Date().toISOString() : null }).eq("id", item.id);
        return json({ ok: true });
      }

      case "submit": {
        const o = await myOrder(Number(body.id));
        const [{ data: items }, { data: photos }] = await Promise.all([
          db.from("checklist_items").select("zone, done").eq("order_id", o.id),
          db.from("photos").select("zone, kind").eq("order_id", o.id),
        ]);
        const zones = [...new Set((items ?? []).map((i) => i.zone))];
        if ((items ?? []).some((i) => !i.done)) throw new ApiError("checklist_incomplete", 409);
        const has = (zone: string, kind: string) => (photos ?? []).some((p) => p.zone === zone && p.kind === kind);
        if (zones.some((z) => !has(z, "after"))) throw new ApiError("photos_after_missing", 409);
        if (o.status === "onsite" && zones.some((z) => !has(z, "before"))) throw new ApiError("photos_before_missing", 409);
        const u = must(await setStatus(o, ["onsite", "rework"], "submitted", "cleaner", {
          submitted_at: new Date().toISOString(),
          cleaner_comment: body.comment ? String(body.comment).slice(0, 500) : null,
        }));
        await sendForReview(u);
        return json({ order: u });
      }

      case "chat": {
        const o = await myOrder(Number(body.id));
        await db.from("bot_sessions").upsert({ tg_id: cleaner.tg_id, mode: "chat", order_id: o.id, updated_at: new Date().toISOString() });
        return json({ ok: true, botUsername: BOT_USERNAME });
      }

      case "profile": {
        const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
        const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const [done, refusals, week, pending, history] = await Promise.all([
          db.from("orders").select("id", { count: "exact", head: true }).eq("cleaner_id", cleaner.id).in("status", ["accepted", "paid"]),
          db.from("order_events").select("id", { count: "exact", head: true })
            .eq("cleaner_id", cleaner.id).eq("to_status", "open").in("from_status", ["taken", "confirmed"]).gte("created_at", monthAgo),
          db.from("payouts").select("amount").eq("cleaner_id", cleaner.id).gte("created_at", weekAgo),
          db.from("payouts").select("amount").eq("cleaner_id", cleaner.id).eq("status", "pending"),
          db.from("orders").select("id, district, scheduled_at, payout_cleaner, client_rating, status")
            .eq("cleaner_id", cleaner.id).in("status", ["accepted", "paid"]).order("scheduled_at", { ascending: false }).limit(20),
        ]);
        const sum = (rows: { amount: number }[] | null) => (rows ?? []).reduce((s, r) => s + r.amount, 0);
        return json({
          cleaner,
          stats: {
            done: done.count ?? 0,
            refusals30d: refusals.count ?? 0,
            earnedWeek: sum(week.data),
            toPay: sum(pending.data),
          },
          history: history.data ?? [],
        });
      }

      default:
        throw new ApiError("unknown_action");
    }
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.code }, e.status);
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
