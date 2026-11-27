// Tests for reminders (js/store.js): adding, editing, removing, checks,
// grouping for Today / Upcoming / Past, the upgrade of old data, and backups.
//
//   - Browser: http://localhost:8000/tests/
//   - Node:    node tests/reminders.test.js
"use strict";

(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("../js/store.js") : window.PlannerData;

  function fakeStorage(initial) {
    const m = new Map(Object.entries(initial || {}));
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      keys: () => [...m.keys()],
    };
  }
  const fixedNow = () => new Date(2026, 10, 27, 12, 0); // 27 Nov 2026
  const newStore = (st) => P.createStore(st || fakeStorage(), { now: fixedNow });

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

  test("new data starts with no reminders", () => {
    eq(newStore().get().reminders, []);
  });

  test("add with only name and start date; optional fields are empty", () => {
    const s = newStore();
    const r = s.addReminder({ name: "  Call   landlord ", startDate: "2026-12-01" });
    eq([r.name, r.startDate, r.endDate, r.time, r.description, r.location],
      ["Call landlord", "2026-12-01", null, null, "", ""]);
    eq(s.get().reminders.length, 1);
  });

  test("add with every field", () => {
    const s = newStore();
    const r = s.addReminder({ name: "Christmas market", startDate: "2026-12-05", endDate: "2026-12-07",
      time: "18:30", description: "With the flatmates", location: "Marktplatz" });
    eq([r.endDate, r.time, r.description, r.location], ["2026-12-07", "18:30", "With the flatmates", "Marktplatz"]);
  });

  test("empty strings from the form count as not set", () => {
    const r = newStore().addReminder({ name: "X", startDate: "2026-12-01", endDate: "", time: "", description: "", location: "" });
    eq([r.endDate, r.time], [null, null]);
  });

  test("name and start date are required", () => {
    const s = newStore();
    throws(() => s.addReminder({ name: "  ", startDate: "2026-12-01" }), "needs a name");
    throws(() => s.addReminder({ name: "X", startDate: "" }), "needs a start date");
    eq(s.get().reminders.length, 0, "nothing saved");
  });

  test("bad dates, times and too-long text are refused", () => {
    const s = newStore();
    throws(() => s.addReminder({ name: "X", startDate: "2026-02-30" }), "start date");
    throws(() => s.addReminder({ name: "X", startDate: "2026-12-05", endDate: "2026-12-04" }), "before the start");
    throws(() => s.addReminder({ name: "X", startDate: "2026-12-05", time: "25:00" }), "time");
    throws(() => s.addReminder({ name: "x".repeat(P.REMINDER_NAME_MAX + 1), startDate: "2026-12-05" }), "too long");
    throws(() => s.addReminder({ name: "X", startDate: "2026-12-05", location: "x".repeat(P.REMINDER_PLACE_MAX + 1) }), "too long");
    eq(s.get().reminders.length, 0);
  });

  test("end date equal to start date is stored as a one-day reminder", () => {
    eq(newStore().addReminder({ name: "X", startDate: "2026-12-05", endDate: "2026-12-05" }).endDate, null);
  });

  test("edit keeps the id; a bad edit changes nothing", () => {
    const s = newStore();
    const r = s.addReminder({ name: "Dentist", startDate: "2026-12-03" });
    s.updateReminder(r.id, { name: "Dentist", startDate: "2026-12-04", time: "09:15", location: "Dr. Weber" });
    const after = s.get().reminders[0];
    eq([after.id, after.startDate, after.time, after.location], [r.id, "2026-12-04", "09:15", "Dr. Weber"]);
    throws(() => s.updateReminder(r.id, { name: "", startDate: "2026-12-04" }), "name");
    eq(s.get().reminders[0].name, "Dentist");
  });

  test("remove", () => {
    const s = newStore();
    const a = s.addReminder({ name: "A", startDate: "2026-12-01" });
    s.addReminder({ name: "B", startDate: "2026-12-02" });
    s.removeReminder(a.id);
    eq(s.get().reminders.map((r) => r.name), ["B"]);
    throws(() => s.removeReminder("nope"), "not found");
  });

  test("groups: today (incl. multi-day still running), upcoming, past", () => {
    const rs = [
      { id: "1", name: "Later", startDate: "2026-12-10", endDate: null, time: null, description: "", location: "" },
      { id: "2", name: "Running", startDate: "2026-11-25", endDate: "2026-11-29", time: null, description: "", location: "" },
      { id: "3", name: "Today 18:00", startDate: "2026-11-27", endDate: null, time: "18:00", description: "", location: "" },
      { id: "4", name: "Today 09:00", startDate: "2026-11-27", endDate: null, time: "09:00", description: "", location: "" },
      { id: "5", name: "Old", startDate: "2026-11-20", endDate: null, time: null, description: "", location: "" },
      { id: "6", name: "Ended yesterday", startDate: "2026-11-24", endDate: "2026-11-26", time: null, description: "", location: "" },
      { id: "7", name: "Sooner", startDate: "2026-11-28", endDate: null, time: null, description: "", location: "" },
    ];
    const g = P.reminderGroups(rs, "2026-11-27");
    eq(g.today.map((r) => r.name), ["Running", "Today 09:00", "Today 18:00"]);
    eq(g.upcoming.map((r) => r.name), ["Sooner", "Later"]);
    eq(g.past.map((r) => r.name), ["Ended yesterday", "Old"], "most recent first");
  });

  test("old data (version 1) is backed up and upgraded with an empty reminder list", () => {
    const old = P.defaultData();
    old.schemaVersion = 1;
    delete old.reminders;
    old.training.push({ id: "t1", date: "2026-11-20", type: "run", distanceKm: 5, durationMin: 30, notes: "" });
    const oldText = JSON.stringify(old);
    const st = fakeStorage({ "planner.data": oldText });
    const d = newStore(st).load();
    eq(d.schemaVersion, P.SCHEMA_VERSION);
    eq(d.reminders, []);
    eq(d.training.length, 1, "nothing else lost");
    eq(st.getItem("planner.backup.v1"), oldText, "backup made first");
  });

  test("reminders are in the backup and come back on import", () => {
    const s = newStore();
    s.addReminder({ name: "Pay rent", startDate: "2026-12-01", time: "10:00" });
    const text = s.exportJSON();
    ok(text.includes("Pay rent"), "exported");
    const other = newStore();
    const res = other.checkImport(text);
    ok(res.ok, res.errors.join("; "));
    eq(res.summary.reminders, 1);
    other.applyImport(res);
    eq(other.get().reminders.map((r) => r.name), ["Pay rent"]);
  });

  test("an old backup (version 1, no reminders) still imports", () => {
    const old = P.defaultData();
    old.schemaVersion = 1;
    delete old.reminders;
    const res = newStore().checkImport(JSON.stringify({ app: "daily-planner", exportedAt: "x", data: old }));
    ok(res.ok, res.errors && res.errors.join("; "));
    eq(res.data.reminders, []);
  });

  test("a backup with a broken reminder is refused", () => {
    const d = P.defaultData();
    d.reminders.push({ id: "r", name: "X", startDate: "2026-12-05", endDate: "2026-12-01", time: null, description: "", location: "" });
    const res = newStore().checkImport(JSON.stringify({ app: "daily-planner", data: d }));
    ok(!res.ok);
    ok(res.errors.join(" ").includes("endDate is before startDate"));
  });

  // ----- done, carry over, hourly (schema 3) -----
  const base = (extra) => Object.assign({ id: "r", name: "X", startDate: "2026-11-27", endDate: null, time: null, description: "", location: "", doneDates: [], carryOver: false, hourly: true }, extra || {});

  test("new reminders start not done, no carry-over, hourly on", () => {
    const st = newStore(); st.load();
    const r = st.addReminder({ name: "Call", startDate: "2026-11-28" });
    eq([r.doneDates, r.carryOver, r.hourly], [[], false, true]);
    const r2 = st.addReminder({ name: "Pay", startDate: "2026-11-28", carryOver: true, hourly: false });
    eq([r2.carryOver, r2.hourly], [true, false]);
  });

  test("version 2 data is upgraded: every reminder gets the new fields", () => {
    const old = P.defaultData();
    old.schemaVersion = 2;
    old.reminders = [{ id: "a", name: "Old", startDate: "2026-12-01", endDate: null, time: null, description: "", location: "" }];
    const st = fakeStorage({ "planner.data": JSON.stringify(old) });
    const s = newStore(st); s.load();
    const r = s.get().reminders[0];
    eq([s.get().schemaVersion, r.doneDates, r.carryOver, r.hourly], [3, [], false, true]);
    ok(st.keys().includes("planner.backup.v2"), "backed up before upgrading");
  });

  test("marking done and undoing is per day", () => {
    const st = newStore(); st.load();
    const r = st.addReminder({ name: "Call", startDate: "2026-11-27", endDate: "2026-11-29" });
    st.setReminderDone(r.id, "2026-11-28");
    st.setReminderDone(r.id, "2026-11-28"); // twice: still one entry
    eq(st.get().reminders[0].doneDates, ["2026-11-28"]);
    eq(P.reminderState(st.get().reminders[0], "2026-11-27"), "open");
    eq(P.reminderState(st.get().reminders[0], "2026-11-28"), "done");
    st.setReminderDone(r.id, "2026-11-28", false);
    eq(st.get().reminders[0].doneDates, []);
    throws(() => st.setReminderDone(r.id, "nope"), "real date");
    throws(() => st.setReminderDone("missing", "2026-11-28"), "not found");
  });

  test("carry over: comes back every day until done on its last day or later", () => {
    const r = base({ carryOver: true });
    eq(["2026-11-26", "2026-11-27", "2026-11-28", "2026-12-20"].map((d) => P.reminderState(r, d)), [null, "open", "carried", "carried"]);
    eq(P.reminderState(base({ carryOver: true, doneDates: ["2026-11-27"] }), "2026-11-28"), null, "done on the day itself");
    eq(P.reminderState(base({ carryOver: true, doneDates: ["2026-11-30"] }), "2026-12-01"), null, "done while carried");
    eq(P.reminderState(base({ carryOver: false }), "2026-11-28"), null, "no carry-over: gone the next day");
  });

  test("carry over of a multi-day reminder starts after its last day; done earlier in the range doesn't count", () => {
    const r = base({ carryOver: true, endDate: "2026-11-29", doneDates: ["2026-11-28"] });
    eq(P.reminderState(r, "2026-11-28"), "done");
    eq(P.reminderState(r, "2026-11-29"), "open");
    eq(P.reminderState(r, "2026-11-30"), "carried");
  });

  test("groups: carried ones are in today, done ones in their own list, not in past", () => {
    const list = [base({ id: "a", carryOver: true }), base({ id: "b", startDate: "2026-11-28", doneDates: ["2026-11-28"] }), base({ id: "c", startDate: "2026-11-20" }), base({ id: "d", startDate: "2026-11-29" })];
    const g = P.reminderGroups(list, "2026-11-28");
    eq(g.today.map((r) => r.id), ["a"]);
    eq(g.done.map((r) => r.id), ["b"]);
    eq(g.upcoming.map((r) => r.id), ["d"]);
    eq(g.past.map((r) => r.id), ["c"]);
  });

  test("a backup with a wrong done list or flags is refused", () => {
    const d = P.defaultData();
    d.reminders.push(base({ doneDates: ["not a date"] }), base({ id: "r2", carryOver: "yes", hourly: null }));
    const res = newStore().checkImport(JSON.stringify({ app: "daily-planner", data: d }));
    ok(!res.ok);
    const text = res.errors.join(" ");
    ok(text.includes("doneDates") && text.includes("carryOver") && text.includes("hourly"), text);
  });

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
    window.runReminderTests = run;
  }
})();
