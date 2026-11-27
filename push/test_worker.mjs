// Tests for the push sender (push/worker.mjs) with a fake KV store and a fake
// Apple push service. No network, nothing real is touched.   Run: node push/test_worker.mjs
import { handle, runDue, cleanEvents, b64u } from "./worker.mjs";

const KEY = "test-key-0123456789abcdef";
const results = [];
const test = (name, fn) => results.push([name, fn]);
const ok = (x, m) => { if (!x) throw new Error(m || "expected true"); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "not equal") + ": got " + JSON.stringify(a) + ", expected " + JSON.stringify(b)); };

function fakeEnv(extra) {
  const m = new Map();
  return Object.assign({ API_KEY: KEY, PLANNER: {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  } }, extra || {});
}
function fakePush(status) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: status < 300, status }; };
  fn.calls = calls;
  return fn;
}
const call = (env, method, path, body, key, now, fetchFn) => handle(
  new Request("https://w.example" + path, { method, headers: Object.assign({ "Content-Type": "application/json" }, key === null ? {} : { Authorization: "Bearer " + (key || KEY) }), body: body === undefined ? undefined : JSON.stringify(body) }),
  env, now || 1000000, fetchFn);
const J = async (res) => res.json();
const NOW = Date.UTC(2026, 11, 1, 8, 0);
const ev = (id, at, extra) => Object.assign({ id, kind: "reminder", title: "T " + id, body: "b", at }, extra || {});

test("no key or wrong key is refused", async () => {
  const env = fakeEnv();
  eq((await call(env, "GET", "/next", undefined, null)).status, 401);
  eq((await call(env, "GET", "/next", undefined, "wrong-wrong-wrong-wrong")).status, 401);
  eq((await call(env, "GET", "/next")).status, 200);
});

test("a Worker without a proper API_KEY refuses everything", async () => {
  eq((await call(fakeEnv({ API_KEY: "short" }), "GET", "/next")).status, 500);
});

test("CORS preflight works without a key (browser asks first)", async () => {
  const res = await call(fakeEnv(), "OPTIONS", "/events", undefined, null);
  eq(res.status, 204);
  ok(res.headers.get("Access-Control-Allow-Origin") === "*");
});

test("/vapid makes the push key once and keeps it", async () => {
  const env = fakeEnv();
  const a = (await J(await call(env, "GET", "/vapid"))).publicKey;
  const b = (await J(await call(env, "GET", "/vapid"))).publicKey;
  ok(a && a === b);
  eq(Buffer.from(a.replace(/-/g, "+").replace(/_/g, "/"), "base64").length, 65, "uncompressed P-256 key is 65 bytes");
});

test("subscribe needs an https endpoint", async () => {
  const env = fakeEnv();
  eq((await call(env, "POST", "/subscribe", { subscription: { endpoint: "http://x" } })).status, 400);
  eq((await call(env, "POST", "/subscribe", {})).status, 400);
  eq((await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } })).status, 200);
});

test("events are cleaned: bad ones dropped, long text cut", () => {
  const out = cleanEvents([ev("a", 5), { id: "b" }, null, ev("c", 6, { title: "x".repeat(500) }), { id: "d", title: "t", at: "soon" }]);
  eq(out.map((e) => e.id), ["a", "c"]);
  eq(out[1].title.length, 120);
  eq(cleanEvents("nope"), null);
});

test("/next lists only future events, soonest first, plus the exam", async () => {
  const env = fakeEnv();
  await call(env, "POST", "/events", { events: [ev("late", NOW + 5000), ev("past", NOW - 5000), ev("soon", NOW + 1000)], exam: { name: "Statics", at: NOW + 99999 } });
  const r = await J(await call(env, "GET", "/next", undefined, null === 1 ? 0 : undefined, NOW));
  eq(r.events.map((e) => e.id), ["soon", "late"]);
  eq(r.exam.name, "Statics");
});

