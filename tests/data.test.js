// Tests for js/store.js (the data layer).
//
// Run them either way, no installs needed:
//   - Browser: start the local server (see README) and open http://localhost:8000/tests/
//   - Node (if installed):  node tests/data.test.js
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;

  // A fake localStorage that lives in memory, so tests never touch real data.
  function fakeStorage(initial) {
    const m = new Map(Object.entries(initial || {}));
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      keys: () => [...m.keys()],
      map: m,
    };
  }
  const fixedNow = () => new Date(2026, 10, 25, 12, 0); // 25 Nov 2026
  const newStore = (st) => P.createStore(st || fakeStorage(), { now: fixedNow });

  // ---- tiny test runner ----
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg || "not equal") + ": got " + A + ", expected " + B);
  }
  function ok(x, msg) { if (!x) throw new Error(msg || "expected true"); }
  function throws(fn, match) {
    try { fn(); } catch (e) {
      if (match && !String(e.message).includes(match)) throw new Error("wrong error: " + e.message);
      return;
    }
    throw new Error("expected an error");
  }

  // ---- first run / defaults ----
  test("first run creates the 6 subjects and 6 chores", () => {
    const st = fakeStorage();
    const d = newStore(st).load();
    eq(d.schemaVersion, P.SCHEMA_VERSION);
    eq(d.subjects.length, 6);
    eq(d.subjects[0].name, "Maths for Engineering 1");
    ok(d.subjects.every((s) => s.examDate >= "2027-01-21" && s.examDate <= "2027-02-07"), "exam dates in range");
    eq(d.chores.map((c) => [c.id, c.minDays, c.maxDays]), [
      ["hoovering", 5, 7], ["mopping", 10, 14], ["sheets", 7, 10],
      ["laundry", 6, 8], ["dishes", 1, 1], ["groceries", 3, 5],
    ]);
    ok(st.getItem("planner.data") !== null, "saved to storage");
  });

  test("data survives a reload", () => {
    const st = fakeStorage();
    newStore(st).addStudySession({ subjectId: "statics" });
    const d = newStore(st).load();
    eq(d.studySessions.length, 1);
    eq(d.studySessions[0].minutes, 45, "default block is 45 min");
    eq(d.studySessions[0].date, "2026-11-25", "defaults to today");
  });

  // ---- each entity ----
  test("exam date can be edited and confirmed", () => {
    const s = newStore();
    s.setExamDate("maths1", "2027-01-29", true);
    const m = s.get().subjects.find((x) => x.id === "maths1");
    eq([m.examDate, m.examDateConfirmed], ["2027-01-29", true]);
  });

  test("study minutes add up per subject and date range", () => {
    const s = newStore();
    s.addStudySession({ subjectId: "maths1", date: "2026-11-24" });
    s.addStudySession({ subjectId: "maths1", date: "2026-11-25" });
    s.addStudySession({ subjectId: "statics", minutes: 30, date: "2026-11-25" });
    eq(s.studyMinutes("maths1"), 90);
    eq(s.studyMinutes(null, "2026-11-25", "2026-11-25"), 75);
  });

  test("chore can be marked done", () => {
    const s = newStore();
    s.markChoreDone("laundry", "2026-11-20");
    eq(s.get().chores.find((c) => c.id === "laundry").lastDone, "2026-11-20");
  });

  test("gym, run and football are logged", () => {
    const s = newStore();
    s.addGym({ groups: ["push", "pull"], sets: { push: 9, pull: 6 } });
    s.addRun({ distanceKm: 5.2, durationMin: 31 });
    s.addFootball({ durationMin: 90 });
    eq(s.get().training.map((t) => t.type), ["gym", "run", "football"]);
  });

  test("whoop metrics and manual metrics are stored per day", () => {
    const s = newStore();
    s.setMetrics("2026-11-25", { recovery: 67, hrv: 82, rhr: 52, source: "whoop" });
    s.setMetrics("2026-11-24", { recovery: 30, source: "manual" });
    eq(s.getMetrics("2026-11-25"), { recovery: 67, hrv: 82, rhr: 52, source: "whoop" });
    eq(s.getMetrics("2026-11-24").hrv, null);
    eq(s.getMetrics("2026-11-23"), null);
  });

  test("daily check-offs toggle on and off", () => {
    const s = newStore();
    s.setChecked("2026-11-25", "chore:dishes", true);
    s.setChecked("2026-11-25", "chore:dishes", true); // twice = still once
    ok(s.isChecked("2026-11-25", "chore:dishes"));
    eq(s.get().checkoffs["2026-11-25"].length, 1);
    s.setChecked("2026-11-25", "chore:dishes", false);
    ok(!s.isChecked("2026-11-25", "chore:dishes"));
    eq(s.get().checkoffs, {}, "empty days are removed");
  });

  // ---- validation: bad data is refused and nothing changes ----
  test("invalid entries are refused and nothing is saved", () => {
    const st = fakeStorage();
    const s = newStore(st);
    s.load();
    const before = st.getItem("planner.data");
    throws(() => s.addStudySession({ subjectId: "history" }), "unknown subject");
    throws(() => s.addStudySession({ subjectId: "maths1", minutes: -5 }), "minutes");
    throws(() => s.addStudySession({ subjectId: "maths1", date: "2026-02-30" }), "bad date");
    throws(() => s.addGym({ groups: [] }), "at least one");
    throws(() => s.addGym({ groups: ["arms"] }), "push/pull/legs");
    throws(() => s.addGym({ groups: ["legs"], sets: { push: 3 } }), "isn't in groups");
    throws(() => s.addRun({ distanceKm: -1 }), "distanceKm");
    throws(() => s.setMetrics("2026-11-25", { recovery: 140 }), "recovery");
    throws(() => s.setMetrics("2026-11-25", { source: "manual" }), "at least one value");
    throws(() => s.setMetrics("2026-11-25", { hrv: 60, source: "fitbit" }), "source");
    throws(() => s.setChoreRange("mopping", 14, 10), "maxDays");
    throws(() => s.markChoreDone("ironing"), "not found");
    eq(st.getItem("planner.data"), before, "storage unchanged");
    eq(s.get().studySessions.length, 0, "memory unchanged");
  });

  test("storage full: error is reported and data in memory is rolled back", () => {
    const st = fakeStorage();
    const s = newStore(st);
    s.load();
    st.setItem = () => { throw new Error("QuotaExceededError"); };
    throws(() => s.addRun({ distanceKm: 3 }), "storage error");
    eq(s.get().training.length, 0);
  });

  // ---- corruption handling ----
  test("corrupt main copy: previous copy is restored, broken text is kept", () => {
    const st = fakeStorage();
    const s = newStore(st);
    s.addRun({ distanceKm: 3 });
    s.addRun({ distanceKm: 4 }); // now prev has 1 run, main has 2
    st.setItem("planner.data", "{this is not json");
    const s2 = newStore(st);
    const d = s2.load();
    eq(d.training.length, 1, "previous copy restored");
    ok(st.keys().some((k) => k.startsWith("planner.corrupt.")), "broken text kept");
    ok(s2.warnings.length > 0, "warning given");
    eq(st.getItem("planner.data.prev") !== "{this is not json", true, "broken copy not pushed into prev");
  });

  test("corrupt main and no previous copy: starts fresh but keeps broken text", () => {
    const st = fakeStorage({ "planner.data": "garbage" });
    const d = newStore(st).load();
    eq(d.subjects.length, 6);
    const k = st.keys().find((x) => x.startsWith("planner.corrupt."));
    eq(st.getItem(k), "garbage");
  });

  test("valid JSON but wrong shape is treated as corrupt", () => {
    const st = fakeStorage({ "planner.data": JSON.stringify({ schemaVersion: 1, subjects: "oops" }) });
    const s = newStore(st);
    eq(s.load().subjects.length, 6);
    ok(s.warnings.length > 0);
  });

  // ---- migrations ----
  test("old version is backed up, then migrated", () => {
    const old = P.defaultData();
    old.schemaVersion = 0;
    delete old.checkoffs; // pretend v0 didn't have check-offs
    const oldText = JSON.stringify(old);
    P.MIGRATIONS[0] = (d) => { d.checkoffs = {}; d.schemaVersion = 1; return d; };
    try {
      const st = fakeStorage({ "planner.data": oldText });
      const d = newStore(st).load();
      eq(d.schemaVersion, 1);
      eq(d.checkoffs, {});
      eq(st.getItem("planner.backup.v0"), oldText, "backup made before migrating");
      eq(JSON.parse(st.getItem("planner.data")).schemaVersion, 1, "migrated data saved");
    } finally {
      delete P.MIGRATIONS[0];
    }
  });

  test("data from a newer app version is not loaded over", () => {
    const future = P.defaultData();
    future.schemaVersion = 99;
    const st = fakeStorage({ "planner.data": JSON.stringify(future) });
    const s = newStore(st);
    s.load();
    ok(s.warnings.join(" ").length > 0);
    ok(st.keys().some((k) => k.startsWith("planner.corrupt.")), "newer data kept, not lost");
  });

  test("two copies of the app (e.g. two tabs) don't overwrite each other", () => {
    const st = fakeStorage();
    const tab1 = newStore(st), tab2 = newStore(st);
    tab1.load(); tab2.load();
    tab1.addRun({ distanceKm: 3 });
    tab2.addRun({ distanceKm: 4 });
    eq(tab1.get().training.map((t) => t.distanceKm), [3, 4]);
    ok(tab2.exportJSON().includes('"distanceKm": 3'), "export includes the other tab's change");
  });

  // ---- export / import ----
  test("export then import gives back the same data", () => {
    const a = newStore();
    a.addGym({ groups: ["legs"], sets: { legs: 4 } });
    a.setMetrics("2026-11-25", { recovery: 80, hrv: 90, rhr: 50, source: "whoop" });
    const file = a.exportJSON();
    const b = newStore();
    const res = b.checkImport(file);
    ok(res.ok, res.errors && res.errors.join("; "));
    eq(res.summary.training, 1);
    b.applyImport(res);
    eq(b.get(), a.get());
  });

  test("import refuses bad files and changes nothing", () => {
    const st = fakeStorage();
    const s = newStore(st);
    s.addRun({ distanceKm: 2 });
    const before = st.getItem("planner.data");
    ok(!s.checkImport("not json").ok);
    ok(!s.checkImport(JSON.stringify({ hello: 1 })).ok, "wrong app");
    const bad = JSON.parse(s.exportJSON());
    bad.data.training[0].distanceKm = "far";
    const r = s.checkImport(JSON.stringify(bad));
    ok(!r.ok && r.errors[0].includes("distanceKm"), "invalid content caught");
    throws(() => s.applyImport(r));
    eq(st.getItem("planner.data"), before);
  });

  test("import keeps a safety copy and can be undone", () => {
    const st = fakeStorage();
    const s = newStore(st);
    s.addRun({ distanceKm: 7 });
    const mine = s.get();
    const other = newStore();
    s.applyImport(s.checkImport(other.exportJSON()));
    eq(s.get().training.length, 0);
    s.undoImport();
    eq(s.get(), mine);
  });

  test("importBackupFile asks first and does nothing if cancelled", async () => {
    const s = newStore();
    s.addRun({ distanceKm: 7 });
    const file = { text: () => Promise.resolve(newStore().exportJSON()) };
    let asked = "";
    const msg = await P.importBackupFile(s, file, (m) => { asked = m; return false; });
    ok(asked.includes("Replace ALL"), "confirmation shown");
    ok(msg.includes("cancelled"));
    eq(s.get().training.length, 1, "nothing changed");
    const msg2 = await P.importBackupFile(s, file, () => true);
    eq(msg2, "Backup imported.");
    eq(s.get().training.length, 0);
  });

  // ---- run ----
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
      .then(({ passed, failed }) => {
        console.log("\n" + passed + " passed, " + failed + " failed");
        process.exitCode = failed ? 1 : 0;
      });
  } else {
    window.runDataTests = run;
  }
})();
