// Daily Planner: data layer.
//
// Everything the app remembers lives in ONE JSON document saved in the
// browser's localStorage under the key "planner.data". Keeping it in one
// place means a save is all-or-nothing: we never end up with half the data
// updated and half not.
//
// Safety rules this file follows:
//   1. Validate before saving. If the new data is broken, nothing is written.
//   2. Keep the previous good copy ("planner.data.prev") on every save.
//   3. If the saved data can't be read (corrupt JSON), keep the broken text
//      aside instead of deleting it, and fall back to the previous good copy.
//   4. Every document has a schemaVersion. When a future step changes the
//      shape of the data, a migration upgrades old data, and a full backup is
//      saved first ("planner.backup.v<old version>").
//
// Works in the browser (as window.PlannerData) and in Node (for tests).
"use strict";

(function (root) {
  const SCHEMA_VERSION = 1;
  const KEY = "planner.data";
  const KEY_PREV = "planner.data.prev";
  const KEY_BEFORE_IMPORT = "planner.backup.before-import";
  const APP_ID = "daily-planner";
  const STUDY_BLOCK_MIN = 45;

  const GROUPS = ["push", "pull", "legs"];
  const TRAINING_TYPES = ["gym", "run", "football"];
  const METRIC_SOURCES = ["manual", "whoop"];

  // ---------- small helpers ----------

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Dates are stored as "YYYY-MM-DD" in local time (no time zones to worry about).
  function toDateStr(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function isDateStr(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const isInt = (x) => Number.isInteger(x);
  const isText = (x) => typeof x === "string" && x.trim().length > 0;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // ---------- default data (first run) ----------

  // Exam dates are not final yet. These are placeholders spread over
  // 21 Jan – 7 Feb 2027 and can be edited later (step 5 settings).
  const DEFAULT_SUBJECTS = [
    ["maths1", "Maths for Engineering 1", "2027-01-21"],
    ["mechdesign", "Basics of Mechanical Design", "2027-01-25"],
    ["electrical", "Basics of Electrical Engineering", "2027-01-28"],
    ["statics", "Statics", "2027-02-01"],
    ["energy", "Energy Systems & Energy Economics", "2027-02-04"],
    ["programming", "Programming for Renewable Energy", "2027-02-07"],
  ];

  const DEFAULT_CHORES = [
    ["hoovering", "Hoovering", 5, 7],
    ["mopping", "Mopping", 10, 14],
    ["sheets", "Bed sheets", 7, 10],
    ["laundry", "Laundry", 6, 8],
    ["dishes", "Dishes", 1, 1],
    ["groceries", "Groceries", 3, 5],
  ];

  function defaultData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      subjects: DEFAULT_SUBJECTS.map(([id, name, examDate]) => ({
        id, name, examDate, examDateConfirmed: false,
      })),
      studySessions: [],
      chores: DEFAULT_CHORES.map(([id, name, minDays, maxDays]) => ({
        id, name, minDays, maxDays, lastDone: null,
      })),
      training: [],
      metrics: {},   // { "2026-11-25": { recovery, hrv, rhr, source } }
      checkoffs: {}, // { "2026-11-25": ["chore:dishes", "study:maths1:1"] }
    };
  }

  // ---------- validation ----------
  // Each validator returns a list of problems (empty list = valid).

  function validateSubject(s, where) {
    const e = [];
    if (!s || typeof s !== "object") return [where + ": not an object"];
    if (!isText(s.id)) e.push(where + ": missing id");
    if (!isText(s.name)) e.push(where + ": missing name");
    if (s.examDate !== null && !isDateStr(s.examDate)) e.push(where + ": bad examDate");
    if (typeof s.examDateConfirmed !== "boolean") e.push(where + ": examDateConfirmed must be true/false");
    return e;
  }

  function validateStudySession(s, where, subjectIds) {
    const e = [];
    if (!s || typeof s !== "object") return [where + ": not an object"];
    if (!isText(s.id)) e.push(where + ": missing id");
    if (!subjectIds.has(s.subjectId)) e.push(where + ": unknown subject '" + s.subjectId + "'");
    if (!isInt(s.minutes) || s.minutes < 1 || s.minutes > 600) e.push(where + ": minutes must be 1–600");
    if (!isDateStr(s.date)) e.push(where + ": bad date");
    return e;
  }

  function validateChore(c, where) {
    const e = [];
    if (!c || typeof c !== "object") return [where + ": not an object"];
    if (!isText(c.id)) e.push(where + ": missing id");
    if (!isText(c.name)) e.push(where + ": missing name");
    if (!isInt(c.minDays) || c.minDays < 1) e.push(where + ": minDays must be a whole number ≥ 1");
    if (!isInt(c.maxDays) || c.maxDays < c.minDays) e.push(where + ": maxDays must be ≥ minDays");
    if (c.lastDone !== null && !isDateStr(c.lastDone)) e.push(where + ": bad lastDone");
    return e;
  }

  function validateTraining(t, where) {
    const e = [];
    if (!t || typeof t !== "object") return [where + ": not an object"];
    if (!isText(t.id)) e.push(where + ": missing id");
    if (!isDateStr(t.date)) e.push(where + ": bad date");
    if (!TRAINING_TYPES.includes(t.type)) return e.concat(where + ": type must be gym, run or football");
    if (t.durationMin !== null && (!isNum(t.durationMin) || t.durationMin <= 0 || t.durationMin > 600)) {
      e.push(where + ": durationMin must be 1–600 or empty");
    }
    if (t.type === "gym") {
      if (!Array.isArray(t.groups) || t.groups.length === 0) e.push(where + ": gym needs at least one of push/pull/legs");
      else if (!t.groups.every((g) => GROUPS.includes(g))) e.push(where + ": groups must be push/pull/legs");
      else if (new Set(t.groups).size !== t.groups.length) e.push(where + ": duplicate group");
      if (t.sets !== null) {
        if (typeof t.sets !== "object") e.push(where + ": sets must be an object or empty");
        else for (const [g, n] of Object.entries(t.sets)) {
          if (!Array.isArray(t.groups) || !t.groups.includes(g)) e.push(where + ": sets for '" + g + "' which isn't in groups");
          if (!isInt(n) || n < 1 || n > 100) e.push(where + ": sets for '" + g + "' must be 1–100");
        }
      }
    }
    if (t.type === "run") {
      if (t.distanceKm !== null && (!isNum(t.distanceKm) || t.distanceKm <= 0 || t.distanceKm > 100)) {
        e.push(where + ": distanceKm must be between 0 and 100");
      }
    }
    return e;
  }

  function validateMetric(m, where) {
    const e = [];
    if (!m || typeof m !== "object") return [where + ": not an object"];
    if (!METRIC_SOURCES.includes(m.source)) e.push(where + ": source must be manual or whoop");
    if (m.recovery !== null && (!isNum(m.recovery) || m.recovery < 0 || m.recovery > 100)) e.push(where + ": recovery must be 0–100");
    if (m.hrv !== null && (!isNum(m.hrv) || m.hrv <= 0 || m.hrv > 300)) e.push(where + ": HRV must be 1–300 ms");
    if (m.rhr !== null && (!isNum(m.rhr) || m.rhr < 25 || m.rhr > 150)) e.push(where + ": resting HR must be 25–150 bpm");
    if (m.recovery === null && m.hrv === null && m.rhr === null) e.push(where + ": needs at least one value");
    return e;
  }

  function validateData(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return ["data is not an object"];
    const e = [];
    if (d.schemaVersion !== SCHEMA_VERSION) e.push("schemaVersion should be " + SCHEMA_VERSION + ", got " + d.schemaVersion);
    for (const k of ["subjects", "studySessions", "chores", "training"]) {
      if (!Array.isArray(d[k])) e.push(k + " must be a list");
    }
    for (const k of ["metrics", "checkoffs"]) {
      if (!d[k] || typeof d[k] !== "object" || Array.isArray(d[k])) e.push(k + " must be an object");
    }
    if (e.length) return e;

    const uniqueIds = (list, name) => {
      const ids = list.map((x) => x && x.id);
      if (new Set(ids).size !== ids.length) e.push(name + ": duplicate ids");
    };

    d.subjects.forEach((s, i) => e.push(...validateSubject(s, "subjects[" + i + "]")));
    uniqueIds(d.subjects, "subjects");
    const subjectIds = new Set(d.subjects.map((s) => s && s.id));
    d.studySessions.forEach((s, i) => e.push(...validateStudySession(s, "studySessions[" + i + "]", subjectIds)));
    uniqueIds(d.studySessions, "studySessions");
    d.chores.forEach((c, i) => e.push(...validateChore(c, "chores[" + i + "]")));
    uniqueIds(d.chores, "chores");
    d.training.forEach((t, i) => e.push(...validateTraining(t, "training[" + i + "]")));
    uniqueIds(d.training, "training");
    for (const [date, m] of Object.entries(d.metrics)) {
      if (!isDateStr(date)) e.push("metrics: bad date key '" + date + "'");
      e.push(...validateMetric(m, "metrics[" + date + "]"));
    }
    for (const [date, list] of Object.entries(d.checkoffs)) {
      if (!isDateStr(date)) e.push("checkoffs: bad date key '" + date + "'");
      if (!Array.isArray(list) || !list.every(isText)) e.push("checkoffs[" + date + "]: must be a list of names");
    }
    return e;
  }

  // ---------- migrations ----------
  // MIGRATIONS[n] upgrades data from version n to n+1.
  // Example for the future:  MIGRATIONS[1] = (d) => { d.newThing = []; d.schemaVersion = 2; return d; };
  const MIGRATIONS = {};

  function migrate(d) {
    let data = d;
    while (isInt(data.schemaVersion) && data.schemaVersion < SCHEMA_VERSION) {
      const step = MIGRATIONS[data.schemaVersion];
      if (!step) throw new Error("No migration from version " + data.schemaVersion);
      data = step(clone(data));
    }
    if (data.schemaVersion > SCHEMA_VERSION) {
      throw new Error("This data is from a newer version of the app (v" + data.schemaVersion + "). Update the app first.");
    }
    return data;
  }

  // ---------- the store ----------
  // `storage` is anything with getItem/setItem/removeItem (localStorage, or a fake in tests).

  function createStore(storage, options) {
    const opts = options || {};
    const today = () => toDateStr(opts.now ? opts.now() : new Date());
    let data = null;
    const warnings = []; // things the app may want to show (e.g. "recovered from backup")

    function tryParse(text) {
      try { return JSON.parse(text); } catch (err) { return undefined; }
    }

    // Read from storage, repairing if needed. Never throws.
    function load() {
      const raw = storage.getItem(KEY);
      if (raw === null) { data = defaultData(); persist(); return data; }

      // Returns usable data from a saved text, or a reason why not.
      function readDoc(text) {
        const parsed = tryParse(text);
        if (parsed === undefined || !parsed || typeof parsed !== "object") return { error: "unreadable JSON" };
        try {
          let doc = parsed;
          let migrated = false;
          if (isInt(doc.schemaVersion) && doc.schemaVersion < SCHEMA_VERSION) {
            storage.setItem("planner.backup.v" + doc.schemaVersion, text); // back up before migrating
            doc = migrate(doc);
            migrated = true;
          }
          const problems = validateData(doc);
          if (problems.length) return { error: problems.slice(0, 3).join("; ") };
          return { doc, migrated };
        } catch (err) {
          return { error: err.message };
        }
      }

      const main = readDoc(raw);
      if (main.doc) {
        data = main.doc;
        if (main.migrated) persist();
        return data;
      }

      // Main copy is broken. Keep the broken text aside (never delete it),
      // then try the previous good copy.
      const corruptKey = "planner.corrupt." + Date.now();
      storage.setItem(corruptKey, raw);
      warnings.push("Saved data was broken (" + main.error + "). Kept it under '" + corruptKey + "'.");

      const prevText = storage.getItem(KEY_PREV);
      const prev = prevText === null ? { error: "no previous copy" } : readDoc(prevText);
      if (prev.doc) {
        data = prev.doc;
        storage.setItem(KEY, JSON.stringify(data)); // write directly: don't push the broken copy into prev
        warnings.push("Restored the previous saved copy (you may have lost the very last change).");
        return data;
      }
      data = defaultData();
      storage.setItem(KEY, JSON.stringify(data));
      warnings.push("No usable copy found (" + prev.error + "). Started fresh.");
      return data;
    }

    function persist() {
      const text = JSON.stringify(data);
      const old = storage.getItem(KEY);
      if (old !== null && old !== text) storage.setItem(KEY_PREV, old);
      storage.setItem(KEY, text);
    }

    // All changes go through here: copy, change the copy, validate, then save.
    // If anything is wrong, the real data is untouched and an error is thrown.
    function update(changeFn) {
      if (!data) load();
      const draft = clone(data);
      const result = changeFn(draft);
      const problems = validateData(draft);
      if (problems.length) throw new Error("Not saved: " + problems.join("; "));
      const before = data;
      data = draft;
      try {
        persist();
      } catch (err) {
        data = before; // e.g. storage full
        throw new Error("Not saved, storage error: " + err.message);
      }
      return result;
    }

    function get() { if (!data) load(); return clone(data); }

    const findById = (list, id, what) => {
      const x = list.find((i) => i.id === id);
      if (!x) throw new Error(what + " '" + id + "' not found");
      return x;
    };

    // ----- subjects -----
    function setExamDate(subjectId, date, confirmed) {
      return update((d) => {
        const s = findById(d.subjects, subjectId, "Subject");
        s.examDate = date;
        if (confirmed !== undefined) s.examDateConfirmed = !!confirmed;
      });
    }

    // ----- study -----
    function addStudySession({ subjectId, minutes = STUDY_BLOCK_MIN, date = today() }) {
      return update((d) => {
        const s = { id: newId(), subjectId, minutes, date };
        d.studySessions.push(s);
        return s;
      });
    }
    function deleteStudySession(id) {
      return update((d) => { d.studySessions = d.studySessions.filter((s) => s.id !== id); });
    }
    function studyMinutes(subjectId, fromDate, toDate) {
      return get().studySessions
        .filter((s) => (!subjectId || s.subjectId === subjectId) &&
                       (!fromDate || s.date >= fromDate) && (!toDate || s.date <= toDate))
        .reduce((sum, s) => sum + s.minutes, 0);
    }

    // ----- chores -----
    function markChoreDone(choreId, date = today()) {
      return update((d) => { findById(d.chores, choreId, "Chore").lastDone = date; });
    }
    function setChoreRange(choreId, minDays, maxDays) {
      return update((d) => {
        const c = findById(d.chores, choreId, "Chore");
        c.minDays = minDays; c.maxDays = maxDays;
      });
    }

    // ----- training -----
    function addGym({ groups, sets = null, durationMin = null, date = today(), notes = "" }) {
      return update((d) => {
        const t = { id: newId(), date, type: "gym", groups, sets, durationMin, notes };
        d.training.push(t);
        return t;
      });
    }
    function addRun({ distanceKm = null, durationMin = null, date = today(), notes = "" }) {
      return update((d) => {
        const t = { id: newId(), date, type: "run", distanceKm, durationMin, notes };
        d.training.push(t);
        return t;
      });
    }
    function addFootball({ durationMin = null, date = today(), notes = "" }) {
      return update((d) => {
        const t = { id: newId(), date, type: "football", durationMin, notes };
        d.training.push(t);
        return t;
      });
    }
    function deleteTraining(id) {
      return update((d) => { d.training = d.training.filter((t) => t.id !== id); });
    }

    // ----- daily metrics -----
    // One entry per day; saving again for the same day replaces it.
    // Leave a value out (null) if you don't have it.
    function setMetrics(date, { recovery = null, hrv = null, rhr = null, source = "manual" }) {
      return update((d) => { d.metrics[date] = { recovery, hrv, rhr, source }; });
    }
    function getMetrics(date) { return get().metrics[date] || null; }

    // ----- daily check-offs -----
    function setChecked(date, itemKey, checked) {
      return update((d) => {
        const list = d.checkoffs[date] || [];
        const has = list.includes(itemKey);
        if (checked && !has) list.push(itemKey);
        if (!checked && has) list.splice(list.indexOf(itemKey), 1);
        if (list.length) d.checkoffs[date] = list; else delete d.checkoffs[date];
      });
    }
    function isChecked(date, itemKey) {
      return (get().checkoffs[date] || []).includes(itemKey);
    }

    // ----- backups: export / import -----
    function exportJSON() {
      if (!data) load();
      return JSON.stringify({ app: APP_ID, exportedAt: new Date().toISOString(), data }, null, 2);
    }

    // Step 1 of import: read and check the file, change nothing.
    // Returns { ok, errors, data, summary }.
    function checkImport(text) {
      const parsed = tryParse(text);
      if (parsed === undefined) return { ok: false, errors: ["File is not valid JSON."] };
      if (!parsed || parsed.app !== APP_ID || !parsed.data) {
        return { ok: false, errors: ["This is not a Daily Planner backup file."] };
      }
      let doc;
      try { doc = migrate(clone(parsed.data)); } catch (err) { return { ok: false, errors: [err.message] }; }
      const errors = validateData(doc);
      if (errors.length) return { ok: false, errors };
      const summary = {
        exportedAt: parsed.exportedAt || "unknown",
        subjects: doc.subjects.length,
        studySessions: doc.studySessions.length,
        training: doc.training.length,
        metricDays: Object.keys(doc.metrics).length,
      };
      return { ok: true, errors: [], data: doc, summary };
    }

    // Step 2 of import: replace everything. The current data is saved first
    // under "planner.backup.before-import", so an import can be undone.
    function applyImport(checked) {
      if (!checked || !checked.ok) throw new Error("Import was not checked or is invalid.");
      if (!data) load();
      storage.setItem(KEY_BEFORE_IMPORT, JSON.stringify(data));
      const before = data;
      data = clone(checked.data);
      try { persist(); } catch (err) { data = before; throw err; }
    }

    function undoImport() {
      const text = storage.getItem(KEY_BEFORE_IMPORT);
      if (text === null) throw new Error("No import to undo.");
      const result = checkImport(JSON.stringify({ app: APP_ID, data: JSON.parse(text) }));
      if (!result.ok) throw new Error("Saved pre-import copy is invalid.");
      data = result.data;
      persist();
    }

    return {
      load, get, update, warnings,
      setExamDate,
      addStudySession, deleteStudySession, studyMinutes,
      markChoreDone, setChoreRange,
      addGym, addRun, addFootball, deleteTraining,
      setMetrics, getMetrics,
      setChecked, isChecked,
      exportJSON, checkImport, applyImport, undoImport,
    };
  }

  // ---------- browser-only helpers for backup files ----------

  function downloadBackup(store) {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "planner-backup-" + toDateStr(new Date()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Reads a chosen file, checks it, asks for confirmation, then imports.
  // Resolves to a short message for the user.
  function importBackupFile(store, file, confirmFn) {
    const ask = confirmFn || ((msg) => window.confirm(msg));
    return file.text().then((text) => {
      const res = store.checkImport(text);
      if (!res.ok) return "Import failed: " + res.errors.slice(0, 3).join("; ");
      const s = res.summary;
      const msg = "Replace ALL current data with this backup?\n\n" +
        "Backup from: " + s.exportedAt + "\n" +
        s.studySessions + " study sessions, " + s.training + " training entries, " +
        s.metricDays + " days of Whoop data.\n\n" +
        "(Your current data is kept as a safety copy.)";
      if (!ask(msg)) return "Import cancelled. Nothing changed.";
      store.applyImport(res);
      return "Backup imported.";
    });
  }

  const api = {
    SCHEMA_VERSION, STUDY_BLOCK_MIN, GROUPS,
    createStore, defaultData, validateData, migrate, MIGRATIONS,
    isDateStr, toDateStr, downloadBackup, importBackupFile,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlannerData = api;
})(typeof window !== "undefined" ? window : globalThis);