test("a due event is queued once and the push ring is sent with a valid signature", async () => {
  const env = fakeEnv(), push = fakePush(201);
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  await call(env, "POST", "/events", { events: [ev("r1", NOW - 60000), ev("later", NOW + 3600000)] });
  const r1 = await runDue(env, NOW, push);
  eq(r1.queued, 1);
  eq(push.calls.length, 1);
  const auth = push.calls[0].opts.headers.Authorization;
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
  ok(m, "header shape: " + auth);
  const pub = await crypto.subtle.importKey("raw", Buffer.from(m[4].replace(/-/g, "+").replace(/_/g, "/"), "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub,
    Buffer.from(m[3].replace(/-/g, "+").replace(/_/g, "/"), "base64"), new TextEncoder().encode(m[1] + "." + m[2]));
  ok(valid, "JWT signature verifies with the public key");
  const claims = JSON.parse(Buffer.from(m[2].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  eq(claims.aud, "https://push.example");
  ok(claims.exp > NOW / 1000 && claims.exp <= NOW / 1000 + 86400, "expiry within 24 h");
  // second run a minute later: nothing new, no second ring
  const r2 = await runDue(env, NOW + 60000, push);
  eq(r2.queued, 0);
  eq(push.calls.length, 1);
});

test("the phone gets the text from /pending, once", async () => {
  const env = fakeEnv(), push = fakePush(201);
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  await call(env, "POST", "/events", { events: [ev("r1", NOW - 1000, { title: "Dentist", body: "10:00 · Clinic" })] });
  await runDue(env, NOW, push);
  const a = await J(await call(env, "GET", "/pending"));
  eq(a.items.map((i) => [i.title, i.body]), [["Dentist", "10:00 · Clinic"]]);
  eq((await J(await call(env, "GET", "/pending"))).items, []);
});

test("notifyAt (a heads-up before the event) is what triggers the ring", async () => {
  const env = fakeEnv(), push = fakePush(201);
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  await call(env, "POST", "/events", { events: [ev("r1", NOW + 600000, { notifyAt: NOW })] });
  eq((await runDue(env, NOW, push)).queued, 1);
});

test("events more than 15 minutes overdue are not sent late; notify:false never rings", async () => {
  const env = fakeEnv(), push = fakePush(201);
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  await call(env, "POST", "/events", { events: [ev("old", NOW - 20 * 60000), ev("quiet", NOW - 1000, { notify: false })] });
  eq((await runDue(env, NOW, push)).queued, 0);
  eq(push.calls.length, 0);
});

test("re-uploading the same events does not ring twice, but a moved event rings again", async () => {
  const env = fakeEnv(), push = fakePush(201);
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  await call(env, "POST", "/events", { events: [ev("r1", NOW - 1000)] });
  await runDue(env, NOW, push);
  await call(env, "POST", "/events", { events: [ev("r1", NOW - 1000)] });
  eq((await runDue(env, NOW + 60000, push)).queued, 0);
  await call(env, "POST", "/events", { events: [ev("r1", NOW + 120000)] });
  eq((await runDue(env, NOW + 130000, push)).queued, 1);
});

test("a failed ring is retried next minute; an expired phone is forgotten", async () => {
  const env = fakeEnv();
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  await call(env, "POST", "/events", { events: [ev("r1", NOW - 1000)] });
  const bad = fakePush(503);
  await runDue(env, NOW, bad);
  await runDue(env, NOW + 60000, bad);
  eq(bad.calls.length, 2, "retried");
  const gone = fakePush(410);
  await runDue(env, NOW + 120000, gone);
  eq((await J(await call(env, "GET", "/status"))).subscribed, false);
});

test("/test rings the phone right away", async () => {
  const env = fakeEnv(), push = fakePush(201);
  await call(env, "POST", "/subscribe", { subscription: { endpoint: "https://push.example/abc" } });
  const r = await J(await call(env, "POST", "/test", undefined, undefined, NOW, push));
  ok(r.ok);
  eq(push.calls.length, 1);
  eq((await J(await call(env, "GET", "/pending"))).items[0].body, "Test: notifications work.");
});

let passed = 0, failed = 0;
for (const [name, fn] of results) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
}
console.log("\n" + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
