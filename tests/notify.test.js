// Tests for phone notifications (js/notify.js): which events are important and
// when they ring, the settings checks, uploading to the Worker, turning
// notifications on, and the widget script. Fake storage / network / phone only.
//
//   - Browser: http://localhost:8000/tests/
//   - Node:    node tests/notify.test.js
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;
  const N = isNode ? require("../js/notify.js") : window.PlannerNotify;
  const fs = isNode ? require("fs") : null;

  function fakeStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
  const at = (d, hhmm) => { const [y, m, dd] = d.split("-").map(Number); const [h, mi] = hhmm.split(":").map(Number); return new Date(y, m - 1, dd, h, mi).getTime(); };
  const NOW = at("2026-11-27", "12:00");
  const CFG = { url: "https://w.example.workers.dev", key: "abcdefghijklmnop1234", morning: "08:00", study: "18:00", lead: 10, kinds: { reminder: true, digest: true, study: true, timer: true } };
  const cfg = (kinds) => Object.assign({}, CFG, { kinds: Object.assign({}, CFG.kinds, kinds || {}) });
  const rem = (id, name, startDate, extra) => Object.assign({ id, name, startDate, endDate: null, time: null, description: "", location: "" }, extra || {});
  const build = (data, extra) => N.buildEvents(data, Object.assign({ nowMs: NOW, config: CFG }, extra || {}));
  const ids = (r) => r.events.map((e) => e.id);

  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg || "not equal") + ": got " + A + ", expected " + B);
  }
  function ok(x, msg) { if (!x) throw new Error(msg || "expected true"); }
  function throws(fn, match) {
    try { fn(); } catch (e) { if (match && !String(e.message).includes(match)) throw new Error("wrong error: " + e.message); return; }
    throw new Error("expected an error");
  }

  // ----- settings -----
  test("settings: address and key are checked, nothing saved when wrong", () => {
    const st = fakeStorage();
    throws(() => N.setConfig(st, { url: "", key: CFG.key }), "Worker address");
    throws(() => N.setConfig(st, { url: "not a url!", key: CFG.key }), "doesn't look right");
    throws(() => N.setConfig(st, { url: CFG.url, key: "short" }), "16 characters");
    throws(() => N.setConfig(st, { url: CFG.url, key: "has a space in it 12345" }), "spaces");
    throws(() => N.setConfig(st, { url: CFG.url, key: CFG.key, morning: "8am" }), "Morning time");
    throws(() => N.setConfig(st, { url: CFG.url, key: CFG.key, study: "25:00" }), "Study reminder time");
    throws(() => N.setConfig(st, { url: CFG.url, key: CFG.key, lead: "999" }), "0 to 120");
    eq(N.getConfig(st), null);
  });

  test("settings: address is tidied (https added, trailing slash removed) and defaults filled in", () => {
    const st = fakeStorage();
    const c = N.setConfig(st, { url: "  daily-planner-push.me.workers.dev/ ", key: CFG.key });
    eq(c.url, "https://daily-planner-push.me.workers.dev");
    eq([c.morning, c.study, c.lead], ["08:00", "18:00", 10]);
    eq(c.kinds, { reminder: true, digest: true, study: true, timer: true });
  });

  test("settings: changing the Worker or key means subscribing again; changing only times does not", () => {
    const st = fakeStorage();
    N.setConfig(st, { url: CFG.url, key: CFG.key });
    st.setItem(N.KEYS.STATUS, JSON.stringify({ subscribed: true }));
    N.setConfig(st, { url: CFG.url, key: CFG.key, morning: "07:30" });
    eq(N.getStatus(st).subscribed, true);
    N.setConfig(st, { url: CFG.url, key: "another-key-0123456789" });
    eq(N.getStatus(st).subscribed, undefined);
  });

  // ----- events -----
  test("a timed reminder rings 10 minutes early; the widget counts to the real time", () => {
    const d = P.defaultData();
    d.reminders.push(rem("r1", "Dentist", "2026-11-28", { time: "14:00", location: "Clinic", description: "Bring card" }));
    const e = build(d).events.find((x) => x.id === "rem:r1:2026-11-28");
    eq(e.at, at("2026-11-28", "14:00"));
    eq(e.notifyAt, at("2026-11-28", "13:50"));
    eq(e.title, "Dentist");
    eq(e.body, "14:00 · Clinic — Bring card");
  });

  test("a reminder without a time rings at the morning time", () => {
    const d = P.defaultData();
    d.reminders.push(rem("r1", "Pay rent", "2026-11-30"));
    const e = build(d).events.find((x) => x.kind === "reminder");
    eq(e.at, at("2026-11-30", "08:00"));
    eq(e.notifyAt, e.at);
  });

  test("a multi-day reminder gets one event per day, only from today on and within a week", () => {
    const d = P.defaultData();
    d.reminders.push(rem("r1", "Course", "2026-11-25", { endDate: "2026-12-20", time: "09:00" }));
    const days = build(d).events.filter((x) => x.kind === "reminder").map((x) => x.id.split(":")[2]);
    eq(days[0], "2026-11-28", "today's 09:00 is already over");
    eq(days.length, 6);
    eq(days[5], "2026-12-03");
  });

  test("past and far-away reminders are left out; a reminder that was due 5 minutes ago is kept", () => {
    const d = P.defaultData();
    d.reminders.push(rem("old", "Old", "2026-11-20"), rem("far", "Far", "2026-12-25"), rem("just", "Just", "2026-11-27", { time: "12:00" }));
    eq(build(d, { nowMs: NOW + 5 * 60000 }).events.filter((x) => x.kind === "reminder").map((x) => x.id), ["rem:just:2026-11-27"]);
  });

  test("morning plan: tomorrow's is included, today's is dropped once its time has passed", () => {
    const r = build(P.defaultData());
    ok(ids(r).includes("digest:2026-11-28"));
    ok(!ids(r).includes("digest:2026-11-27"));
    const early = build(P.defaultData(), { nowMs: at("2026-11-27", "07:00") });
    ok(ids(early).includes("digest:2026-11-27"));
    const text = early.events.find((e) => e.id === "digest:2026-11-27").body;
    ok(text.includes("Study:") && text.includes("Chores:"), text);
  });

  test("study nudge: only today, only when nothing is logged yet", () => {
    const d = P.defaultData();
    ok(ids(build(d)).includes("study:2026-11-27"));
    d.studySessions.push({ id: "s1", subjectId: d.subjects[0].id, minutes: 45, date: "2026-11-27" });
    ok(!ids(build(d)).includes("study:2026-11-27"));
  });

  test("a running study timer rings when the block is over", () => {
    const timer = { subjectId: "x", subjectName: "Statics", minutes: 45, startedAt: NOW - 10 * 60000 };
    const e = build(P.defaultData(), { timer }).events.find((x) => x.kind === "timer");
    eq(e.at, NOW + 35 * 60000);
    ok(e.body.includes("Statics"));
  });

  test("each kind can be switched off", () => {
    const d = P.defaultData();
    d.reminders.push(rem("r1", "X", "2026-11-28", { time: "10:00" }));
    const timer = { subjectId: "x", subjectName: "S", minutes: 45, startedAt: NOW };
    const kinds = (r) => [...new Set(r.events.map((e) => e.kind))].sort();
    eq(kinds(N.buildEvents(d, { nowMs: NOW, config: CFG, timer })), ["digest", "reminder", "study", "timer"]);
    eq(kinds(N.buildEvents(d, { nowMs: NOW, config: cfg({ reminder: false, timer: false }), timer })), ["digest", "study"]);
    eq(N.buildEvents(d, { nowMs: NOW, config: cfg({ reminder: false, digest: false, study: false, timer: false }), timer }).events, []);
  });

  test("the next exam goes to the widget as a countdown line", () => {
    const d = P.defaultData();
    const r = build(d);
    ok(r.exam && r.exam.name && r.exam.at > NOW);
    d.subjects.forEach((s) => { s.examDate = null; });
    eq(build(d).exam, null);
  });

  test("events come out sorted and the same input always gives the same output", () => {
    const d = P.defaultData();
    d.reminders.push(rem("a", "A", "2026-11-29", { time: "09:00" }), rem("b", "B", "2026-11-28", { time: "09:00" }));
    const r = build(d);
    eq(r.events.map((e) => e.at), r.events.map((e) => e.at).sort((a, b) => a - b));
    eq(JSON.stringify(build(d)), JSON.stringify(r));
  });

  // ----- talking to the Worker -----
  const fakeFetch = (routes) => {
    const calls = [];
    const fn = async (url, opts) => {
      calls.push({ url, opts });
      const path = url.replace(CFG.url, "");
      const r = routes[path] || routes["*"] || { status: 404, body: { error: "nf" } };
      if (r.throw) throw r.throw;
      return { ok: (r.status || 200) < 300, status: r.status || 200, json: async () => r.body };
    };
    fn.calls = calls;
    return fn;
  };
  const subscribedStorage = (extra) => {
    const st = fakeStorage();
    st.setItem(N.KEYS.CONFIG, JSON.stringify(CFG));
    st.setItem(N.KEYS.STATUS, JSON.stringify(Object.assign({ subscribed: true }, extra || {})));
    return st;
  };

  test("upload: sends the events with the key, and skips when nothing changed", async () => {
    const st = subscribedStorage(), f = fakeFetch({ "/events": { body: { ok: true } } });
    const args = { data: P.defaultData(), storage: st, fetchFn: f, nowMs: NOW };
    const r1 = await N.syncEvents(args);
    ok(r1.ok && !r1.skipped, r1.message);
    eq(f.calls[0].opts.headers.Authorization, "Bearer " + CFG.key);
    ok(JSON.parse(f.calls[0].opts.body).events.length > 0);
    const r2 = await N.syncEvents(Object.assign({}, args, { nowMs: NOW + 60000 }));
    ok(r2.skipped);
    eq(f.calls.length, 1);
    await N.syncEvents(Object.assign({}, args, { nowMs: NOW + 7 * 3600000 }));
    eq(f.calls.length, 2, "uploads again after 6 hours");
    const d2 = P.defaultData(); d2.reminders.push(rem("n", "New", "2026-11-28", { time: "10:00" }));
    await N.syncEvents({ data: d2, storage: st, fetchFn: f, nowMs: NOW + 8 * 3600000 });
    eq(f.calls.length, 3, "a change uploads at once");
  });

  test("upload: not set up or not subscribed -> nothing is sent", async () => {
    const f = fakeFetch({});
    ok((await N.syncEvents({ data: P.defaultData(), storage: fakeStorage(), fetchFn: f, nowMs: NOW })).skipped);
    const st = fakeStorage(); st.setItem(N.KEYS.CONFIG, JSON.stringify(CFG));
    ok((await N.syncEvents({ data: P.defaultData(), storage: st, fetchFn: f, nowMs: NOW })).skipped);
    eq(f.calls.length, 0);
  });

  test("after an upload error the app waits a minute before trying again", async () => {
    const st = subscribedStorage(), f = fakeFetch({ "/events": { status: 503, body: {} } });
    const args = { data: P.defaultData(), storage: st, fetchFn: f, nowMs: NOW };
    await N.syncEvents(args);
    ok((await N.syncEvents(Object.assign({}, args, { nowMs: NOW + 5000 }))).skipped);
    eq(f.calls.length, 1);
    await N.syncEvents(Object.assign({}, args, { nowMs: NOW + 61000 }));
    eq(f.calls.length, 2);
  });

  test("upload errors say what to do, and are remembered for the screen", async () => {
    const st = subscribedStorage();
    const wrong = await N.syncEvents({ data: P.defaultData(), storage: st, fetchFn: fakeFetch({ "/events": { status: 401, body: {} } }), nowMs: NOW });
    ok(!wrong.ok && wrong.message.includes("API_KEY"));
    ok(N.statusLine(st, NOW).startsWith("Problem:"));
    const off = await N.syncEvents({ data: P.defaultData(), storage: st, fetchFn: fakeFetch({ "/events": { throw: new TypeError("x") } }), nowMs: NOW + 61000 });
    ok(off.message.includes("Can't reach the Worker"));
  });

  // ----- turning notifications on -----
  function fakePhone(over) {
    const log = { subscribeOpts: null, unsub: 0, cached: null };
    const sub = { toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } }) };
    const reg = { pushManager: {
      getSubscription: async () => ({ unsubscribe: async () => { log.unsub++; } }),
      subscribe: async (o) => { log.subscribeOpts = o; return sub; },
    } };
    const env = Object.assign({
      navigator: { serviceWorker: { ready: Promise.resolve(reg) } }, hasPushManager: true,
      Notification: { permission: "default", requestPermission: async () => "granted" },
      caches: { open: async () => ({ put: async (k, v) => { log.cached = JSON.parse(await v.text()); } }) },
      fetchFn: fakeFetch({ "/vapid": { body: { publicKey: "BAAA" } }, "/subscribe": { body: { ok: true } } }),
    }, over || {});
    return { env, log };
  }
  const configured = () => { const st = fakeStorage(); N.setConfig(st, CFG); return st; };

  test("turn on: asks permission, subscribes, tells the Worker, shares the key with the service worker", async () => {
    const st = configured(), { env, log } = fakePhone();
    const r = await N.enablePush(st, env);
    ok(r.ok, r.message);
    eq(log.subscribeOpts.userVisibleOnly, true);
    eq(log.unsub, 1, "an old subscription is replaced");
    eq(log.cached, { url: CFG.url, key: CFG.key });
    eq(JSON.parse(env.fetchFn.calls[1].opts.body).subscription.endpoint, "https://web.push.apple.com/abc");
    eq(N.getStatus(st).subscribed, true);
  });

  test("turn on: refusing permission, no push support and a wrong key all give a clear message", async () => {
    const denied = fakePhone({ Notification: { permission: "default", requestPermission: async () => "denied" } });
    const a = await N.enablePush(configured(), denied.env);
    ok(!a.ok && a.message.includes("Settings > Notifications"));
    const b = await N.enablePush(configured(), fakePhone({ hasPushManager: false }).env);
    ok(!b.ok && b.message.includes("home-screen icon"));
    const c = await N.enablePush(configured(), fakePhone({ fetchFn: fakeFetch({ "*": { status: 401, body: {} } }) }).env);
    ok(!c.ok && c.message.includes("key is wrong"));
    const d = await N.enablePush(fakeStorage(), fakePhone().env);
    ok(!d.ok && d.message.includes("Save the Worker address"));
  });

  // ----- widget script + service worker -----
  test("the widget script has this phone's address and key and is valid JavaScript", () => {
    const s = N.widgetScript(CFG);
    ok(s.includes(JSON.stringify(CFG.url)) && s.includes(JSON.stringify(CFG.key)));
    ok(s.includes("applyTimerStyle"), "live countdown");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction("config", "Script", "ListWidget", "Color", "Font", "Request", "FileManager", s);
  });

  test("the widget script shows the next event with a timer (run against a fake Scriptable)", async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const seen = { texts: [], dates: 0, timer: 0, widget: null };
    class ListWidget {
      setPadding() {} addSpacer() {}
      addText(t) { seen.texts.push(t); return { font: null, textColor: null, lineLimit: 0 }; }
      addDate() { seen.dates++; return { applyTimerStyle() { seen.timer++; }, font: null, textColor: null }; }
    }
    const Font = new Proxy({}, { get: () => () => ({}) });
    const Color = class { constructor() {} static white() { return {}; } };
    const Request = class { async loadJSON() { return { now: Date.now(), events: [{ id: "a", kind: "reminder", title: "Dentist", body: "Clinic", at: Date.now() + 3600000 }], exam: null }; } };
    const files = new Map();
    const FileManager = { local: () => ({ joinPath: (a, b) => b, documentsDirectory: () => "", writeString: (p, t) => files.set(p, t), readString: (p) => files.get(p) }) };
    const Script = { setWidget: (w) => { seen.widget = w; }, complete() {} };
    await new AsyncFunction("config", "Script", "ListWidget", "Color", "Font", "Request", "FileManager", N.widgetScript(CFG))(
      { runsInWidget: true }, Script, ListWidget, Color, Font, Request, FileManager);
    ok(seen.widget, "widget set");
    ok(seen.texts.includes("Dentist"), seen.texts.join("|"));
    eq([seen.dates, seen.timer], [1, 1]);
    ok(files.size === 1, "last answer cached for offline");
  });

  if (isNode) {
    const root = require("path").join(__dirname, "..");
    test("the service worker shows notifications and lists the new file", () => {
      const sw = fs.readFileSync(root + "/sw.js", "utf8");
      ok(sw.includes('addEventListener("push"') && sw.includes('"js/notify.js"') && sw.includes('"js/notify-ui.js"'));
      ok(fs.readFileSync(root + "/index.html", "utf8").includes('src="js/notify.js"'));
    });
  }

  async function run(log) {
    let passed = 0, failed = 0;
    for (const [name, fn] of tests) {
      try { await fn(); passed++; log(true, name); }
      catch (e) { failed++; log(false, name, e.message); }
    }
    return { passed, failed };
  }

  if (isNode) {
    run((good, name, err) => console.log((good ? "  PASS " : "  FAIL ") + name + (err ? "\n       " + err : "")))
      .then(({ passed, failed }) => { console.log("\n" + passed + " passed, " + failed + " failed"); process.exitCode = failed ? 1 : 0; });
  } else {
    window.runNotifyTests = run;
  }
})();
