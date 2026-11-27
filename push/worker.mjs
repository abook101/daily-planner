// Daily Planner: the free "push sender" that runs on Cloudflare (a Worker).
//
// What it does, in plain words:
//   1. The planner app uploads your upcoming important events (reminders,
//      morning plan, study timer ...). This Worker keeps the list.
//   2. Every minute Cloudflare runs scheduled() below. If an event is due, the
//      Worker "rings" your iPhone through Apple's push service. The phone then
//      asks this Worker what to show and displays the notification.
//   3. The Scriptable widget on your home screen asks /next for the next event
//      and counts down to it.
//
// Everything needs the secret key (the API_KEY variable you set in Cloudflare).
// Notification texts never go through Apple: the ring itself is empty, and the
// phone fetches the text from here (so no message encryption is needed).
//
// Needs: a KV namespace bound as PLANNER, a variable/secret API_KEY, and a
// Cron Trigger "* * * * *". See push/README.md for the click-by-click steps.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const FIRE_WINDOW_MS = 15 * 60000;   // a missed notification is still sent up to 15 min late
const PENDING_MAX_AGE_MS = 30 * 60000;
const SENT_KEEP_MS = 2 * 86400000;
const MAX_EVENTS = 200;
const NEXT_COUNT = 6;
const DEFAULT_SUBJECT = "https://abook101.github.io/daily-planner/";

const enc = new TextEncoder();
export function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---------- storage (Cloudflare KV, one small key per kind of data) ----------
async function kvGet(env, key, fallback) {
  const t = await env.PLANNER.get(key);
  if (t === null || t === undefined) return fallback;
  try { return JSON.parse(t); } catch (e) { return fallback; }
}
const kvPut = (env, key, value) => env.PLANNER.put(key, JSON.stringify(value));

// ---------- the secret key ----------
function sameText(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function authError(req, env) {
  if (!env.API_KEY || String(env.API_KEY).length < 16) return reply({ error: "The Worker's API_KEY variable is missing or shorter than 16 characters." }, 500);
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!m || !sameText(m[1], env.API_KEY)) return reply({ error: "Wrong key." }, 401);
  return null;
}

// ---------- the Worker's own push identity (made once, kept in KV) ----------
export async function getVapid(env) {
  let v = await kvGet(env, "vapid", null);
  if (v) return v;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  v = {
    publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  await kvPut(env, "vapid", v);
  return v;
}

async function vapidHeader(vapid, endpoint, nowMs, subject) {
  const part = (o) => b64u(enc.encode(JSON.stringify(o)));
  const head = part({ typ: "JWT", alg: "ES256" });
  const body = part({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject });
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(new Uint8Array(sig)) + ", k=" + vapid.publicKey;
}

// An empty "ring". The service worker in the app answers it by fetching /pending.
export async function sendPush(env, nowMs, fetchFn = fetch) {
  const sub = await kvGet(env, "subscription", null);
  if (!sub || !sub.endpoint) return { ok: false, error: "No phone is subscribed yet." };
  let res;
  try {
    const vapid = await getVapid(env);
    res = await fetchFn(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(vapid, sub.endpoint, nowMs, env.VAPID_SUBJECT || DEFAULT_SUBJECT),
        TTL: "3600",
        Urgency: "high",
        "Content-Length": "0",
      },
    });
  } catch (err) {
    const out = { ok: false, at: nowMs, error: "Couldn't reach the push service: " + err.message };
    await kvPut(env, "status", out);
    return out;
  }
  const out = { ok: res.ok, at: nowMs, status: res.status, error: res.ok ? null : "Push service answered " + res.status };
  if (res.status === 404 || res.status === 410) {
    await env.PLANNER.delete("subscription"); // the phone turned notifications off or removed the app
    out.error = "The phone's subscription expired. Turn notifications on again in the app.";
  }
  await kvPut(env, "status", out);
  return out;
}

