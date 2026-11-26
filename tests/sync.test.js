// Tests for the Whoop laptop sync on the app side (step 6): reading what the
// laptop sends, the rules for mixing Whoop numbers with typed ones, and the
// sync itself with a fake laptop (no network, no real data touched).
//
// Run them either way, no installs needed:
//   - Browser: start the local server (see README) and open http://localhost:8000/tests/
//   - Node (if installed):  node tests/sync.test.js
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;
  const S = isNode ? require("../js/sync.js") : window.PlannerSync;
  const T = isNode ? require("../js/today.js") : window.PlannerToday;
  const L = isNode ? require("../js/plan.js") : window.PlannerLogic;

  function fakeStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
  const TODAY = "2026-11-25";
  const NOW = new Date(2026, 10, 25, 8, 0).getTime();
  const newStore = (storage) => P.createStore(storage || fakeStorage(), { now: () => new Date(NOW) });
  const day = (recovery, hrv, rhr, extra) => Object.assign({ recovery, hrv, rhr, sleepHours: null, sleepPerf: null }, extra || {});
  const payload = (days, extra) => Object.assign({ app: "daily-planner-whoop", version: 1, generatedAt: "2026-11-25T07:00:00.000Z", days, workouts: [] }, extra || {});

  // A fake laptop: answers like sync/whoop_sync.py serve.
  function fakeLaptop(body, status) {
    const calls = [];
    const fn = async (url) => {
      calls.push(url);
      if (body instanceof Error) throw body;
      return { ok: (status || 200) < 400, status: status || 200, json: async () => body };
    };
    fn.calls = calls;
    return fn;
  }

  // ---- tiny test runner (same as the other test files) ----
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg || "not equal") + ": got " + A + ", expected " + B);
  }
  function ok(x, msg) { if (!x) throw new Error(msg || "expected true"); }

  // =================== merge rules ===================

  test("empty day: Whoop numbers are saved, marked as Whoop, sleep included", () => {
    const d = P.defaultData();
    const r = S.mergeWhoop(d, { [TODAY]: day(72, 64.4, 51, { sleepHours: 7.5, sleepPerf: 91 }) }, TODAY);
    eq(r.added, [TODAY]);
    eq(d.metrics[TODAY], { source: "whoop", recovery: 72, hrv: 64.4, rhr: 51, sleepHours: 7.5, sleepPerf: 91 });
    eq(P.validateData(d), [], "still valid data");
  });

  test("typed-in numbers are NEVER overwritten by a sync", () => {
    const store = newStore();
    store.setMetrics(TODAY, { recovery: 40, hrv: 50, rhr: 55, source: "manual" });
    const r = S.applyWhoop(store, { [TODAY]: day(72, 64.4, 51) }, TODAY);
    eq(r.keptManual, [TODAY]);
    eq(store.getMetrics(TODAY), { recovery: 40, hrv: 50, rhr: 55, source: "manual" });
  });

  test("Whoop day already saved: replaced when Whoop's numbers changed (rescored)", () => {
    const store = newStore();
    S.applyWhoop(store, { [TODAY]: day(60, 55, 52) }, TODAY);
    const r = S.applyWhoop(store, { [TODAY]: day(63, 57.2, 52) }, TODAY);
    eq(r.updated, [TODAY]);
    eq(store.getMetrics(TODAY).recovery, 63);
  });

  test("nothing changed = nothing written (so Undo keeps working)", () => {
    const storage = fakeStorage();
    const store = newStore(storage);
    S.applyWhoop(store, { [TODAY]: day(60, 55, 52) }, TODAY);
    // Log something with undo, then sync the same numbers again.
    T.withUndo(store, storage, "Football", () => store.addFootball({ durationMin: 60 }), NOW);
    const r = S.applyWhoop(store, { [TODAY]: day(60, 55, 52) }, TODAY);
    eq(r.unchanged, [TODAY]);
    eq(T.undoLast(store, storage, NOW + 1000), "Football", "undo still allowed");
  });

  test("future days, days older than 14 days and days without recovery/HRV/RHR are skipped", () => {
    const d = P.defaultData();
    const r = S.mergeWhoop(d, {
      "2026-11-26": day(70, 60, 50),               // tomorrow
      "2026-11-10": day(70, 60, 50),               // 15 days ago
      "2026-11-11": day(70, 60, 50),               // 14 days ago: ok
      "2026-11-24": day(null, null, null, { sleepHours: 7 }), // only sleep
    }, TODAY);
    eq(r.added, ["2026-11-11"]);
    eq(r.skipped.sort(), ["2026-11-10", "2026-11-24", "2026-11-26"]);
  });

  test("impossible numbers from the laptop are skipped, other days still saved", () => {
    const store = newStore();
    const r = S.applyWhoop(store, { "2026-11-24": day(150, 60, 50), [TODAY]: day(70, 60, 50) }, TODAY);
    eq(r.skipped, ["2026-11-24"]);
    eq(r.added, [TODAY]);
    eq(store.getMetrics("2026-11-24"), null);
  });

  test("sleep numbers are checked by the data layer too", () => {
    const d = P.defaultData();
    d.metrics[TODAY] = { source: "whoop", recovery: 50, hrv: 50, rhr: 50, sleepHours: 30 };
    ok(P.validateData(d).join().includes("sleep must be 0–24"));
  });

  test("Whoop numbers feed the daily plan like typed ones", () => {
    const store = newStore();
    S.applyWhoop(store, { [TODAY]: day(20, 40, 60) }, TODAY);
    eq(L.planDay(store.get(), TODAY).training.type, "rest", "red recovery -> rest");
  });

  // =================== "Whoop says" offer ===================

  test("typed day + different Whoop numbers -> offer; tapping it switches to Whoop", () => {
    const store = newStore();
    store.setMetrics(TODAY, { recovery: 40, hrv: null, rhr: null, source: "manual" });
    const latest = { [TODAY]: day(72, 64.4, 51, { sleepHours: 7.5 }) };
    const offer = S.whoopOffer(store.get(), latest, TODAY);
    eq([offer.recovery, offer.hrv, offer.rhr], [72, 64.4, 51]);
    S.useWhoopFor(store, TODAY, offer);
    eq(store.getMetrics(TODAY), { source: "whoop", recovery: 72, hrv: 64.4, rhr: 51, sleepHours: 7.5 });
    eq(S.whoopOffer(store.get(), latest, TODAY), null, "no offer once it's Whoop");
  });

  test("no offer when typed numbers already match Whoop", () => {
    const store = newStore();
    store.setMetrics(TODAY, { recovery: 72, hrv: 64.4, rhr: 51, source: "manual" });
    eq(S.whoopOffer(store.get(), { [TODAY]: day(72, 64.4, 51) }, TODAY), null);
  });

  // =================== payload + settings ===================

  test("payload from something else is refused with a clear message", () => {
    ok(!S.parsePayload({ hello: 1 }).ok);
    ok(S.parsePayload(payload({}, { version: 2 })).error.includes("version"));
    const p = S.parsePayload(payload({ "bad-date": day(1, 2, 30), [TODAY]: { recovery: 70, junk: "x" } }));
    eq(p.days, { [TODAY]: day(70, null, null) });
  });

  test("laptop address and key are tidied up; bad ones refused", () => {
    eq(S.normalizeAddress("192.168.1.23"), "192.168.1.23:8765");
    eq(S.normalizeAddress(" https://192.168.1.23:9000/ "), "192.168.1.23:9000");
    eq(S.normalizeAddress("my laptop"), null);
    const storage = fakeStorage();
    let err = null;
    try { S.setConfig(storage, "192.168.1.23", "abc"); } catch (e) { err = e; }
    ok(err && err.message.includes("too short"));
    eq(S.getConfig(storage), null, "nothing saved");
    const c = S.setConfig(storage, "192.168.1.23", "abcd-efgh-jkmn");
    eq(c, { address: "192.168.1.23:8765", key: "ABCDEFGHJKMN" });
    eq(S.syncUrl(c), "https://192.168.1.23:8765/whoop.json?key=ABCDEFGHJKMN");
  });

  // =================== the whole sync, with a fake laptop ===================

  test("sync: saves new days, remembers Whoop's numbers, status OK", async () => {
    const storage = fakeStorage();
    const store = newStore(storage);
    S.setConfig(storage, "192.168.1.23", "ABCD-EFGH-JKMN");
    const laptop = fakeLaptop(payload({ [TODAY]: day(72, 64.4, 51), "2026-11-24": day(55, 50, 53) }));
    const r = await S.syncNow({ store, storage, fetchFn: laptop, nowMs: NOW, today: TODAY });
    ok(r.ok, r.message);
    eq(r.message, "Whoop: updated 2 days.");
    eq(laptop.calls, ["https://192.168.1.23:8765/whoop.json?key=ABCDEFGHJKMN"]);
    eq(store.getMetrics(TODAY).source, "whoop");
    ok(S.latestDays(storage)[TODAY], "kept for the offer");
    ok(S.statusLine(storage, NOW).text.startsWith("Laptop sync today 08:00"));
    ok(!S.shouldAutoSync(storage, NOW + 5 * 60000), "not again within 10 min");
    ok(S.shouldAutoSync(storage, NOW + 11 * 60000));
  });

  test("sync: laptop off -> friendly message, data untouched, last good time kept", async () => {
    const storage = fakeStorage();
    const store = newStore(storage);
    S.setConfig(storage, "192.168.1.23", "ABCD-EFGH-JKMN");
    await S.syncNow({ store, storage, fetchFn: fakeLaptop(payload({ [TODAY]: day(72, 64, 51) })), nowMs: NOW, today: TODAY });
    const before = JSON.stringify(store.get());
    const r = await S.syncNow({ store, storage, fetchFn: fakeLaptop(new TypeError("Load failed")), nowMs: NOW + 3600000, today: TODAY });
    ok(!r.ok);
    ok(r.message.includes("Can't reach the laptop"), r.message);
    eq(JSON.stringify(store.get()), before);
    const line = S.statusLine(storage, NOW + 3600000);
    ok(!line.ok && line.text.includes("Last good sync today 08:00"), line.text);
  });

  test("sync: wrong key and Whoop problems on the laptop are explained", async () => {
    const storage = fakeStorage();
    const store = newStore(storage);
    S.setConfig(storage, "192.168.1.23", "ABCD-EFGH-JKMN");
    const r = await S.syncNow({ store, storage, fetchFn: fakeLaptop({ error: "x" }, 403), nowMs: NOW, today: TODAY });
    ok(r.message.includes("sync key is wrong"), r.message);
    const r2 = await S.syncNow({ store, storage, nowMs: NOW, today: TODAY,
      fetchFn: fakeLaptop(payload({}, { laptopError: "Whoop login has expired. Run: python sync/whoop_sync.py login" })) });
    ok(r2.ok && r2.message.includes("Whoop login has expired"), r2.message);
  });

  test("sync: not set up -> says so, tries nothing", async () => {
    const laptop = fakeLaptop(payload({}));
    const r = await S.syncNow({ store: newStore(), storage: fakeStorage(), fetchFn: laptop, nowMs: NOW, today: TODAY });
    ok(!r.ok && r.message.includes("isn't set up"));
    eq(laptop.calls.length, 0);
  });

  test("lastWhoopDay: newest earlier Whoop day, ignores typed days, today and old days", () => {
    const store = newStore();
    S.applyWhoop(store, { "2026-11-22": day(50, 66, 66), "2026-11-23": day(78, 79, 61) }, TODAY);
    const data = store.get();
    data.metrics["2026-11-24"] = { source: "manual", recovery: 10, hrv: 10, rhr: 90 };
    const last = S.lastWhoopDay(data, TODAY);
    eq(last.date, "2026-11-23");
    eq(last.recovery, 78);
    data.metrics["2026-10-01"] = { source: "whoop", recovery: 1, hrv: 1, rhr: 1 };
    eq(S.lastWhoopDay({ metrics: { "2026-10-01": data.metrics["2026-10-01"] } }, TODAY), null);
    eq(S.lastWhoopDay({ metrics: {} }, TODAY), null);
  });

  // ---- run ----
  async function run_(log) {
    let passed = 0, failed = 0;
    for (const [name, fn] of tests) {
      try { await fn(); passed++; log(true, name); }
      catch (e) { failed++; log(false, name, e.message); }
    }
    return { passed, failed };
  }

  if (isNode) {
    run_((good, name, err) => console.log((good ? "  PASS " : "  FAIL ") + name + (err ? "\n       " + err : "")))
      .then(({ passed, failed }) => {
        console.log("\n" + passed + " passed, " + failed + " failed");
        process.exitCode = failed ? 1 : 0;
      });
  } else {
    window.runSyncTests = run_;
  }
})();
