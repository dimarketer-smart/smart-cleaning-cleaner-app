// Mini App клинера Smart Cleaning. Без сборки и зависимостей: открывается с GitHub Pages.
(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  const API_URL = (window.SC_CONFIG && window.SC_CONFIG.API_URL) || "";
  const app = document.getElementById("app");
  const camera = document.getElementById("camera");

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#111111"); tg.setBackgroundColor("#F5F5F3"); } catch (_) { /* старые клиенты */ }
  }

  // ── Состояние ───────────────────────────────────────────
  const S = {
    screen: "loading", // loading | gate | feed | order | photos | work | submitted | my | profile
    tab: "feed",
    me: null,
    botUsername: "",
    filter: "all",
    feed: [],
    my: [],
    profile: null,
    orderId: null,
    order: null, // { order, mine, items, photos }
    busy: false,
    gate: "",
    comment: "",
  };

  const ERR = {
    unauthorized: "Откройте приложение из бота Smart Cleaning.",
    not_registered: "Сначала зарегистрируйтесь в боте.",
    not_active: "Ваш аккаунт ещё не активирован.",
    already_taken: "Этот заказ уже взяли.",
    taken_by_other: "Этот заказ уже взяли.",
    wrong_status: "Действие недоступно: статус заказа изменился.",
    checklist_incomplete: "Отметьте все пункты чек-листа.",
    photos_after_missing: "Добавьте фото «после» по всем зонам.",
    photos_before_missing: "Не хватает фото «до».",
    not_found: "Заказ не найден.",
    network: "Нет связи. Проверьте интернет и повторите.",
    server: "Ошибка сервера. Попробуйте ещё раз.",
  };

  // ── Утилиты ─────────────────────────────────────────────
  const h = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
  const TZ = "Asia/Oral";
  const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  function when(iso) {
    const d = new Date(iso);
    const time = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);
    const today = dayKey(new Date());
    const tomorrow = dayKey(new Date(Date.now() + 86400000));
    if (dayKey(d) === today) return "Сегодня, " + time;
    if (dayKey(d) === tomorrow) return "Завтра, " + time;
    return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "short" }).format(d) + ", " + time;
  }
  const dayOf = (iso) => {
    const k = dayKey(new Date(iso));
    if (k === dayKey(new Date())) return "today";
    if (k === dayKey(new Date(Date.now() + 86400000))) return "tomorrow";
    return "later";
  };
  const typeName = (t) => (t === "wet" ? "Влажная уборка" : "Уборка");
  const roomsText = (r) => (r ? r + "-комн." : "");

  let toastTimer = null;
  function toast(text) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  async function api(action, params) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ initData: tg ? tg.initData : "", action }, params || {})),
      });
    } catch (_) {
      throw new Error("network");
    }
    const data = await res.json().catch(() => ({ error: "server" }));
    if (!res.ok || data.error) throw new Error(data.error || "server");
    return data;
  }

  const haptic = (type) => { try { tg && tg.HapticFeedback.notificationOccurred(type); } catch (_) { /* нет */ } };

  async function run(fn) {
    if (S.busy) return;
    S.busy = true;
    app.classList.add("spin");
    try {
      await fn();
    } catch (e) {
      haptic("error");
      toast(ERR[e.message] || ERR.server);
      if (e.message === "not_active" || e.message === "not_registered") await boot();
    } finally {
      S.busy = false;
      app.classList.remove("spin");
    }
  }

  const confirmDlg = (text) => new Promise((resolve) => {
    if (tg && tg.showConfirm) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });

  // ── Иконки ──────────────────────────────────────────────
  const I = {
    pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5C5C5C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    area: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5C5C5C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/></svg>',
    back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    cam: (c) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="' + (c || "#111111") + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    check: (c) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="' + (c || "#111111") + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    home: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
    tabFeed: (on) => '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="' + (on ? "#111111" : "#5C5C5C") + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
    tabMy: (on) => '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="' + (on ? "#111111" : "#5C5C5C") + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5h10M9 12h10M9 19h10"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/></svg>',
    tabMe: (on) => '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="' + (on ? "#111111" : "#5C5C5C") + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  };

  // ── Общие куски разметки ────────────────────────────────
  const tabs = () => `
    <nav class="tabs" aria-label="Разделы">
      <button class="tab ${S.tab === "feed" ? "on" : ""}" data-act="tab" data-v="feed">${I.tabFeed(S.tab === "feed")}Заказы</button>
      <button class="tab ${S.tab === "my" ? "on" : ""}" data-act="tab" data-v="my">${I.tabMy(S.tab === "my")}Мои</button>
      <button class="tab ${S.tab === "profile" ? "on" : ""}" data-act="tab" data-v="profile">${I.tabMe(S.tab === "profile")}Профиль</button>
    </nav>`;

  const backBtn = (label) => `<button class="back" data-act="back" aria-label="${h(label || "Назад")}">${I.back}</button>`;

  const orderCard = (o) => `
    <button class="card order-card" data-act="open" data-id="${o.id}">
      <div class="row">
        <div class="kv"><span class="when">${h(when(o.scheduled_at))}</span>
          <span class="title">${h(typeName(o.type))} · ${h(roomsText(o.rooms))} ${o.area_m2} м²</span></div>
        <span class="pay">${money(o.payout_cleaner)}</span>
      </div>
      <div class="meta"><span>${I.pin}${h(o.district)}</span>${o.status && o.status !== "open" ? `<span>${h(statusName(o.status))}</span>` : ""}</div>
    </button>`;

  const STATUS = {
    open: "В ленте", taken: "Взят", confirmed: "Подтверждён", on_way: "В пути", onsite: "На объекте",
    submitted: "Ждёт приёмки", rework: "Переделка", accepted: "Принят", paid: "Выплачен", cancelled: "Отменён",
  };
  const statusName = (s) => STATUS[s] || s;

  // ── Экраны ──────────────────────────────────────────────
  function vGate() {
    return `<div class="center"><div style="display:flex;flex-direction:column;gap:12px;align-items:center">
      <div class="brand-mark" style="width:56px;height:56px;border-radius:16px">${I.home}</div>
      <p class="text" style="text-align:center">${h(S.gate)}</p></div></div>`;
  }

  function vFeed() {
    const list = S.filter === "all" ? S.feed : S.feed.filter((o) => dayOf(o.scheduled_at) === S.filter);
    const chip = (id, label) => `<button class="chip ${S.filter === id ? "on" : ""}" data-act="filter" data-v="${id}">${label}</button>`;
    const n = list.length;
    return `
      <header class="head">
        <div class="brand"><span class="brand-name"><span class="brand-mark">${I.home}</span>Smart Cleaning</span>
          <span style="font-size:13px;color:var(--yellow);font-weight:600">★ ${S.me ? Number(S.me.rating).toFixed(1).replace(".", ",") : ""}</span></div>
        <div class="kv"><h1>Заказы</h1><span class="sub">${n ? n + " доступно" : "Пока пусто"} · Уральск</span></div>
        <div class="chips">${chip("all", "Все")}${chip("today", "Сегодня")}${chip("tomorrow", "Завтра")}</div>
      </header>
      <main class="main">
        ${n ? list.map(orderCard).join("") : `<div class="empty">Свободных заказов нет.<br>Мы пришлём уведомление, когда появится новый.</div>`}
        <p class="muted" style="text-align:center;font-size:13px;margin:4px 0 0">Адрес клиента откроется после того, как возьмёте заказ</p>
      </main>${tabs()}`;
  }

  function zonesOf(items) {
    const z = [];
    items.forEach((i) => { if (!z.includes(i.zone)) z.push(i.zone); });
    return z;
  }
  const hasPhoto = (zone, kind) => S.order.photos.some((p) => p.zone === zone && p.kind === kind);

  function vOrder() {
    const { order: o, mine, items } = S.order;
    const zones = zonesOf(items);
    const zoneCounts = zones.map((z) => `<div class="row" style="font-size:15px;padding-bottom:10px;border-bottom:1px solid #EFEFEC">
        <span style="font-weight:600">${h(z)}</span><span class="muted">${items.filter((i) => i.zone === z).length} пункт.</span></div>`).join("");

    const head = `
      <header class="head">${backBtn()}
        <span class="sub" style="font-weight:600">${h(typeName(o.type))} · заказ №${o.id}${mine ? " · " + h(statusName(o.status)) : ""}</span>
        <div style="display:flex;align-items:baseline;gap:10px"><span class="big">${money(o.payout_cleaner)}</span><span class="sub">вы получите</span></div>
      </header>`;

    const facts = `
      <section class="card grid2">
        <div class="kv"><span class="k">Когда</span><span class="v">${h(when(o.scheduled_at))}</span></div>
        <div class="kv"><span class="k">Район</span><span class="v">${h(o.district)}</span></div>
        <div class="kv"><span class="k">Площадь</span><span class="v">${o.area_m2} м²${o.rooms ? ", " + o.rooms + " комн." : ""}</span></div>
        <div class="kv"><span class="k">Уровень</span><span class="v">${h(o.min_level === "new" ? "любой" : o.min_level)}</span></div>
      </section>`;

    const notes = o.notes ? `<section class="card"><h2>Пожелания клиента</h2><p class="text">${h(o.notes)}</p></section>` : "";

    if (!mine) {
      return `${head}<main class="main">${facts}
        <div class="note yellow">${I.lock}Точный адрес откроется после принятия заказа</div>
        <section class="card"><h2>Что нужно сделать</h2>${zoneCounts}</section>${notes}
      </main>
      <footer class="footer"><span class="hint">Отказ меньше чем за 24 часа снижает рейтинг</span>
        <button class="btn" data-act="take">Беру заказ</button></footer>`;
    }

    // Мой заказ
    const order = ["taken", "confirmed", "on_way", "onsite"];
    const idx = order.indexOf(o.status);
    const steps = idx >= 0 ? `<ol class="steps">${["Взят", "Подтверждён", "В пути", "На месте"].map((l, i) =>
      `<li class="${i <= idx ? "done" : ""} ${i === idx ? "cur" : ""}"><i></i>${l}</li>`).join("")}</ol>` : "";

    const mapUrl = "https://2gis.kz/search/" + encodeURIComponent("Уральск " + (o.address || ""));
    const address = `<div class="address"><span class="k" style="font-size:12px;color:var(--muted);font-weight:600">Адрес</span>
      <span style="font-size:15px;font-weight:700;line-height:1.4">${h(o.address)}</span>
      <a class="btn ghost small" href="${h(mapUrl)}" data-act="link">${I.pin}Открыть в 2ГИС</a></div>`;

    let primary = "";
    let hint = "";
    if (o.status === "taken") { primary = `<button class="btn" data-act="confirm">Подтвердить заказ</button>`; hint = `<div class="note warn">Подтвердите заказ до 21:00 накануне, иначе он вернётся в ленту</div>`; }
    if (o.status === "confirmed") primary = `<button class="btn" data-act="on_way">Выехал</button>`;
    if (o.status === "on_way") primary = `<button class="btn" data-act="onsite">Я на месте</button>`;
    if (o.status === "onsite") {
      const beforeDone = zones.every((z) => hasPhoto(z, "before"));
      primary = beforeDone ? `<button class="btn" data-act="go" data-v="work">Открыть чек-лист</button>`
        : `<button class="btn" data-act="go" data-v="photos">Сделать фото «до»</button>`;
    }
    if (o.status === "rework") {
      hint = `<div class="note warn">Замечание клиента${o.client_comment ? ": «" + h(o.client_comment) + "»" : ""}. Переделка в течение 24 часов.</div>`;
      primary = `<button class="btn" data-act="go" data-v="work">Открыть чек-лист</button>`;
    }
    if (o.status === "submitted") hint = `<div class="note yellow">Работа сдана, ждём оценку клиента. К выплате ${money(o.payout_cleaner)} после приёмки.</div>`;

    const canRefuse = ["taken", "confirmed"].includes(o.status);
    const canChat = ["taken", "confirmed", "on_way", "onsite", "rework", "submitted"].includes(o.status);

    return `${head}<main class="main">
      <section class="card">${steps}${address}${hint}
        <div class="btns2">
          ${canChat ? `<button class="btn ghost" data-act="chat">Написать клиенту</button>` : ""}
          ${canRefuse ? `<button class="btn ghost danger" data-act="refuse">Отказаться</button>` : ""}
        </div>
      </section>
      ${facts}${notes}
      <section class="card"><h2>Чек-лист</h2>${zoneCounts}</section>
    </main>${primary ? `<footer class="footer">${primary}</footer>` : ""}`;
  }

  function vPhotos() {
    const { order: o, items } = S.order;
    const zones = zonesOf(items);
    const done = zones.filter((z) => hasPhoto(z, "before")).length;
    const geo = o.onsite_lat ? `Вы на месте · геолокация отмечена` : `Вы на месте · без геолокации`;
    return `
      <header class="head">${backBtn()}<h1>Фото «до»</h1><span class="sub">Минимум одно фото на каждую зону до начала уборки</span></header>
      <main class="main">
        <div class="note ok">${I.check("#1F5F33")}${geo}</div>
        <div class="row"><b>Зоны</b><b style="color:#3D3D3D">${done} из ${zones.length}</b></div>
        <div class="zones">${zones.map((z) => {
          const ok = hasPhoto(z, "before");
          return `<button class="zone ${ok ? "done" : ""}" data-act="shoot" data-zone="${h(z)}" data-kind="before" aria-label="${h(z)}: ${ok ? "добавить ещё фото" : "сделать фото"}">
            <span class="ico">${ok ? I.check("#FFD21F") : I.cam()}</span><b>${h(z)}</b><small>${ok ? "Фото добавлено · ещё" : "Нажмите, чтобы снять"}</small></button>`;
        }).join("")}</div>
      </main>
      <footer class="footer">${done === zones.length
        ? `<button class="btn" data-act="go" data-v="work">Начать уборку</button>`
        : `<button class="btn" disabled>Сделайте фото всех зон</button>`}</footer>`;
  }

  function vWork() {
    const { order: o, items } = S.order;
    const zones = zonesOf(items);
    const total = items.length;
    const checked = items.filter((i) => i.done).length;
    const photosOk = zones.filter((z) => hasPhoto(z, "after")).length;
    const ready = checked === total && photosOk === zones.length;
    const blocked = checked < total ? `Осталось пунктов: ${total - checked}` : "Добавьте фото «после» по всем зонам";
    return `
      <header class="head">${backBtn()}
        <div class="row" style="align-items:baseline"><h1>Чек-лист</h1><b style="color:var(--yellow)">${checked} из ${total}</b></div>
        <div class="progress"><i style="width:${Math.round((checked / Math.max(total, 1)) * 100)}%"></i></div>
        <span class="sub">№${o.id} · ${o.area_m2} м² · отметьте пункты и сделайте фото «после»</span>
      </header>
      <main class="main">
        ${o.status === "rework" ? `<div class="note warn">Переделка${o.client_comment ? ": «" + h(o.client_comment) + "»" : ""}</div>` : ""}
        ${zones.map((z) => {
          const zi = items.filter((i) => i.zone === z);
          const ok = hasPhoto(z, "after");
          return `<section class="card" style="gap:4px">
            <div class="row" style="padding-bottom:6px"><h2>${h(z)}</h2><span class="muted" style="font-size:13px;font-weight:600">${zi.filter((i) => i.done).length} / ${zi.length}</span></div>
            ${zi.map((i) => `<label class="check ${i.done ? "done" : ""}"><input type="checkbox" data-act="check" data-id="${i.id}" ${i.done ? "checked" : ""}><span>${h(i.title)}</span></label>`).join("")}
            <button class="photo-btn ${ok ? "done" : ""}" data-act="shoot" data-zone="${h(z)}" data-kind="after">${I.cam()}${ok ? "Фото «после» добавлено · ещё" : "Сделать фото «после»"}</button>
          </section>`;
        }).join("")}
        <section class="card"><label for="comment" style="font-weight:800">Комментарий для клиента</label>
          <textarea id="comment" data-act="comment" placeholder="Например: пятно на диване не вывелось">${h(S.comment)}</textarea></section>
      </main>
      <footer class="footer">${ready ? `<button class="btn" data-act="submit">Сдать объект</button>` : `<button class="btn" disabled>${h(blocked)}</button>`}</footer>`;
  }

  function vSubmitted() {
    const o = S.order.order;
    return `
      <header class="head" style="align-items:center;text-align:center;padding:48px 24px 32px">
        <div class="brand-mark" style="width:72px;height:72px;border-radius:999px">${I.check()}</div>
        <h1>Объект сдан</h1>
        <p class="sub" style="margin:0;line-height:1.5">Клиент получил фото и оценивает работу. Если не ответит за 2 часа, работа будет принята автоматически.</p>
      </header>
      <main class="main">
        <section class="card row" style="align-items:center"><div class="kv"><span class="k">К выплате</span><span style="font-size:28px;font-weight:800">${money(o.payout_cleaner)}</span></div>
          <span class="muted" style="font-size:13px;text-align:right;max-width:150px">после оплаты клиентом, обычно в течение часа</span></section>
        <div class="note warn">Если у клиента будет замечание, оно придёт в бот. Переделка — в течение 24 часов, выплата ждёт её сдачи.</div>
      </main>
      <footer class="footer"><div class="btns2"><button class="btn" data-act="tab" data-v="feed">К заказам</button>
        <button class="btn ghost" data-act="tab" data-v="profile">Мой заработок</button></div></footer>`;
  }

  function vMy() {
    const upcoming = S.my.filter((o) => o.status !== "submitted");
    const review = S.my.filter((o) => o.status === "submitted");
    return `
      <header class="head"><h1>Мои заказы</h1>
        <div class="chips"><span class="chip on">Предстоящие · ${upcoming.length}</span><span class="chip">На проверке · ${review.length}</span></div></header>
      <main class="main">
        ${S.my.length ? upcoming.concat(review).map(orderCard).join("") : `<div class="empty">Взятых заказов пока нет.</div>`}
      </main>${tabs()}`;
  }

  function vProfile() {
    const p = S.profile;
    if (!p) return `<div class="center muted">Загрузка…</div>${tabs()}`;
    const c = p.cleaner;
    const lvl = { new: "New", standard: "Standard", pro: "Pro" }[c.level] || c.level;
    return `
      <header class="head">
        <div style="display:flex;align-items:center;gap:14px">
          <div class="brand-mark" style="width:56px;height:56px;border-radius:999px;font-size:22px;font-weight:800;color:#111">${h((c.name || "?").slice(0, 1))}</div>
          <div class="kv"><span style="font-size:20px;font-weight:800">${h(c.name)}</span>
            <span style="align-self:flex-start;padding:3px 10px;border-radius:999px;border:1px solid var(--yellow);color:var(--yellow);font-size:12px;font-weight:700">Уровень ${h(lvl)}</span></div>
        </div>
        <div style="display:flex;align-items:baseline;gap:8px"><span class="big">${Number(c.rating).toFixed(1).replace(".", ",")}</span><span class="sub">рейтинг по последним 20 уборкам</span></div>
      </header>
      <main class="main">
        <section class="grid2" style="gap:10px">
          <div class="stat"><span class="k">К выплате</span><span class="v">${money(p.stats.toPay)}</span></div>
          <div class="stat"><span class="k">За неделю</span><span class="v">${money(p.stats.earnedWeek)}</span></div>
          <div class="stat"><span class="k">Уборок всего</span><span class="v">${p.stats.done}</span></div>
          <div class="stat"><span class="k">Отказов за 30 дней</span><span class="v">${p.stats.refusals30d}</span></div>
        </section>
        <section class="card" style="gap:0;padding:4px 16px"><h2 style="padding:12px 0 4px">История</h2>
          ${p.history.length ? p.history.map((o) => `<div class="hist">
            <div class="kv"><span style="font-size:15px;font-weight:700">${h(when(o.scheduled_at))}</span>
              <span class="muted" style="font-size:13px">${h(o.district)} · оценка ${o.client_rating || "—"}</span></div>
            <div class="kv" style="align-items:flex-end"><b>${money(o.payout_cleaner)}</b>
              <span class="badge ${o.status === "paid" ? "paid" : "wait"}">${o.status === "paid" ? "Выплачено" : "К выплате"}</span></div></div>`).join("")
          : `<div class="empty" style="padding:16px">Здесь появятся выполненные уборки</div>`}
        </section>
      </main>${tabs()}`;
  }

  // ── Отрисовка и навигация ───────────────────────────────
  const V = { gate: vGate, feed: vFeed, order: vOrder, photos: vPhotos, work: vWork, submitted: vSubmitted, my: vMy, profile: vProfile };

  function render() {
    const fn = V[S.screen];
    app.innerHTML = fn ? fn() : `<div class="center muted">Загрузка…</div>`;
    const sub = ["order", "photos", "work"].includes(S.screen);
    if (tg && tg.BackButton) { sub ? tg.BackButton.show() : tg.BackButton.hide(); }
  }

  async function loadTab(tab) {
    S.tab = tab;
    if (tab === "feed") S.feed = (await api("feed")).orders;
    if (tab === "my") S.my = (await api("my")).orders;
    if (tab === "profile") S.profile = await api("profile");
    S.screen = tab;
    render();
    window.scrollTo(0, 0);
  }

  async function loadOrder(id, screen) {
    S.orderId = id;
    S.order = await api("order", { id });
    S.screen = screen || "order";
    render();
  }

  function back() {
    if (S.screen === "photos" || S.screen === "work") return run(() => loadOrder(S.orderId, "order"));
    return run(() => loadTab(S.tab));
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(back);

  // ── Геолокация и фото ───────────────────────────────────
  function getLocation() {
    return new Promise((resolve) => {
      const fallback = () => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 10000 },
        );
      };
      const lm = tg && tg.LocationManager;
      if (!lm || !lm.init) return fallback();
      lm.init(() => {
        if (!lm.isLocationAvailable) return fallback();
        lm.getLocation((loc) => (loc ? resolve({ lat: loc.latitude, lng: loc.longitude }) : fallback()));
      });
    });
  }

  async function compress(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
      return blob || file;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  let pendingShot = null;
  camera.addEventListener("change", () => {
    const file = camera.files && camera.files[0];
    camera.value = "";
    if (!file || !pendingShot) return;
    const shot = pendingShot;
    pendingShot = null;
    run(async () => {
      toast("Загружаем фото…");
      const blob = await compress(file);
      const { signedUrl, path } = await api("upload_url", { id: S.orderId, zone: shot.zone, kind: shot.kind });
      let put;
      try {
        put = await fetch(signedUrl, { method: "PUT", headers: { "content-type": "image/jpeg", "x-upsert": "false" }, body: blob });
      } catch (_) { throw new Error("network"); }
      if (!put.ok) throw new Error("server");
      await api("photo_done", { id: S.orderId, zone: shot.zone, kind: shot.kind, path });
      S.order.photos.push({ zone: shot.zone, kind: shot.kind });
      haptic("success");
      toast("Фото добавлено");
      render();
    });
  });

  // ── Действия ────────────────────────────────────────────
  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.dataset.act === "check" || el.dataset.act === "comment") return;
    const act = el.dataset.act;
    const o = S.order && S.order.order;

    if (act === "link") {
      e.preventDefault();
      if (tg && tg.openLink) tg.openLink(el.href); else window.open(el.href, "_blank");
      return;
    }
    if (act === "back") return back();
    if (act === "tab") return run(() => loadTab(el.dataset.v));
    if (act === "filter") { S.filter = el.dataset.v; return render(); }
    if (act === "open") return run(() => loadOrder(Number(el.dataset.id), "order"));
    if (act === "go") { S.screen = el.dataset.v; render(); window.scrollTo(0, 0); return; }

    if (act === "take") return run(async () => {
      await api("take", { id: o.id });
      haptic("success");
      toast("Заказ ваш! Адрес открыт.");
      await loadOrder(o.id, "order");
    });
    if (act === "confirm" || act === "on_way") return run(async () => {
      await api(act, { id: o.id });
      haptic("success");
      await loadOrder(o.id, "order");
    });
    if (act === "onsite") return run(async () => {
      toast("Отмечаем геолокацию…");
      const loc = await getLocation();
      await api("onsite", { id: o.id, lat: loc && loc.lat, lng: loc && loc.lng });
      if (!loc) toast("Геолокация недоступна — отметили без неё");
      await loadOrder(o.id, "photos");
    });
    if (act === "refuse") return run(async () => {
      const late = new Date(o.scheduled_at).getTime() - Date.now() < 86400000;
      const ok = await confirmDlg(late ? "До уборки меньше суток. Отказ снизит рейтинг на 0,2. Отказаться?" : "Отказаться от заказа?");
      if (!ok) return;
      await api("refuse", { id: o.id });
      toast("Вы отказались от заказа");
      await loadTab("my");
    });
    if (act === "chat") return run(async () => {
      const r = await api("chat", { id: o.id });
      const link = "https://t.me/" + (r.botUsername || S.botUsername);
      toast("Пишите сообщение в боте. Закончить: /done");
      if (tg && tg.openTelegramLink) tg.openTelegramLink(link); else window.open(link, "_blank");
    });
    if (act === "shoot") {
      pendingShot = { zone: el.dataset.zone, kind: el.dataset.kind };
      camera.click();
      return;
    }
    if (act === "submit") return run(async () => {
      await api("submit", { id: o.id, comment: S.comment.trim() });
      haptic("success");
      S.comment = "";
      S.screen = "submitted";
      render();
      window.scrollTo(0, 0);
    });
  });

  app.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.act !== "check") return;
    const id = Number(el.dataset.id);
    const item = S.order.items.find((i) => i.id === id);
    if (!item) return;
    const done = el.checked;
    item.done = done; // сразу показываем, на сервер — следом
    render();
    api("check", { itemId: id, done }).catch((err) => {
      item.done = !done;
      render();
      toast(ERR[err.message] || ERR.server);
    });
  });

  app.addEventListener("input", (e) => {
    if (e.target.dataset.act === "comment") S.comment = e.target.value;
  });

  // ── Старт ───────────────────────────────────────────────
  async function boot() {
    if (!API_URL || API_URL.includes("YOUR-PROJECT-REF")) {
      S.gate = "Не настроен адрес API в config.js.";
      S.screen = "gate";
      return render();
    }
    if (!tg || !tg.initData) {
      S.gate = "Откройте приложение из бота Smart Cleaning в Telegram.";
      S.screen = "gate";
      return render();
    }
    try {
      const r = await api("me");
      S.me = r.cleaner;
      S.botUsername = r.botUsername;
      if (!S.me) { S.gate = "Вы ещё не зарегистрированы. Вернитесь в бот и нажмите /start."; S.screen = "gate"; return render(); }
      if (S.me.status === "pending") { S.gate = "Заявка на рассмотрении. Напишем в боте после пробной уборки."; S.screen = "gate"; return render(); }
      if (S.me.status === "blocked") { S.gate = "Доступ к заказам закрыт. Вопросы — администратору."; S.screen = "gate"; return render(); }
      await loadTab("feed");
    } catch (e) {
      S.gate = ERR[e.message] || ERR.server;
      S.screen = "gate";
      render();
    }
  }

  boot();
})();