// ---------- the once-a-minute job ----------
export async function runDue(env, nowMs, fetchFn = fetch) {
  const stored = await kvGet(env, "events", { events: [] });
  const sent = await kvGet(env, "sent", {});
  let pending = await kvGet(env, "pending", []);
  const before = pending.length;
  pending = pending.filter((p) => nowMs - p.queuedAt < PENDING_MAX_AGE_MS);
  let changed = pending.length !== before, queued = 0;

  for (const e of stored.events) {
    if (e.notify === false) continue;
    const due = typeof e.notifyAt === "number" ? e.notifyAt : e.at;
    const key = e.id + "@" + due;
    if (due <= nowMs && nowMs - due <= FIRE_WINDOW_MS && !sent[key]) {
      sent[key] = nowMs;
      pending.push({ title: e.title, body: e.body || "", tag: key, queuedAt: nowMs });
      queued++; changed = true;
    }
  }
  for (const k of Object.keys(sent)) if (nowMs - sent[k] > SENT_KEEP_MS) { delete sent[k]; changed = true; }
  if (changed) { await kvPut(env, "sent", sent); await kvPut(env, "pending", pending); }

  const last = await kvGet(env, "status", null);
  if (pending.length && (queued || (last && !last.ok))) await sendPush(env, nowMs, fetchFn);
  return { queued, pending: pending.length };
}

// ---------- what the app may upload ----------
const text = (v, max) => String(v === undefined || v === null ? "" : v).slice(0, max);
export function cleanEvents(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const e of list.slice(0, MAX_EVENTS)) {
    if (!e || typeof e.id !== "string" || typeof e.title !== "string" || !Number.isFinite(e.at)) continue;
    out.push({
      id: text(e.id, 80), kind: text(e.kind || "event", 20), title: text(e.title, 120), body: text(e.body, 300),
      at: e.at, notifyAt: Number.isFinite(e.notifyAt) ? e.notifyAt : e.at, notify: e.notify !== false,
    });
  }
  return out;
}

async function body(req) { try { return await req.json(); } catch (e) { return null; } }

export async function handle(req, env, nowMs = Date.now(), fetchFn = fetch) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return reply({ app: "daily-planner-push", ok: true });
  const bad = authError(req, env);
  if (bad) return bad;

  if (req.method === "GET" && path === "/vapid") return reply({ publicKey: (await getVapid(env)).publicKey });

  if (req.method === "POST" && path === "/subscribe") {
    const b = await body(req);
    const s = b && b.subscription;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint)) return reply({ error: "That isn't a push subscription." }, 400);
    await kvPut(env, "subscription", { endpoint: s.endpoint });
    await env.PLANNER.delete("status");
    return reply({ ok: true });
  }

  if (req.method === "POST" && path === "/events") {
    const b = await body(req);
    const events = b && cleanEvents(b.events);
    if (!events) return reply({ error: "Expected {events: [...]}." }, 400);
    const exam = b.exam && Number.isFinite(b.exam.at) ? { name: text(b.exam.name, 80), at: b.exam.at } : null;
    await kvPut(env, "events", { events, exam, savedAt: nowMs });
    return reply({ ok: true, count: events.length });
  }

  if (req.method === "GET" && path === "/next") {
    const stored = await kvGet(env, "events", { events: [], exam: null });
    const upcoming = stored.events.filter((e) => e.at > nowMs).sort((a, b) => a.at - b.at).slice(0, NEXT_COUNT)
      .map(({ id, kind, title, body: b, at }) => ({ id, kind, title, body: b, at }));
    return reply({ now: nowMs, events: upcoming, exam: stored.exam && stored.exam.at > nowMs ? stored.exam : null });
  }

  if (req.method === "GET" && path === "/pending") {
    const pending = await kvGet(env, "pending", []);
    if (pending.length) await kvPut(env, "pending", []);
    return reply({ items: pending.map(({ title, body: b, tag }) => ({ title, body: b, tag })) });
  }

  if (req.method === "POST" && path === "/test") {
    const pending = await kvGet(env, "pending", []);
    pending.push({ title: "Daily Planner", body: "Test: notifications work.", tag: "test@" + nowMs, queuedAt: nowMs });
    await kvPut(env, "pending", pending);
    return reply(await sendPush(env, nowMs, fetchFn));
  }

  if (req.method === "GET" && path === "/status") {
    const stored = await kvGet(env, "events", { events: [] });
    return reply({
      subscribed: !!(await kvGet(env, "subscription", null)), events: stored.events.length,
      savedAt: stored.savedAt || null, lastPush: await kvGet(env, "status", null),
    });
  }

  return reply({ error: "Not found." }, 404);
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(runDue(env, Date.now())),
};
