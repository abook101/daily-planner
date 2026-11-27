// Daily Planner: phone notifications and the home-screen widget (step 8).
//
// How the pieces fit:
//   - The app works out your upcoming "important events" (buildEvents below) and
//     uploads them to your own free Cloudflare Worker (push/worker.mjs).
//   - Every minute the Worker checks the list. When something is due it rings
//     your iPhone through Apple's push service, and the app's service worker
//     (sw.js) fetches the text from the Worker and shows the notification.
//   - A Scriptable widget asks the Worker for the next event and counts down.
//
// What counts as important (all can be switched off in Settings):
//   reminder  your Reminders: at their time (10 min before by default), or at
//             the morning time if a reminder has no time
//   digest    one morning summary: study blocks, chores, reminders and today's training
//   study     an evening nudge when no study is logged yet today
//   timer     when a running study timer reaches its block length
//   exam      not a notification: the next exam's countdown line on the widget
//
// The Worker address and key are saved on this phone only (localStorage), never
// in backups and never on the public website. The pure parts (events, checks,
// widget script) are tested in tests/notify.test.js.
"use strict";

(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("./store.js") : root.PlannerData;
  const L = isNode ? require("./plan.js") : root.PlannerLogic;

  const KEYS = {
    CONFIG: "planner.push",          // { url, key, morning, study, lead, kinds }
    STATUS: "planner.pushStatus",    // { subscribed, lastTry, lastOk, lastSig, error, count }
  };
  const SW_CACHE = "planner-push-config";   // the service worker reads the address + key from here
  const WINDOW_DAYS = 7;
  const LATE_MS = 15 * 60000;               // events up to 15 min overdue are still kept (the Worker sends them late)
  const EXAM_HOUR = "09:00";
  const RESEND_MS = 6 * 3600000;            // upload again after 6 h even if nothing changed
  const RETRY_MS = 60000;                   // after an error, wait a minute before trying again
  const TIMEOUT_MS = 15000;
  const DEFAULT_KINDS = { reminder: true, digest: true, study: true, timer: true };
  const DEFAULTS = { morning: "08:00", study: "18:00", lead: 10 };

  // ---------- small helpers ----------
  const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
  function localAt(dateStr, hhmm) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = hhmm.split(":").map(Number);
    return new Date(y, m - 1, d, hh, mm).getTime();
  }
  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return P.toDateStr(new Date(y, m - 1, d + n));
  }
  function readJSON(storage, key) {
    try { const t = storage.getItem(key); return t === null ? null : JSON.parse(t); } catch (e) { return null; }
  }
  const list = (a) => a.join(", ");

  // ---------- settings saved on this phone ----------
  function normalizeUrl(text) {
    let u = String(text || "").trim().replace(/\/+$/, "");
    if (!u) throw new Error("Type the Worker address (it ends in .workers.dev).");
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) throw new Error("That address doesn't look right. It should look like https://daily-planner-push.yourname.workers.dev");
    return u;
  }

  function getConfig(storage) {
    const c = readJSON(storage, KEYS.CONFIG);
    if (!c || typeof c.url !== "string" || typeof c.key !== "string") return null;
    return {
      url: c.url, key: c.key,
      morning: isTime(c.morning) ? c.morning : DEFAULTS.morning,
      study: isTime(c.study) ? c.study : DEFAULTS.study,
      lead: Number.isInteger(c.lead) && c.lead >= 0 && c.lead <= 120 ? c.lead : DEFAULTS.lead,
      kinds: Object.assign({}, DEFAULT_KINDS, c.kinds || {}),
    };
  }

  // Checks everything, saves nothing if anything is wrong (throws a plain message).
  function setConfig(storage, input) {
    const url = normalizeUrl(input.url);
    const key = String(input.key || "").trim();
    if (key.length < 16) throw new Error("The key must be at least 16 characters (the same text as the API_KEY you set in Cloudflare).");
    if (/\s/.test(key)) throw new Error("The key can't contain spaces.");
    const morning = input.morning || DEFAULTS.morning, study = input.study || DEFAULTS.study;
    if (!isTime(morning)) throw new Error("Morning time must look like 08:00.");
    if (!isTime(study)) throw new Error("Study reminder time must look like 18:00.");
    const lead = input.lead === "" || input.lead === undefined || input.lead === null ? DEFAULTS.lead : Number(input.lead);
    if (!Number.isInteger(lead) || lead < 0 || lead > 120) throw new Error("\"Minutes before\" must be a whole number from 0 to 120.");
    const kinds = Object.assign({}, DEFAULT_KINDS, input.kinds || {});
    const prev = getConfig(storage);
    storage.setItem(KEYS.CONFIG, JSON.stringify({ url, key, morning, study, lead, kinds }));
    // A different Worker (or key) means the phone must subscribe again.
    if (!prev || prev.url !== url || prev.key !== key) storage.removeItem(KEYS.STATUS);
    return getConfig(storage);
  }

  function clearConfig(storage) {
    storage.removeItem(KEYS.CONFIG);
    storage.removeItem(KEYS.STATUS);
  }
  const getStatus = (storage) => readJSON(storage, KEYS.STATUS) || {};
  const saveStatus = (storage, s) => storage.setItem(KEYS.STATUS, JSON.stringify(s));

  // ---------- the important events ----------
  // opts: { nowMs, config, timer (the running study timer or null), lowEnergy(day) -> bool }
  // Returns { events: [...], exam: {name, at} | null }. Pure: same input, same output.
  function buildEvents(data, opts) {
    const nowMs = opts.nowMs, config = opts.config, timer = opts.timer || null;
    const lowEnergy = opts.lowEnergy || (() => false);
    const today = P.toDateStr(new Date(nowMs));
    const events = [];
    const keep = (at) => at >= nowMs - LATE_MS;
    const lastDay = addDays(today, WINDOW_DAYS - 1);

    // reminders (every day of a multi-day reminder)
    if (config.kinds.reminder) {
      for (const r of data.reminders || []) {
        const end = r.endDate || r.startDate;
        for (let d = r.startDate < today ? today : r.startDate; d <= end && d <= lastDay; d = addDays(d, 1)) {
          const at = localAt(d, r.time || config.morning);
          const notifyAt = r.time ? at - config.lead * 60000 : at;
          if (!keep(Math.max(at, notifyAt))) continue;
          const where = [r.time, r.location].filter(Boolean).join(" · ");
          events.push({ id: "rem:" + r.id + ":" + d, kind: "reminder", title: r.name, body: [where, r.description].filter(Boolean).join(" — "), at, notifyAt, notify: true });
        }
      }
    }

    // morning summary of today and tomorrow, and the study nudge for today
    for (const d of [today, addDays(today, 1)]) {
      const plan = L.planDay(data, d, { lowEnergy: lowEnergy(d) });
      if (config.kinds.digest) {
        const at = localAt(d, config.morning);
        if (keep(at)) {
          const parts = [];
          const blocks = plan.study.blocks;
          if (blocks.length) parts.push("Study: " + list([...new Set(blocks.map((b) => b.subjectName))]));
          const chores = plan.chores.chores.filter((c) => !c.done).map((c) => c.name);
          if (chores.length) parts.push("Chores: " + list(chores));
          const rems = (data.reminders || []).filter((r) => r.startDate <= d && d <= (r.endDate || r.startDate));
          if (rems.length) parts.push(rems.length + " reminder" + (rems.length === 1 ? "" : "s"));
          if (d === today && plan.training && plan.training.label) parts.push(plan.training.label);
          if (parts.length) events.push({ id: "digest:" + d, kind: "digest", title: d === today ? "Today's plan" : "Your plan for today", body: parts.join(" · "), at, notifyAt: at, notify: true });
        }
      }
      if (config.kinds.study && d === today) {
        const at = localAt(d, config.study);
        const studied = (data.studySessions || []).some((s) => s.date === d);
        if (keep(at) && !studied && plan.study.blocks.length) {
          const b = plan.study.blocks[0];
          events.push({ id: "study:" + d, kind: "study", title: "Study time", body: b.subjectName + " · " + b.minutes + " min. Start the timer in the planner.", at, notifyAt: at, notify: true });
        }
      }
    }

    // a running study timer: rings when the block is over
    if (timer && config.kinds.timer) {
      const at = timer.startedAt + timer.minutes * 60000;
      if (keep(at)) events.push({ id: "timer:" + timer.startedAt, kind: "timer", title: "Study block done", body: timer.subjectName + " · " + timer.minutes + " min. Log it in the planner.", at, notifyAt: at, notify: true });
    }

    events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

    const next = L.nextExam(data.subjects, today);
    const exam = next ? { name: next.name, at: localAt(next.examDate, EXAM_HOUR) } : null;
    return { events, exam };
  }

  // ---------- talking to the Worker ----------
  // Never throws: returns { ok, status, data, error } with a message a person can act on.
  async function api(config, path, options, fetchFn, timeoutMs) {
    options = options || {};
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS) : null;
    try {
      const res = await fetchFn(config.url + path, {
        method: options.method || "GET",
        headers: Object.assign({ Authorization: "Bearer " + config.key }, options.body ? { "Content-Type": "application/json" } : {}),
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined, cache: "no-store",
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (res.status === 401) return { ok: false, status: 401, error: "The Worker says the key is wrong. It must be exactly the API_KEY you set in Cloudflare." };
      if (res.status === 500 && data && data.error) return { ok: false, status: 500, error: data.error };
      if (!res.ok) return { ok: false, status: res.status, error: (data && data.error) || "The Worker answered with an error (" + res.status + ")." };
      return { ok: true, status: res.status, data };
    } catch (err) {
      const msg = err && err.name === "AbortError" ? "The Worker didn't answer in time."
        : "Can't reach the Worker. Check the address and your internet connection.";
      return { ok: false, status: 0, error: msg };
    } finally { if (timer) clearTimeout(timer); }
  }

  function b64uToBytes(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // The service worker (sw.js) can't read localStorage, so it reads the address + key from a cache entry.
  async function shareWithServiceWorker(cachesApi, config) {
    if (!cachesApi) return;
    const cache = await cachesApi.open(SW_CACHE);
    await cache.put("push-config", new Response(JSON.stringify({ url: config.url, key: config.key })));
  }

  // The "Turn on notifications" button. Must run from a tap (iOS asks for permission only then).
  // env: { navigator, Notification, fetchFn, caches, hasPushManager }
  async function enablePush(storage, env) {
    const config = getConfig(storage);
    if (!config) return { ok: false, message: "Save the Worker address and key first." };
    const nav = env.navigator;
    if (!nav || !("serviceWorker" in nav) || !env.hasPushManager || !env.Notification) {
      return { ok: false, message: "This browser can't do notifications. On iPhone (iOS 16.4 or newer) open the planner from its home-screen icon, not from Safari." };
    }
    const vapid = await api(config, "/vapid", {}, env.fetchFn);
    if (!vapid.ok) return { ok: false, message: vapid.error };
    let permission = env.Notification.permission;
    if (permission !== "granted") permission = await env.Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, message: "Notifications are blocked for the planner. On iPhone: Settings > Notifications > Planner > Allow Notifications. Then tap this button again." };
    }
    let sub;
    try {
      const reg = await nav.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(vapid.data.publicKey) });
    } catch (err) {
      return { ok: false, message: "The phone refused the subscription: " + (err && err.message ? err.message : err) };
    }
    const saved = await api(config, "/subscribe", { method: "POST", body: { subscription: sub.toJSON() } }, env.fetchFn);
    if (!saved.ok) return { ok: false, message: saved.error };
    await shareWithServiceWorker(env.caches, config);
    const st = getStatus(storage);
    st.subscribed = true; st.error = null; st.lastSig = null;
    saveStatus(storage, st);
    return { ok: true, message: "Notifications are on for this phone." };
  }

  // Uploads the current events (only when they changed, or every 6 hours). Never throws.
  async function syncEvents({ data, storage, fetchFn, nowMs, timer, lowEnergy, force }) {
    const config = getConfig(storage);
    if (!config) return { ok: false, skipped: true, message: "Notifications aren't set up." };
    const st = getStatus(storage);
    if (!st.subscribed) return { ok: false, skipped: true, message: "Turn notifications on first." };
    if (st.error && st.lastTry && nowMs - st.lastTry < RETRY_MS && !force) return { ok: false, skipped: true, message: st.error };
    const payload = buildEvents(data, { nowMs, config, timer, lowEnergy });
    const sig = JSON.stringify(payload);
    if (!force && st.lastSig === sig && st.lastOk && nowMs - st.lastOk < RESEND_MS) return { ok: true, skipped: true, message: "Already up to date.", count: payload.events.length };
    st.lastTry = nowMs;
    const r = await api(config, "/events", { method: "POST", body: payload }, fetchFn);
    if (r.ok) { st.lastOk = nowMs; st.lastSig = sig; st.error = null; st.count = payload.events.length; }
    else st.error = r.error;
    saveStatus(storage, st);
    return { ok: r.ok, message: r.ok ? "Sent " + payload.events.length + " upcoming event" + (payload.events.length === 1 ? "" : "s") + " to the Worker." : r.error, count: payload.events.length };
  }

  function statusLine(storage, nowMs) {
    const c = getConfig(storage);
    if (!c) return "Off.";
    const st = getStatus(storage);
    if (!st.subscribed) return "Saved, but notifications aren't turned on yet.";
    if (st.error) return "Problem: " + st.error;
    if (!st.lastOk) return "On. Nothing sent yet.";
    const mins = Math.max(0, Math.round((nowMs - st.lastOk) / 60000));
    return "On. " + st.count + " upcoming event" + (st.count === 1 ? "" : "s") + " with the Worker (updated " + (mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : Math.round(mins / 60) + " h ago") + ").";
  }

  // ---------- the Scriptable widget ----------
  // The text the "Copy widget script" button puts on the clipboard, with this phone's
  // address and key filled in. Scriptable (free app) runs it as a widget.
  function widgetScript(config) {
    return [
      "// Daily Planner widget (Scriptable). Shows your next event with a live countdown.",
      "const URL_ = " + JSON.stringify(config.url) + ";",
      "const KEY = " + JSON.stringify(config.key) + ";",
      "const fm = FileManager.local();",
      "const cachePath = fm.joinPath(fm.documentsDirectory(), 'planner-next.json');",
      "async function load() {",
      "  try {",
      "    const req = new Request(URL_ + '/next');",
      "    req.headers = { Authorization: 'Bearer ' + KEY };",
      "    req.timeoutInterval = 15;",
      "    const j = await req.loadJSON();",
      "    if (j && Array.isArray(j.events)) { fm.writeString(cachePath, JSON.stringify(j)); return j; }",
      "  } catch (e) {}",
      "  try { return JSON.parse(fm.readString(cachePath)); } catch (e) { return null; }",
      "}",
      "const j = await load();",
      "const now = Date.now();",
      "const ev = j && (j.events || []).find((e) => e.at > now);",
      "const exam = j && j.exam && j.exam.at > now ? j.exam : null;",
      "const w = new ListWidget();",
      "w.backgroundColor = new Color('#111827');",
      "w.setPadding(12, 14, 12, 14);",
      "const small = (t, color) => { const s = w.addText(t); s.font = Font.mediumSystemFont(12); s.textColor = new Color(color || '#9ca3af'); s.lineLimit = 1; return s; };",
      "if (!j) {",
      "  small('Planner: can\\'t reach the Worker');",
      "} else if (!ev) {",
      "  const t = w.addText('Nothing coming up'); t.font = Font.semiboldSystemFont(16); t.textColor = Color.white();",
      "} else {",
      "  small(ev.kind === 'timer' ? 'STUDY TIMER' : ev.kind.toUpperCase(), '#60a5fa');",
      "  const title = w.addText(ev.title); title.font = Font.semiboldSystemFont(16); title.textColor = Color.white(); title.lineLimit = 2;",
      "  w.addSpacer(4);",
      "  const d = w.addDate(new Date(ev.at)); d.applyTimerStyle();",
      "  d.font = Font.boldMonospacedSystemFont(26); d.textColor = new Color('#22c55e');",
      "  const at = new Date(ev.at);",
      "  small(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (ev.body ? ' · ' + ev.body : ''));",
      "}",
      "if (exam) {",
      "  w.addSpacer(null);",
      "  const days = Math.ceil((exam.at - now) / 86400000);",
      "  small(exam.name + ' exam: ' + days + (days === 1 ? ' day' : ' days'), '#fbbf24');",
      "}",
      "w.refreshAfterDate = new Date(Date.now() + 15 * 60000);",
      "if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();",
      "Script.complete();",
      "",
    ].join("\n");
  }

  const api_ = {
    KEYS, SW_CACHE, WINDOW_DAYS, DEFAULTS, DEFAULT_KINDS,
    normalizeUrl, getConfig, setConfig, clearConfig, getStatus, buildEvents,
    api, enablePush, syncEvents, statusLine, widgetScript, shareWithServiceWorker,
  };

  if (isNode) module.exports = api_;
  else root.PlannerNotify = api_;
})(typeof window !== "undefined" ? window : globalThis);
