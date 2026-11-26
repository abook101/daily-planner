// Daily Planner: Whoop numbers from the laptop (step 6).
//
// The laptop runs sync/whoop_sync.py, which downloads recovery, HRV, resting
// HR and sleep from Whoop and offers them at https://<laptop>:8765/whoop.json.
// When the app is opened on the home Wi-Fi, it asks the laptop for that file
// and saves the numbers. If the laptop is off or away, nothing breaks:
// typing the numbers on Today keeps working as before.
//
// Rules for mixing Whoop numbers with numbers you typed:
//   1. Nothing saved for that day yet       -> Whoop numbers are saved (source "whoop").
//   2. Whoop numbers already saved that day -> replaced if Whoop's changed (Whoop rescored).
//   3. You TYPED numbers for that day        -> never overwritten automatically.
//      Today's card then shows "Whoop says ..." with a "Use Whoop numbers" button.
//   4. Only the last 14 days, never future days, and only days with at least
//      one of recovery / HRV / resting HR. Bad numbers are skipped, not saved.
//   5. If nothing would change, nothing is written (so Undo keeps working).
//
// Pure rules (testable in Node) + a few browser helpers at the bottom.
"use strict";

(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const P = isNode ? require("./store.js") : root.PlannerData;

  const PAYLOAD_APP = "daily-planner-whoop";
  const PAYLOAD_VERSION = 1;
  const MAX_AGE_DAYS = 14;
  const DEFAULT_PORT = 8765;
  const AUTO_EVERY_MIN = 10;   // when the app is opened, sync at most every 10 minutes
  const TIMEOUT_MS = 15000;    // the laptop may download from Whoop first (a few seconds)

  // Local storage keys (on this phone only; not part of backups).
  const KEYS = {
    CONFIG: "planner.sync",          // { address, key }
    STATUS: "planner.syncStatus",    // { lastTry, lastOk, error, laptopError, report }
    LATEST: "planner.whoopLatest",   // last numbers received, for "Use Whoop numbers"
  };
  const FIELDS = ["recovery", "hrv", "rhr", "sleepHours", "sleepPerf"];

  // ---------- helpers ----------

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return P.toDateStr(new Date(y, m - 1, d + n));
  }

  function readJSON(storage, key) {
    try { const t = storage.getItem(key); return t === null ? null : JSON.parse(t); } catch (e) { return null; }
  }

  // Keeps only the 5 known fields, as numbers or null.
  function cleanDay(v) {
    const out = {};
    for (const f of FIELDS) {
      const x = v ? v[f] : null;
      out[f] = typeof x === "number" && Number.isFinite(x) ? x : null;
    }
    return out;
  }

  function sameNumbers(a, b) {
    return FIELDS.every((f) => (a[f] === undefined ? null : a[f]) === (b[f] === undefined ? null : b[f]));
  }

  // ---------- reading what the laptop sent ----------
  // Returns { ok, error, days, generatedAt, laptopError }.
  function parsePayload(obj) {
    if (!obj || typeof obj !== "object" || obj.app !== PAYLOAD_APP) {
      return { ok: false, error: "That address answered, but not with planner data. Check the address." };
    }
    if (obj.version !== PAYLOAD_VERSION) {
      return { ok: false, error: "The laptop script is a different version (" + obj.version + "). Update the app or the script." };
    }
    const days = {};
    for (const [date, v] of Object.entries(obj.days || {})) {
      if (P.isDateStr(date) && v && typeof v === "object") days[date] = cleanDay(v);
    }
    return { ok: true, days, generatedAt: obj.generatedAt || null, laptopError: obj.laptopError || null };
  }

  // ---------- the merge rules (see top of file) ----------
  // Changes `data.metrics` in place and says what happened.
  function mergeWhoop(data, days, today) {
    const report = { added: [], updated: [], keptManual: [], unchanged: [], skipped: [] };
    const oldest = addDays(today, -MAX_AGE_DAYS);
    for (const date of Object.keys(days).sort()) {
      const v = cleanDay(days[date]);
      if (date > today || date < oldest) { report.skipped.push(date); continue; }
      if (v.recovery === null && v.hrv === null && v.rhr === null) { report.skipped.push(date); continue; }
      const entry = Object.assign({ source: "whoop" }, v);
      // Drop empty sleep fields so entries stay small and match what was typed by hand.
      if (entry.sleepHours === null) delete entry.sleepHours;
      if (entry.sleepPerf === null) delete entry.sleepPerf;
      if (P.validateMetric(entry, date).length) { report.skipped.push(date); continue; }

      const old = data.metrics[date];
      if (!old) { data.metrics[date] = entry; report.added.push(date); }
      else if (old.source === "manual") report.keptManual.push(date);
      else if (sameNumbers(old, entry)) report.unchanged.push(date);
      else { data.metrics[date] = entry; report.updated.push(date); }
    }
    return report;
  }

  // Saves through the store, but only if something actually changes.
  function applyWhoop(store, days, today) {
    const dry = store.get();
    const report = mergeWhoop(dry, days, today);
    if (report.added.length || report.updated.length) {
      store.update((d) => { mergeWhoop(d, days, today); });
    }
    return report;
  }

  // For the "Whoop says ..." offer on a day you typed numbers in.
  function whoopOffer(data, latestDays, date) {
    const m = data.metrics[date];
    const w = latestDays && latestDays[date];
    if (!m || m.source !== "manual" || !w) return null;
    const v = cleanDay(w);
    if (v.recovery === null && v.hrv === null && v.rhr === null) return null;
    if (v.recovery === m.recovery && v.hrv === m.hrv && v.rhr === m.rhr) return null;
    return v;
  }

  // Most recent earlier day with Whoop numbers (for "today isn't scored yet").
  function lastWhoopDay(data, today) {
    const oldest = addDays(today, -MAX_AGE_DAYS);
    const dates = Object.keys(data.metrics || {}).filter((d) => d < today && d >= oldest && data.metrics[d].source === "whoop").sort();
    if (!dates.length) return null;
    const date = dates[dates.length - 1];
    return Object.assign({ date }, data.metrics[date]);
  }

  // Replace your typed numbers for a day with Whoop's (only when you tap the button).
  function useWhoopFor(store, date, numbers) {
    return store.update((d) => {
      const entry = Object.assign({ source: "whoop" }, cleanDay(numbers));
      if (entry.sleepHours === null) delete entry.sleepHours;
      if (entry.sleepPerf === null) delete entry.sleepPerf;
      d.metrics[date] = entry;
    });
  }

  // ---------- laptop address + key ----------

  function normalizeKey(k) { return String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

  // "192.168.1.23" -> "192.168.1.23:8765"; strips "https://" and slashes.
  // Returns null if it doesn't look like an address.
  function normalizeAddress(a) {
    let s = String(a || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!s) return null;
    if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(s)) return null;
    if (!/:\d+$/.test(s)) s += ":" + DEFAULT_PORT;
    return s;
  }

  function getConfig(storage) {
    const c = readJSON(storage, KEYS.CONFIG);
    return c && c.address && c.key ? c : null;
  }

  // Throws a readable error if something is wrong; saves nothing then.
  function setConfig(storage, address, key) {
    const a = normalizeAddress(address);
    if (!a) throw new Error("Laptop address should look like 192.168.1.23:8765");
    const k = normalizeKey(key);
    if (k.length < 8) throw new Error("Sync key is too short. Copy it from the laptop window (like ABCD-EFGH-JKMN).");
    const c = { address: a, key: k };
    storage.setItem(KEYS.CONFIG, JSON.stringify(c));
    return c;
  }

  function clearConfig(storage) {
    storage.removeItem(KEYS.CONFIG);
    storage.removeItem(KEYS.STATUS);
  }

  function syncUrl(config) {
    return "https://" + config.address + "/whoop.json?key=" + encodeURIComponent(config.key);
  }

  function getStatus(storage) { return readJSON(storage, KEYS.STATUS) || {}; }

  function shouldAutoSync(storage, nowMs) {
    if (!getConfig(storage)) return false;
    const s = getStatus(storage);
    return !s.lastTry || nowMs - s.lastTry > AUTO_EVERY_MIN * 60000;
  }

  // ---------- the whole sync ----------
  // fetchFn(url, {signal}) is the browser's fetch (or a fake in tests).
  // Never throws: returns { ok, message, report }. Status is saved for the screen.
  async function syncNow({ store, storage, fetchFn, nowMs, today, timeoutMs }) {
    const config = getConfig(storage);
    if (!config) return { ok: false, message: "Laptop sync isn't set up (Settings > Laptop sync)." };
    const status = getStatus(storage);
    status.lastTry = nowMs;
    let result;
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS) : null;
      let res;
      try {
        res = await fetchFn(syncUrl(config), { signal: ctrl ? ctrl.signal : undefined, cache: "no-store" });
      } finally { if (timer) clearTimeout(timer); }
      if (res.status === 403) throw new Error("The laptop says the sync key is wrong. Check it in Settings.");
      if (!res.ok) throw new Error("The laptop answered with an error (" + res.status + ").");
      const parsed = parsePayload(await res.json());
      if (!parsed.ok) throw new Error(parsed.error);
      storage.setItem(KEYS.LATEST, JSON.stringify({ at: nowMs, days: parsed.days }));
      const report = applyWhoop(store, parsed.days, today);
      status.lastOk = nowMs;
      status.error = null;
      status.laptopError = parsed.laptopError;
      status.report = { added: report.added.length, updated: report.updated.length, keptManual: report.keptManual };
      const n = report.added.length + report.updated.length;
      result = {
        ok: true, report,
        message: (n ? "Whoop: updated " + n + " day" + (n === 1 ? "" : "s") + "." : "Whoop: already up to date.") +
          (parsed.laptopError ? " (Laptop: " + parsed.laptopError + ")" : ""),
      };
    } catch (err) {
      const msg = err && err.name === "AbortError" ? "The laptop didn't answer in time."
        : err instanceof TypeError ? "Can't reach the laptop (off, asleep, not on this Wi-Fi, or the certificate isn't trusted yet)."
        : String(err && err.message ? err.message : err);
      status.error = msg;
      result = { ok: false, message: msg };
    }
    storage.setItem(KEYS.STATUS, JSON.stringify(status));
    return result;
  }

  // "Whoop sync 07:42" / "Laptop not reachable ..." for the Today card.
  function statusLine(storage, nowMs) {
    if (!getConfig(storage)) return null;
    const s = getStatus(storage);
    const when = (ms) => {
      const d = new Date(ms), now = new Date(nowMs);
      const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      if (P.toDateStr(d) === P.toDateStr(now)) return "today " + hm;
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + hm;
    };
    if (!s.lastTry) return { ok: true, text: "Laptop sync: not tried yet." };
    if (s.error) {
      return { ok: false, text: s.error + (s.lastOk ? " Last good sync " + when(s.lastOk) + "." : "") };
    }
    return { ok: !s.laptopError, text: "Laptop sync " + when(s.lastOk) + (s.laptopError ? ". Laptop: " + s.laptopError : "") };
  }

  function latestDays(storage) {
    const l = readJSON(storage, KEYS.LATEST);
    return l && l.days ? l.days : null;
  }

  const api = {
    PAYLOAD_APP, PAYLOAD_VERSION, MAX_AGE_DAYS, DEFAULT_PORT, KEYS,
    parsePayload, mergeWhoop, applyWhoop, whoopOffer, useWhoopFor, lastWhoopDay,
    normalizeKey, normalizeAddress, getConfig, setConfig, clearConfig, syncUrl,
    getStatus, shouldAutoSync, syncNow, statusLine, latestDays,
  };

  if (isNode) module.exports = api;
  else root.PlannerSync = api;
})(typeof window !== "undefined" ? window : globalThis);
