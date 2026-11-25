// Tests for js/plan.js (the daily plan logic).
//
// Run them either way, no installs needed:
//   - Browser: start the local server (see README) and open http://localhost:8000/tests/
//   - Node (if installed):  node tests/plan.test.js
//
// Today in most tests is Wednesday 25 Nov 2026 (week started Monday 23 Nov).
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;
  const L = isNode ? require("../js/plan.js") : window.PlannerLogic;

  const TODAY = "2026-11-25";

  // ---- building test data ----
  // Starts from the app's real default data, applies changes, and checks the
  // result with the data layer's own validator, so the tests only use data
  // the app could really have saved.
  function make(change) {
    const d = P.defaultData();
    if (change) change(d);
    const errors = P.validateData(d);
    if (errors.length) throw new Error("bad test data: " + errors.join("; "));
    return d;
  }
  let n = 0;
  const id = () => "x" + (n++);
  const study = (subjectId, date, minutes) => ({ id: id(), subjectId, date, minutes: minutes || 45 });
  const gym = (date, groups, sets) => ({ id: id(), date, type: "gym", groups, sets: sets || null, durationMin: null, notes: "" });
  const run = (date) => ({ id: id(), date, type: "run", distanceKm: 5, durationMin: 30, notes: "" });
  const football = (date) => ({ id: id(), date, type: "football", durationMin: 90, notes: "" });
  const metric = (recovery, hrv, rhr) => ({ recovery, hrv, rhr, source: "manual" });
  // 7 normal days before `today`: HRV 60 ms, resting HR 55.
  function baseline(d, today) {
    for (let i = 1; i <= 7; i++) d.metrics[L.addDays(today || TODAY, -i)] = metric(60, 60, 55);
  }
  const chore = (d, choreId) => d.chores.find((c) => c.id === choreId);
  const setAllChoresDone = (d, date) => d.chores.forEach((c) => { c.lastDone = date; });

  // ---- tiny test runner (same as data.test.js) ----
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg || "not equal") + ": got " + A + ", expected " + B);
  }
  function ok(x, msg) { if (!x) throw new Error(msg || "expected true"); }
  const has = (text, part) => ok(String(text).includes(part), "expected '" + text + "' to contain '" + part + "'");

  // =================== dates ===================
  test("date maths: days between, add days, week starts Monday", () => {
    eq(L.daysBetween("2026-11-25", "2027-01-21"), 57);
    eq(L.addDays("2026-12-31", 1), "2027-01-01");
    eq(L.addDays("2027-03-28", 1), "2027-03-29", "daylight saving day is still 1 day");
    eq(L.weekStart("2026-11-25"), "2026-11-23");
    eq(L.weekStart("2026-11-29"), "2026-11-23", "Sunday belongs to the week before");
    eq(L.weekStart("2026-11-30"), "2026-11-30");
  });

  // =================== exams + study ===================
  test("exam countdown: days left, closest first", () => {
    const c = L.examCountdown(make().subjects, TODAY);
    eq(c[0].subjectId, "maths1");
    eq(c[0].daysLeft, 57);
    eq(c[0].label, "57 days left");
    eq(c[5].subjectId, "programming");
  });

  test("exam countdown: today / tomorrow / done / no date", () => {
    const d = make((d) => { d.subjects[5].examDate = null; });
    const c = L.examCountdown(d.subjects, "2027-01-24");
    const by = (sid) => c.find((x) => x.subjectId === sid);
    eq(by("maths1").label, "Exam done");
    eq(by("mechdesign").label, "Exam tomorrow");
    eq(by("programming").label, "No exam date yet");
    eq(c[c.length - 1].subjectId, "programming", "no date goes last");
    eq(L.examCountdown(d.subjects, "2027-01-25").find((x) => x.subjectId === "mechdesign").label, "Exam today");
  });

  test("study: 2 blocks of 45 min, closest exams first when nothing studied", () => {
    const s = L.suggestStudy(make(), TODAY);
    eq(s.blocks.map((b) => b.subjectId), ["maths1", "mechdesign"]);
    eq(s.blocks.map((b) => b.minutes), [45, 45]);
    eq(s.blocks.map((b) => b.key), ["study:maths1:1", "study:mechdesign:2"]);
    has(s.blocks[0].reason, "Exam in 57 days (21 Jan, date not final)");
    has(s.blocks[0].reason, "nothing logged in the last 2 weeks");
  });

  test("study: a subject studied a lot recently drops behind", () => {
    const d = make((d) => {
      for (let i = 1; i <= 8; i++) d.studySessions.push(study("maths1", L.addDays(TODAY, -i), 75));
    });
    const s = L.suggestStudy(d, TODAY);
    eq(s.blocks.map((b) => b.subjectId), ["mechdesign", "electrical"]);
  });

  test("study: sessions older than 2 weeks don't count as 'recent'", () => {
    const d = make((d) => { d.studySessions.push(study("maths1", L.addDays(TODAY, -15), 600)); });
    eq(L.suggestStudy(d, TODAY).blocks[0].subjectId, "maths1");
  });

  test("study: logging a block today doesn't reshuffle today's plan", () => {
    const before = L.suggestStudy(make(), TODAY);
    const d = make((d) => { d.studySessions.push(study("maths1", TODAY, 300)); });
    eq(L.suggestStudy(d, TODAY).blocks, before.blocks);
  });

  test("study: closest exam wins near the end even if studied a lot", () => {
    // 5 days before maths, 10 hours of maths in the last 2 weeks, statics untouched.
    const d = make((d) => {
      for (let i = 1; i <= 10; i++) d.studySessions.push(study("maths1", L.addDays("2027-01-16", -i), 60));
    });
    eq(L.suggestStudy(d, "2027-01-16").blocks[0].subjectId, "maths1");
  });

  test("study: exam within 3 days → both blocks on that subject", () => {
    const s = L.suggestStudy(make(), "2027-01-19");
    eq(s.blocks.map((b) => b.subjectId), ["maths1", "maths1"]);
    has(s.blocks[0].reason, "both blocks go here");
  });

  test("study: finished exams are not suggested; all done → no blocks", () => {
    const s = L.suggestStudy(make(), "2027-01-22");
    ok(!s.blocks.some((b) => b.subjectId === "maths1"), "maths is over");
    const after = L.suggestStudy(make(), "2027-02-08");
    eq(after.blocks, []);
    has(after.reason, "No upcoming exams");
  });

  test("study: subject without exam date still gets suggested when it's the only one", () => {
    const d = make((d) => { d.subjects.forEach((s) => { s.examDate = null; }); });
    const s = L.suggestStudy(d, TODAY);
    eq(s.blocks.length, 2);
    has(s.blocks[0].reason, "No exam date set");
  });

  // =================== chores ===================
  test("chore status boundaries (hoovering: every 5–7 days)", () => {
    const c = (daysAgo) => L.choreStatus({ minDays: 5, maxDays: 7, lastDone: L.addDays(TODAY, -daysAgo) }, TODAY);
    eq(c(4).status, "not-due");
    eq(c(4).label, "Next in 1 day");
    eq(c(5).status, "due-soon");
    eq(c(7).status, "due-soon");
    eq(c(7).label, "Due today");
    eq(c(8).status, "overdue");
    eq(c(10).label, "3 days overdue");
    eq(c(0).status, "done-today");
    eq(L.choreStatus({ minDays: 5, maxDays: 7, lastDone: null }, TODAY).status, "never");
  });

  test("chore with a date in the future (wrong clock) counts as done, not broken", () => {
    eq(L.choreStatus({ minDays: 5, maxDays: 7, lastDone: "2026-12-01" }, TODAY).status, "done-today");
  });

  test("chores: dishes always; most overdue first; 2nd only if overdue", () => {
    const d = make((d) => {
      setAllChoresDone(d, L.addDays(TODAY, -1));
      chore(d, "hoovering").lastDone = L.addDays(TODAY, -12); // 12/7 = 1.7x its limit
      chore(d, "mopping").lastDone = L.addDays(TODAY, -20);   // 20/14 = 1.4x
      chore(d, "laundry").lastDone = L.addDays(TODAY, -7);    // due, not overdue
    });
    const s = L.suggestChores(d, TODAY);
    eq(s.chores.map((c) => c.choreId), ["dishes", "hoovering", "mopping"]);
    has(s.chores[1].reason, "Last done 12 days ago (every 5–7 days): overdue.");

    // Only one overdue → it, but not the merely-due laundry as well
    chore(d, "mopping").lastDone = L.addDays(TODAY, -2);
    eq(L.suggestChores(d, TODAY).chores.map((c) => c.choreId), ["dishes", "hoovering"]);

    // Nothing overdue → just the one most due
    chore(d, "hoovering").lastDone = L.addDays(TODAY, -2);
    eq(L.suggestChores(d, TODAY).chores.map((c) => c.choreId), ["dishes", "laundry"]);
  });

  test("chores: nothing due → only dishes", () => {
    const d = make((d) => setAllChoresDone(d, L.addDays(TODAY, -1)));
    const s = L.suggestChores(d, TODAY);
    eq(s.chores.map((c) => c.choreId), ["dishes"]);
    has(s.reason, "Nothing else is due");
  });

  test("chores: a chore already done today takes the slot and shows as done", () => {
    const d = make((d) => {
      setAllChoresDone(d, L.addDays(TODAY, -1));
      chore(d, "sheets").lastDone = TODAY;
      chore(d, "dishes").lastDone = TODAY;
      chore(d, "hoovering").lastDone = L.addDays(TODAY, -6); // due, not overdue
    });
    const s = L.suggestChores(d, TODAY);
    eq(s.chores.map((c) => [c.choreId, c.done]), [["dishes", true], ["sheets", true]]);
  });

  test("chores: first run (nothing logged) → dishes + one to start tracking", () => {
    const s = L.suggestChores(make(), TODAY);
    eq(s.chores.map((c) => c.choreId), ["dishes", "groceries"]);
    has(s.chores[1].reason, "Not logged yet");
  });

  // =================== training: recovery ===================
  test("recovery zones follow Whoop colours (67+ green, 34–66 yellow, <34 red)", () => {
    const z = (r) => L.assessRecovery({ [TODAY]: metric(r, null, null) }, TODAY).zone;
    eq([z(100), z(67), z(66), z(34), z(33), z(0)], ["green", "green", "yellow", "yellow", "red", "red"]);
  });

  test("red recovery → rest", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(25, 55, 56); });
    const t = L.suggestTraining(d, TODAY);
    eq(t.type, "rest");
    has(t.reason, "Recovery 25% (red)");
  });

  test("yellow recovery → easy zone-2 run", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(50, 58, 55); });
    const t = L.suggestTraining(d, TODAY);
    eq(t.type, "run");
    eq(t.label, "Easy zone-2 run");
  });

  test("green but HRV 20% below 7-day average → rest", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(80, 48, 55); });
    const t = L.suggestTraining(d, TODAY);
    eq(t.type, "rest");
    has(t.reason, "HRV 48 ms is 20% below your 7-day average (60 ms)");
  });

  test("green but resting HR 6 bpm high → downgraded to yellow → run", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(80, 60, 61); });
    const t = L.suggestTraining(d, TODAY);
    eq(t.recovery.zone, "yellow");
    eq(t.type, "run");
    has(t.reason, "green → yellow");
  });

  test("no recovery % but HRV vs average is enough to judge", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(null, 62, null); });
    eq(L.suggestTraining(d, TODAY).recovery.zone, "green");
    d.metrics[TODAY] = metric(null, 55, null); // 8% below: not "well below", but not great
    eq(L.suggestTraining(d, TODAY).recovery.zone, "yellow");
  });

  test("HRV without enough history (under 3 days) isn't compared", () => {
    const d = make((d) => { d.metrics[L.addDays(TODAY, -1)] = metric(60, 80, 50); d.metrics[TODAY] = metric(null, 40, null); });
    eq(L.assessRecovery(d.metrics, TODAY).zone, null);
  });

  // =================== training: gym focus + weekly targets ===================
  test("green, empty week (Wed) → gym, Push + Pull combined to fit 5 group-sessions into 4", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(80, 62, 54); });
    const t = L.suggestTraining(d, TODAY);
    eq(t.type, "gym");
    eq(t.focus, ["push", "pull"]);
    eq(t.label, "Gym: Upper body (Push + Pull)");
    has(t.reason, "This week: Push 0/2, Pull 0/2, Legs 0/1; gym 0 of 3–4; cardio 0/2.");
  });

  test("green → gym on the group furthest behind", () => {
    // Thursday; done Push x2 and Legs x1 this week → Pull is behind.
    const d = make((d) => {
      baseline(d, "2026-11-26");
      d.metrics["2026-11-26"] = metric(75, 61, 55);
      d.training.push(gym("2026-11-23", ["push", "legs"]), gym("2026-11-25", ["push"]));
    });
    const t = L.suggestTraining(d, "2026-11-26");
    eq(t.type, "gym");
    eq(t.focus, ["pull"]);
    eq(t.label, "Gym: Pull (back, biceps)");
    has(t.reason, "Pull is furthest behind");
  });

  test("ties go to the group trained longest ago", () => {
    const wp = L.weeklyProgress([gym("2026-11-23", ["pull"]), gym("2026-11-24", ["push"])], "2026-11-25");
    // push 1/2 and pull 1/2 (both 1 behind) but legs 0/1 also 1 behind; legs never trained → first
    eq(L.pickGymFocus(Object.assign({}, wp, { daysLeftInWeek: 5, gymSessions: 0 })).groups, ["legs"]);
  });

  test("a group with fewer than 3 sets doesn't count", () => {
    const wp = L.weeklyProgress([gym("2026-11-23", ["push", "pull"], { push: 4, pull: 2 })], TODAY);
    eq(wp.groups, { push: 1, pull: 0, legs: 0 });
  });

  test("last week's sessions don't count towards this week", () => {
    const wp = L.weeklyProgress([gym("2026-11-22", ["push"]), run("2026-11-22"), gym("2026-11-23", ["legs"])], TODAY);
    eq([wp.gymSessions, wp.groups.push, wp.groups.legs, wp.runs], [1, 0, 1, 0]);
  });

  test("weekly gym target met → run instead; cardio also met → optional easy run", () => {
    const d = make((d) => {
      d.metrics["2026-11-27"] = metric(85, null, null);
      d.training.push(gym("2026-11-23", ["push", "pull"]), gym("2026-11-24", ["legs"]), gym("2026-11-25", ["push", "pull"]));
    });
    const t = L.suggestTraining(d, "2026-11-27");
    eq(t.type, "run");
    has(t.reason, "Weekly gym target met");
    d.training.push(run("2026-11-26"), football("2026-11-24"));
    eq(L.suggestTraining(d, "2026-11-27").label, "Optional easy run");
  });

  test("football counts as cardio", () => {
    const wp = L.weeklyProgress([football("2026-11-23"), run("2026-11-24")], TODAY);
    eq([wp.cardio, wp.cardioMet], [2, true]);
  });

  test("already 4 gym sessions this week → no 5th, run instead", () => {
    const d = make((d) => {
      d.metrics["2026-11-28"] = metric(90, null, null);
      ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"].forEach((x) => d.training.push(gym(x, ["push"])));
    });
    const t = L.suggestTraining(d, "2026-11-28");
    eq(t.type, "run");
    has(t.reason, "Already 4 gym sessions this week");
  });

  test("3 full-body sessions cover all groups (any split works)", () => {
    const wp = L.weeklyProgress(["2026-11-23", "2026-11-24", "2026-11-26"].map((x) => gym(x, ["push", "pull", "legs"])), "2026-11-27");
    eq([wp.gymMet, wp.groups.push, wp.groups.legs], [true, 3, 3]);
  });

  // =================== training: missing data, exams, already done ===================
  test("no Whoop data → decides from the week: gym if behind", () => {
    const t = L.suggestTraining(make(), TODAY);
    eq(t.type, "gym");
    has(t.reason, "No Whoop data for today, so going by your week");
  });

  test("no Whoop data, gym met → run; everything met → rest", () => {
    const d = make((d) => {
      d.training.push(gym("2026-11-23", ["push", "pull"]), gym("2026-11-24", ["legs"]), gym("2026-11-25", ["push", "pull"]));
    });
    eq(L.suggestTraining(d, "2026-11-27").type, "run");
    d.training.push(run("2026-11-26"), run("2026-11-24"));
    eq(L.suggestTraining(d, "2026-11-27").type, "rest");
  });

  test("exam within 2 days → rest/light even with green recovery", () => {
    const d = make((d) => { d.metrics["2027-01-19"] = metric(95, null, null); });
    const t = L.suggestTraining(d, "2027-01-19");
    eq(t.type, "rest");
    eq(t.label, "Rest or light walk");
    has(t.reason, "Maths for Engineering 1 exam in 2 days");
    eq(L.suggestTraining(make((d) => { d.metrics["2027-01-18"] = metric(95, null, null); }), "2027-01-18").type, "gym", "3 days before is fine");
  });

  test("already trained today → done", () => {
    const d = make((d) => { d.metrics[TODAY] = metric(90, null, null); d.training.push(gym(TODAY, ["push"])); });
    const t = L.suggestTraining(d, TODAY);
    eq(t.type, "done");
    has(t.reason, "Already logged gym (Push) today");
  });

  // =================== low energy + whole day ===================
  test("low energy mode: 1 study block, dishes only, rest/walk", () => {
    const d = make((d) => {
      d.metrics[TODAY] = metric(90, null, null);
      chore(d, "hoovering").lastDone = L.addDays(TODAY, -20);
    });
    const p = L.planDay(d, TODAY, { lowEnergy: true });
    eq(p.lowEnergy, true);
    eq(p.study.blocks.map((b) => b.subjectId), ["maths1"]);
    eq(p.chores.chores.map((c) => c.choreId), ["dishes"]);
    eq(p.training.type, "rest");
    has(p.training.reason, "Low energy mode");
  });

  test("low energy mode near an exam still keeps 1 block for that exam", () => {
    const p = L.planDay(make(), "2027-01-20", { lowEnergy: true });
    eq(p.study.blocks.map((b) => b.subjectId), ["maths1"]);
  });

  test("full day plan: every item has a reason; input data is not changed", () => {
    const d = make((d) => { baseline(d); d.metrics[TODAY] = metric(70, 60, 55); });
    const copy = JSON.stringify(d);
    const p = L.planDay(d, TODAY);
    eq(JSON.stringify(d), copy, "planDay must not modify the data");
    eq(p.exams.length, 6);
    eq(p.study.blocks.length, 2);
    const items = [].concat(p.study.blocks, p.chores.chores, [p.training]);
    ok(items.every((x) => typeof x.reason === "string" && x.reason.length > 10), "all reasons filled");
    ok(items.every((x) => typeof x.key === "string"), "all have a check-off key");
  });

  test("works on data straight from the real store", () => {
    const mem = new Map();
    const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const store = P.createStore(st, { now: () => new Date(2026, 10, 25, 12) });
    store.addStudySession({ subjectId: "maths1", date: "2026-11-24" });
    store.markChoreDone("dishes", "2026-11-24");
    store.addGym({ groups: ["push"], sets: { push: 4 }, date: "2026-11-23" });
    store.setMetrics(TODAY, { recovery: 72, hrv: 64, rhr: 52, source: "whoop" });
    const p = L.planDay(store.get(), TODAY);
    eq(p.training.type, "gym");
    eq(p.chores.chores[0].choreId, "dishes");
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
    window.runPlanTests = run_;
  }
})();
