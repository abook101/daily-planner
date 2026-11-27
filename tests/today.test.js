// Tests for js/today.js (timer, undo, low energy, week tally, number inputs).
//
// Run them either way, no installs needed:
//   - Browser: start the local server (see README) and open http://localhost:8000/tests/
//   - Node (if installed):  node tests/today.test.js
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;
  const T = isNode ? require("../js/today.js") : window.PlannerToday;

  function fakeStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
  const TODAY = "2026-11-25";
  const NOW = new Date(2026, 10, 25, 12, 0).getTime();
  const MIN = 60000;
  const newStore = (st) => P.createStore(st, { now: () => new Date(NOW) });

  // ---- tiny test runner (same as the other test files) ----
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

  // =================== numbers ===================
  test("number inputs: empty, dot, comma, junk", () => {
    eq(T.parseNum(""), null);
    eq(T.parseNum("  "), null);
    eq(T.parseNum("72"), 72);
    eq(T.parseNum("4.5"), 4.5);
    eq(T.parseNum("4,5"), 4.5, "German-style comma works");
    ok(Number.isNaN(T.parseNum("abc")), "junk is NaN");
    ok(Number.isNaN(T.parseNum("5km")), "units are not accepted");
  });

  // =================== timer ===================
  const block = { blockKey: "study:maths1:1", subjectId: "maths1", subjectName: "Maths", minutes: 45, date: TODAY };

  test("timer survives a reload (only the start time is saved)", () => {
    const st = fakeStorage();
    T.startTimer(st, block, NOW);
    // "reload": read it back from storage 20 minutes later
    const t = T.getTimer(st);
    eq(t.subjectId, "maths1");
    eq(T.elapsedMs(t, NOW + 20 * MIN), 20 * MIN);
    eq(T.formatClock(T.elapsedMs(t, NOW + 20 * MIN + 5000)), "20:05");
    eq(T.formatClock(62 * MIN + 3000), "1:02:03");
  });

  test("only one timer at a time; cancel clears it", () => {
    const st = fakeStorage();
    T.startTimer(st, block, NOW);
    throws(() => T.startTimer(st, block, NOW), "already running");
    T.cancelTimer(st);
    eq(T.getTimer(st), null);
  });

  test("minutes to log: real time, at least 1, forgot-to-stop protection", () => {
    const t = Object.assign({ startedAt: NOW }, block);
    eq(T.minutesToLog(t, NOW + 44 * MIN + 40000).minutes, 45, "rounds to nearest minute");
    eq(T.minutesToLog(t, NOW + 10000).minutes, 1, "at least 1 minute");
    eq(T.minutesToLog(t, NOW + 80 * MIN).minutes, 80, "a long session is fine");
    const forgot = T.minutesToLog(t, NOW + 5 * 60 * MIN);
    eq([forgot.minutes, forgot.forgot, forgot.real], [45, true, 300], "5 h = forgot, log the block");
  });

  test("broken timer data is ignored instead of crashing", () => {
    const st = fakeStorage();
    st.setItem(T.KEYS.TIMER_KEY, "{not json");
    eq(T.getTimer(st), null);
  });

  // =================== undo ===================
  test("undo puts back exactly what was there before the last log", () => {
    const st = fakeStorage();
    const store = newStore(st);
    store.addGym({ groups: ["pull"] });
    const before = JSON.stringify(store.get());
    T.withUndo(store, st, "Gym (Push)", () => store.addGym({ groups: ["push"] }), NOW);
    eq(store.get().training.length, 2);
    eq(T.getUndo(st, NOW).label, "Gym (Push)");
    eq(T.undoLast(store, st, NOW + MIN), "Gym (Push)");
    eq(JSON.stringify(store.get()), before);
    eq(T.getUndo(st, NOW), null, "can't undo twice");
    throws(() => T.undoLast(store, st, NOW), "Nothing to undo");
  });

  test("undo works for chores, study and metrics too", () => {
    const st = fakeStorage();
    const store = newStore(st);
    T.withUndo(store, st, "Dishes", () => store.markChoreDone("dishes"), NOW);
    T.undoLast(store, st, NOW);
    eq(store.get().chores.find((c) => c.id === "dishes").lastDone, null);
    T.withUndo(store, st, "Study", () => {
      store.addStudySession({ subjectId: "statics", minutes: 45 });
      store.setChecked(TODAY, "study:statics:1", true);
    }, NOW);
    T.undoLast(store, st, NOW);
    eq(store.get().studySessions.length, 0);
    eq(store.isChecked(TODAY, "study:statics:1"), false, "check-off undone with it");
  });

  test("undo refuses if something else changed the data since", () => {
    const st = fakeStorage();
    const store = newStore(st);
    T.withUndo(store, st, "Run", () => store.addRun({ distanceKm: 5 }), NOW);
    store.setMetrics(TODAY, { recovery: 70, source: "whoop" }); // e.g. Whoop sync
    throws(() => T.undoLast(store, st, NOW), "data changed");
    eq(store.get().training.length, 1, "run kept");
    eq(store.getMetrics(TODAY).recovery, 70, "whoop data kept");
  });

  test("undo expires after 12 hours", () => {
    const st = fakeStorage();
    const store = newStore(st);
    T.withUndo(store, st, "Run", () => store.addRun({}), NOW);
    ok(T.getUndo(st, NOW + 11 * 60 * MIN), "still there after 11 h");
    eq(T.getUndo(st, NOW + 13 * 60 * MIN), null);
  });

  test("a failed log doesn't replace the previous undo", () => {
    const st = fakeStorage();
    const store = newStore(st);
    T.withUndo(store, st, "Run", () => store.addRun({}), NOW);
    throws(() => T.withUndo(store, st, "Bad", () => store.addRun({ distanceKm: -3 }), NOW), "Not saved");
    eq(T.getUndo(st, NOW).label, "Run");
  });

  // =================== low energy ===================
  test("low energy mode only lasts for the day it was switched on", () => {
    const st = fakeStorage();
    eq(T.isLowEnergy(st, TODAY), false);
    T.setLowEnergy(st, TODAY, true);
    eq(T.isLowEnergy(st, TODAY), true);
    eq(T.isLowEnergy(st, "2026-11-26"), false, "off again tomorrow");
    T.setLowEnergy(st, TODAY, false);
    eq(T.isLowEnergy(st, TODAY), false);
  });

  // =================== week tally ===================
  test("week tally counts Monday to today, today included", () => {
    const st = fakeStorage();
    const store = newStore(st);
    store.addGym({ groups: ["push", "pull"], date: "2026-11-22" });            // last week (Sunday)
    store.addGym({ groups: ["push"], sets: { push: 4 }, date: "2026-11-23" });
    store.addGym({ groups: ["pull", "legs"], sets: { pull: 3, legs: 2 }, date: TODAY }); // legs < 3 sets
    store.addRun({ date: "2026-11-24" });
    store.addFootball({ date: TODAY });
    const w = T.weekTally(store.get().training, TODAY);
    eq(w.groups, { push: 1, pull: 1, legs: 0 });
    eq(w.targets, { push: 2, pull: 2, legs: 1 });
    eq([w.gymSessions, w.runs, w.football], [2, 1, 1]);
  });

  // =================== small text helpers ===================
  test("short subject names and readable errors", () => {
    eq(T.shortName("maths1", "Maths for Engineering 1"), "Maths 1");
    eq(T.shortName("x", "A very long subject name"), "A very long s…");
    eq(T.friendlyError(new Error("Not saved: metrics[2026-11-25]: recovery must be 0–100")), "Not saved: recovery must be 0–100");
  });

  test("study logged: lists every session today (incl. self-logged), week per subject", () => {
    const st = newStore(fakeStorage());
    st.addStudySession({ subjectId: "statics", minutes: 45 });                       // "Log other study"
    st.addStudySession({ subjectId: "maths1", minutes: 50 });                        // a suggested block
    st.addStudySession({ subjectId: "statics", minutes: 30, date: "2026-11-23" });   // Monday, same week
    st.addStudySession({ subjectId: "maths1", minutes: 60, date: "2026-11-22" });    // Sunday before: not this week
    const r = T.studyLogged(st.get(), TODAY);
    eq(r.today.map((s) => [s.subjectId, s.minutes]), [["statics", 45], ["maths1", 50]]);
    ok(r.today.every((s) => s.id && s.subjectName && s.subjectName !== s.subjectId), "has ids and names");
    eq(r.todayMinutes, 95);
    eq(r.week.map((w) => [w.subjectId, w.minutes]), [["statics", 75], ["maths1", 50]]);
    eq(r.weekMinutes, 125);
  });

  test("study logged: empty when nothing logged", () => {
    const r = T.studyLogged(newStore(fakeStorage()).get(), TODAY);
    eq([r.today, r.week, r.todayMinutes, r.weekMinutes], [[], [], 0, 0]);
  });

  test("removing a study session can be undone", () => {
    const ls = fakeStorage(), st = newStore(fakeStorage());
    const s = st.addStudySession({ subjectId: "statics", minutes: 45 });
    T.withUndo(st, ls, "Removed", () => st.deleteStudySession(s.id), NOW);
    eq(T.studyLogged(st.get(), TODAY).today.length, 0);
    T.undoLast(st, ls, NOW + MIN);
    eq(T.studyLogged(st.get(), TODAY).today.map((x) => x.id), [s.id]);
  });

  test("formatMinutes", () => {
    eq(T.formatMinutes(45), "45 min");
    eq(T.formatMinutes(120), "2 h");
    eq(T.formatMinutes(95), "1 h 35 min");
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
    window.runTodayTests = run_;
  }
})();
