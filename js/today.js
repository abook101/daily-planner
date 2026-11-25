// Daily Planner: small helpers for the Today screen.
//
// These hold the parts of the screen that have rules worth testing, kept
// separate from the drawing code in app.js:
//   - the study timer (survives closing the app),
//   - undo for the last log,
//   - the low-energy switch (only lasts for the day it was switched on),
//   - this week's training tally (including today),
//   - reading number inputs ("4,5" and "4.5" both work).
//
// `storage` is localStorage in the app, or a fake in tests. None of these
// keys are part of the main data, so they are never in backups (on purpose:
// they are only about "right now").
//
// Works in the browser (as window.PlannerToday) and in Node (for tests).
"use strict";

(function (root) {
  const L = typeof module !== "undefined" && module.exports ? require("./plan.js") : root.PlannerLogic;

  const TIMER_KEY = "planner.timer";
  const UNDO_KEY = "planner.undo";
  const LOW_ENERGY_KEY = "planner.lowEnergy";
  const UNDO_HOURS = 12;            // undo is offered for 12 h after a log
  const FORGOT_FACTOR = 2;          // timer ran over 2x the block: probably forgot to stop it

  function readJSON(storage, key) {
    const t = storage.getItem(key);
    if (t === null) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  // ---------- numbers typed by hand ----------
  // "" -> null (left empty), "4,5" -> 4.5, "abc" -> NaN (shown as an error).
  function parseNum(text) {
    const t = String(text == null ? "" : text).trim().replace(",", ".");
    if (t === "") return null;
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }

  // ---------- study timer ----------
  // Only the START time is saved. The time shown is always "now minus start",
  // so closing the app, reloading or the phone sleeping changes nothing.
  function startTimer(storage, { blockKey, subjectId, subjectName, minutes, date }, nowMs) {
    if (getTimer(storage)) throw new Error("A timer is already running. Finish or cancel it first.");
    const t = { blockKey, subjectId, subjectName, minutes, date, startedAt: nowMs };
    storage.setItem(TIMER_KEY, JSON.stringify(t));
    return t;
  }

  function getTimer(storage) {
    const t = readJSON(storage, TIMER_KEY);
    return t && typeof t.startedAt === "number" && t.subjectId ? t : null;
  }

  function cancelTimer(storage) { storage.removeItem(TIMER_KEY); }

  function elapsedMs(timer, nowMs) { return Math.max(0, nowMs - timer.startedAt); }

  // "12:05" or "1:02:03"
  function formatClock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (h ? h + ":" + pad(m) : String(m)) + ":" + pad(sec);
  }

  // How many minutes to log when the timer is finished.
  //   - normal: the real minutes (at least 1)
  //   - ran over 2x the block (e.g. 3 h for a 45-min block): you most likely
  //     forgot to stop it, so log the planned block and say so.
  function minutesToLog(timer, nowMs) {
    const real = Math.round(elapsedMs(timer, nowMs) / 60000);
    const planned = timer.minutes || 45;
    if (real > planned * FORGOT_FACTOR) return { minutes: planned, forgot: true, real };
    return { minutes: Math.min(600, Math.max(1, real)), forgot: false, real };
  }

  // ---------- undo ----------
  // Before a log, we keep a copy of all the data. Undo puts that copy back,
  // but ONLY if nothing else changed since (e.g. a Whoop sync), so undo can
  // never wipe out something you didn't mean to undo.
  function withUndo(store, storage, label, action, nowMs) {
    const before = store.get();
    const result = action();
    const after = store.get();
    storage.setItem(UNDO_KEY, JSON.stringify({ label, at: nowMs, before, after: JSON.stringify(after) }));
    return result;
  }

  function getUndo(storage, nowMs) {
    const u = readJSON(storage, UNDO_KEY);
    if (!u || !u.before || typeof u.at !== "number") return null;
    if (nowMs - u.at > UNDO_HOURS * 3600000) return null;
    return { label: u.label, at: u.at };
  }

  function undoLast(store, storage, nowMs) {
    const u = readJSON(storage, UNDO_KEY);
    if (!u || !getUndo(storage, nowMs)) throw new Error("Nothing to undo.");
    if (JSON.stringify(store.get()) !== u.after) {
      storage.removeItem(UNDO_KEY);
      throw new Error("Can't undo: data changed since then. Fix it by hand instead.");
    }
    store.update((d) => {
      for (const k of Object.keys(d)) delete d[k];
      Object.assign(d, u.before);
    });
    storage.removeItem(UNDO_KEY);
    return u.label;
  }

  function clearUndo(storage) { storage.removeItem(UNDO_KEY); }

  // ---------- low energy mode ----------
  // Saved with the date, so it switches itself off the next day.
  function isLowEnergy(storage, today) { return storage.getItem(LOW_ENERGY_KEY) === today; }
  function setLowEnergy(storage, today, on) {
    if (on) storage.setItem(LOW_ENERGY_KEY, today); else storage.removeItem(LOW_ENERGY_KEY);
  }

  // ---------- this week's training, including today ----------
  // (plan.js's weeklyProgress stops at yesterday because it plans today;
  // the screen wants to show today's logs too.)
  function weekTally(training, today) {
    const start = L.weekStart(today);
    const week = training.filter((t) => t.date >= start && t.date <= today);
    const gym = week.filter((t) => t.type === "gym");
    const groups = {};
    for (const g of ["push", "pull", "legs"]) groups[g] = gym.filter((t) => L.countsFor(t, g)).length;
    return {
      groups,
      targets: L.TARGETS.week,
      gymSessions: gym.length,
      gymMin: L.TARGETS.gymMin, gymMax: L.TARGETS.gymMax,
      runs: week.filter((t) => t.type === "run").length,
      football: week.filter((t) => t.type === "football").length,
      cardioTarget: L.TARGETS.cardio,
    };
  }

  // ---------- short subject names for the exam strip ----------
  const SHORT = {
    maths1: "Maths 1", mechdesign: "Mech. Design", electrical: "Electrical",
    statics: "Statics", energy: "Energy Sys.", programming: "Programming",
  };
  function shortName(subjectId, name) {
    if (SHORT[subjectId]) return SHORT[subjectId];
    return name.length > 14 ? name.slice(0, 13) + "…" : name;
  }

  // Makes store errors readable: "Not saved: metrics[2026-11-25]: recovery must be 0–100"
  // becomes "Not saved: recovery must be 0–100".
  function friendlyError(err) {
    return String(err && err.message ? err.message : err).replace(/\w+\[[^\]]*\]: /g, "");
  }

  const api = {
    parseNum,
    startTimer, getTimer, cancelTimer, elapsedMs, formatClock, minutesToLog,
    withUndo, getUndo, undoLast, clearUndo,
    isLowEnergy, setLowEnergy,
    weekTally, shortName, friendlyError,
    KEYS: { TIMER_KEY, UNDO_KEY, LOW_ENERGY_KEY },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlannerToday = api;
})(typeof window !== "undefined" ? window : globalThis);
