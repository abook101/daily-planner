// Tests for the Settings screen logic (step 5): editing subjects, chores,
// weekly training targets and the study block length, and that the daily
// plan really uses the saved settings.
//
// Run them either way, no installs needed:
//   - Browser: start the local server (see README) and open http://localhost:8000/tests/
//   - Node (if installed):  node tests/settings.test.js
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;
  const L = isNode ? require("../js/plan.js") : window.PlannerLogic;
  const T = isNode ? require("../js/today.js") : window.PlannerToday;

  function fakeStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
  const TODAY = "2026-11-25"; // a Wednesday
  const newStore = () => P.createStore(fakeStorage(), { now: () => new Date(2026, 10, 25, 12, 0) });

  // ---- tiny test runner (same as the other test files) ----
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg || "not equal") + ": got " + A + ", expected " + B);
  }
  function ok(x, msg) { if (!x) throw new Error(msg || "expected true"); }
  // Expects a "Not saved" error AND that the saved data didn't change at all.
  function refused(store, fn, match) {
    const before = JSON.stringify(store.get());
    try { fn(); } catch (e) {
      if (match && !String(e.message).includes(match)) throw new Error("wrong error: " + e.message);
      eq(JSON.stringify(store.get()), before, "data must be unchanged");
      return;
    }
    throw new Error("expected it to be refused");
  }

  // =================== defaults ===================
  test("new data has the default settings (45 min, gym 3–4, 2/2/1, 2 runs)", () => {
    const s = newStore().getSettings();
    eq(s, { studyBlockMin: 45, gymMin: 3, gymMax: 4, push: 2, pull: 2, legs: 1, runs: 2 });
  });

  test("data saved before step 5 (no settings) still loads and uses the defaults", () => {
    const d = P.defaultData();
    delete d.settings;
    eq(P.validateData(d), [], "old data is still valid");
    eq(P.settingsOf(d).studyBlockMin, 45);
    eq(L.planDay(d, TODAY).study.blocks[0].minutes, 45);
  });

  // =================== subjects ===================
  test("subject: rename, change exam date and confirm it; logged study is kept", () => {
    const store = newStore();
    store.addStudySession({ subjectId: "statics", minutes: 30 });
    store.updateSubject("statics", { name: "  Statics   (Mechanics 1) ", examDate: "2027-02-03", examDateConfirmed: true });
    const s = store.get().subjects.find((x) => x.id === "statics");
    eq([s.name, s.examDate, s.examDateConfirmed], ["Statics (Mechanics 1)", "2027-02-03", true]);
    eq(store.subjectUsage("statics"), { sessions: 1, minutes: 30 }, "sessions follow the subject id, not its name");
  });

  test("subject: exam date can be cleared (not known yet)", () => {
    const store = newStore();
    store.updateSubject("maths1", { name: "Maths for Engineering 1", examDate: "", examDateConfirmed: false });
    eq(store.get().subjects[0].examDate, null);
  });

  test("subject: bad input is refused and nothing changes", () => {
    const store = newStore();
    refused(store, () => store.updateSubject("maths1", { name: "   ", examDate: "2027-01-21" }), "can't be empty");
    refused(store, () => store.updateSubject("maths1", { name: "Statics", examDate: "2027-01-21" }), "already a subject called");
    refused(store, () => store.updateSubject("maths1", { name: "Maths", examDate: "2027-02-30" }), "real date");
    refused(store, () => store.updateSubject("maths1", { name: "Maths", examDate: null, examDateConfirmed: true }), "before marking it confirmed");
    refused(store, () => store.updateSubject("maths1", { name: "x".repeat(61), examDate: null }), "too long");
  });

  test("subject: add one; it gets a readable id and shows up in the plan", () => {
    const store = newStore();
    const s = store.addSubject({ name: "Fluid Mechanics", examDate: "2026-12-01", examDateConfirmed: true });
    eq(s.id, "fluid-mechanics");
    eq(store.addSubject({ name: "Fluid mechanics 2" }).id, "fluid-mechanics-2");
    const plan = L.planDay(store.get(), TODAY);
    eq(plan.study.blocks[0].subjectId, "fluid-mechanics", "6 days away = most urgent");
    refused(store, () => store.addSubject({ name: "fluid MECHANICS" }), "already a subject called");
  });

  test("subject: remove says how much is logged, and removes it with its sessions", () => {
    const store = newStore();
    store.addStudySession({ subjectId: "energy", minutes: 45 });
    store.addStudySession({ subjectId: "energy", minutes: 20 });
    store.addStudySession({ subjectId: "maths1", minutes: 45 });
    eq(store.subjectUsage("energy"), { sessions: 2, minutes: 65 });
    eq(store.removeSubject("energy"), { removedSessions: 2 });
    const d = store.get();
    eq(d.subjects.length, 5);
    eq(d.studySessions.map((s) => s.subjectId), ["maths1"], "other subjects' sessions untouched");
    refused(store, () => store.removeSubject("energy"), "not found");
  });

  test("subject removal can be undone (sessions come back)", () => {
    const st = fakeStorage();
    const store = P.createStore(st, { now: () => new Date(2026, 10, 25, 12, 0) });
    store.addStudySession({ subjectId: "energy", minutes: 45 });
    const now = Date.now();
    T.withUndo(store, st, "Removed Energy", () => store.removeSubject("energy"), now);
    eq(store.get().subjects.length, 5);
    T.undoLast(store, st, now + 1000);
    eq(store.get().subjects.length, 6);
    eq(store.subjectUsage("energy").minutes, 45);
  });

  // =================== chores ===================
  test("chore: edit name, min/max days and set 'last done' by hand", () => {
    const store = newStore();
    store.updateChore("mopping", { name: "Mop floors", minDays: 7, maxDays: 10, lastDone: "2026-11-20" });
    const c = store.get().chores.find((x) => x.id === "mopping");
    eq([c.name, c.minDays, c.maxDays, c.lastDone], ["Mop floors", 7, 10, "2026-11-20"]);
    const st = L.choreStatus(c, TODAY);
    eq(st.status, "not-due", "5 days ago, every 7–10 days");
    store.updateChore("mopping", { name: "Mop floors", minDays: 7, maxDays: 10, lastDone: "" });
    eq(store.get().chores.find((x) => x.id === "mopping").lastDone, null, "empty = not logged yet");
  });

  test("chore: bad input is refused and nothing changes", () => {
    const store = newStore();
    const ok_ = { name: "Laundry", minDays: 6, maxDays: 8, lastDone: null };
    const bad = (change) => Object.assign({}, ok_, change);
    refused(store, () => store.updateChore("laundry", bad({ minDays: 9 })), "can't be smaller");
    refused(store, () => store.updateChore("laundry", bad({ minDays: 0 })), "1 to 365");
    refused(store, () => store.updateChore("laundry", bad({ maxDays: 2.5 })), "1 to 365");
    refused(store, () => store.updateChore("laundry", bad({ maxDays: NaN })), "1 to 365");
    refused(store, () => store.updateChore("laundry", bad({ lastDone: "2026-11-26" })), "future");
    refused(store, () => store.updateChore("laundry", bad({ lastDone: "26.11.2026" })), "real date");
    refused(store, () => store.updateChore("laundry", bad({ name: "Dishes" })), "already a chore called");
  });

  test("chore: add and remove", () => {
    const store = newStore();
    const c = store.addChore({ name: "Clean bathroom", minDays: 7, maxDays: 10 });
    eq([c.id, c.lastDone], ["clean-bathroom", null]);
    ok(L.planDay(store.get(), TODAY).chores.all.some((x) => x.choreId === "clean-bathroom"), "in the plan");
    store.removeChore("clean-bathroom");
    eq(store.get().chores.length, 6);
    refused(store, () => store.addChore({ name: "Windows", minDays: 30, maxDays: 20 }), "can't be smaller");
  });

  // =================== training targets + study block ===================
  test("settings: valid changes are saved", () => {
    const store = newStore();
    store.setSettings({ gymMin: 2, gymMax: 3, push: 1, pull: 1, legs: 1, runs: 3, studyBlockMin: 50 });
    eq(store.getSettings(), { studyBlockMin: 50, gymMin: 2, gymMax: 3, push: 1, pull: 1, legs: 1, runs: 3 });
  });

  test("settings: invalid values are refused with a readable reason, nothing changes", () => {
    const store = newStore();
    refused(store, () => store.setSettings({ gymMin: 5, gymMax: 4 }), "can't be less than min");
    refused(store, () => store.setSettings({ push: 5 }), "Push 5x a week needs at least 5 gym sessions");
    refused(store, () => store.setSettings({ studyBlockMin: 5 }), "Study block length");
    refused(store, () => store.setSettings({ studyBlockMin: 45.5 }), "whole number");
    refused(store, () => store.setSettings({ runs: -1 }), "Runs per week");
    refused(store, () => store.setSettings({ runs: NaN }), "Runs per week");
    refused(store, () => store.setSettings({ colour: "red" }), "unknown setting");
  });

  test("broken settings in a backup file are refused on import", () => {
    const store = newStore();
    const d = P.defaultData();
    d.settings.gymMax = 0;
    const res = store.checkImport(JSON.stringify({ app: "daily-planner", data: d }));
    eq(res.ok, false);
  });

  test("plan uses the saved study block length (timer, log button, default log)", () => {
    const store = newStore();
    store.setSettings({ studyBlockMin: 30 });
    eq(L.planDay(store.get(), TODAY).study.blocks.map((b) => b.minutes), [30, 30]);
    store.addStudySession({ subjectId: "maths1" });
    eq(store.get().studySessions[0].minutes, 30, "a session logged without minutes = one block");
  });

  test("plan uses the saved training targets", () => {
    const store = newStore();
    // Mon: Push+Pull, Tue: Legs. With the defaults (Push 2, Pull 2) gym is still needed.
    store.addGym({ groups: ["push", "pull"], date: "2026-11-23" });
    store.addGym({ groups: ["legs"], date: "2026-11-24" });
    let s = L.planDay(store.get(), TODAY).training;
    eq(s.type, "gym", "defaults: still behind on Push/Pull");
    ok(s.reason.includes("gym 2 of 3–4"), s.reason);
    // Lower the targets: 2 sessions, 1x each group -> gym target met -> run.
    store.setSettings({ gymMin: 2, gymMax: 3, push: 1, pull: 1, legs: 1 });
    s = L.planDay(store.get(), TODAY).training;
    eq(s.type, "run", "targets met, so a run");
    ok(s.reason.includes("Push 1/1") && s.reason.includes("gym 2 of 2–3"), s.reason);
    // Runs target 0 too: everything met (no Whoop data today) -> rest.
    store.setSettings({ runs: 0 });
    s = L.planDay(store.get(), TODAY).training;
    eq(s.type, "rest");
    ok(s.reason.includes("targets are all met"), s.reason);
  });

  test("Today screen tally shows the saved targets", () => {
    const store = newStore();
    store.setSettings({ gymMin: 2, gymMax: 5, push: 3, runs: 4 });
    const d = store.get();
    const w = T.weekTally(d.training, TODAY, d.settings);
    eq([w.targets.push, w.gymMin, w.gymMax, w.cardioTarget], [3, 2, 5, 4]);
    eq(T.weekTally(d.training, TODAY).targets.push, 2, "no settings given = defaults");
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
    window.runSettingsTests = run_;
  }
})();
