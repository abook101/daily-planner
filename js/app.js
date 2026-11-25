// Daily Planner: the Today screen.
//
// How this file works, in short:
//   1. render() reads the saved data, asks plan.js for today's plan, and
//      redraws every card from scratch. Nothing on screen is "remembered"
//      separately, so the screen can never drift from the saved data.
//   2. Every button has a data-action="..." name. One click listener at the
//      bottom looks at that name and runs the matching action.
//   3. Every log goes through act(), which saves an undo copy first, then
//      shows a short message with an Undo button.
//
// Rules worth testing (timer, undo, low energy, week tally) live in
// js/today.js and have their own tests; this file only draws and wires.
"use strict";

const store = PlannerData.createStore(window.localStorage);
const L = PlannerLogic;
const T = PlannerToday;
const LS = window.localStorage;

// Things that only matter while the screen is open (which panel is open, etc.).
const ui = {
  panel: null,           // "gym" | "run" | "football" | null: which log form is open
  gymGroups: [],         // chips picked in the gym form
  gymSets: {},           // sets typed in the gym form (kept while chips change)
  editMetrics: false,
  open: {},              // which <details> sections are expanded
};

const today = () => PlannerData.toDateStr(new Date());
const GROUP_NAME = { push: "Push", pull: "Pull", legs: "Legs" };
const groupList = (groups) => groups.map((g) => GROUP_NAME[g]).join(" + ");

// ---------- tiny DOM helper ----------
// h("button", { class: "x", "data-action": "go" }, "Go") makes <button class="x" data-action="go">Go</button>.
// Text is always added as text (never as HTML), so nothing typed can break the page.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}
const fill = (id, ...children) => {
  const el = document.getElementById(id);
  el.replaceChildren(...children.flat().filter(Boolean));
};
// A <details> that stays open/closed across redraws.
function details(name, summary, ...content) {
  const d = h("details", { class: "more", "data-open-name": name, open: !!ui.open[name] }, h("summary", {}, summary), ...content);
  d.addEventListener("toggle", () => { ui.open[name] = d.open; });
  return d;
}
const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };

// ---------- messages + undo ----------
let toastTimer = null;
function showToast(text, withUndo) {
  document.getElementById("toast-text").textContent = text;
  document.getElementById("toast-undo").hidden = !withUndo;
  const t = document.getElementById("toast");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, withUndo ? 8000 : 5000);
}

// Runs a log action with an undo copy. Returns true if it was saved.
function act(label, fn) {
  try {
    T.withUndo(store, LS, label, fn, Date.now());
    showToast("Logged: " + label, true);
    render();
    return true;
  } catch (err) {
    showToast(T.friendlyError(err), false);
    return false;
  }
}

function undo() {
  try {
    const label = T.undoLast(store, LS, Date.now());
    showToast("Undone: " + label, false);
  } catch (err) {
    showToast(err.message, false);
  }
  render();
}

// =====================================================================
// Cards
// =====================================================================

function renderHeader(plan) {
  document.getElementById("today-date").textContent = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });
  document.getElementById("low-energy").checked = plan.lowEnergy;
  document.getElementById("low-energy-banner").hidden = !plan.lowEnergy;

  const chips = plan.exams.filter((e) => e.daysLeft === null || e.daysLeft >= 0).map((e) => {
    const cls = e.daysLeft === null ? "" : e.daysLeft <= 7 ? " urgent" : e.daysLeft <= 21 ? " soon" : "";
    const big = e.daysLeft === null ? "?" : e.daysLeft === 0 ? "Today" : e.daysLeft + "d";
    const when = e.examDate ? new Date(e.examDate + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "no date";
    return h("div", { class: "exam" + cls, title: e.name + (e.confirmed ? "" : " (date not final)") },
      h("span", { class: "exam-days" }, big),
      h("span", { class: "exam-name" }, T.shortName(e.subjectId, e.name)),
      h("span", { class: "exam-date" }, when + (e.confirmed ? "" : " ~")));
  });
  fill("exam-strip", chips.length ? chips : h("p", { class: "muted small" }, "No upcoming exams."));

  const u = T.getUndo(LS, Date.now());
  const pill = document.getElementById("undo-pill");
  pill.hidden = !u;
  if (u) pill.textContent = "↶ Undo last: " + u.label;
}

function renderMetrics(data, day) {
  const m = data.metrics[day] || null;
  const badge = m ? h("span", { class: "badge " + (m.source === "whoop" ? "whoop" : "") }, m.source === "whoop" ? "From Whoop" : "Typed in") : null;
  const head = h("div", { class: "card-head" }, h("h2", {}, "Morning metrics"), badge);
  const show = (x, unit) => (x === null ? "–" : x + unit);

  if (m && !ui.editMetrics) {
    fill("card-metrics", head,
      h("div", { class: "metric-row" },
        h("div", { class: "metric" }, h("b", {}, show(m.recovery, "%")), h("span", {}, "Recovery")),
        h("div", { class: "metric" }, h("b", {}, show(m.hrv, "")), h("span", {}, "HRV ms")),
        h("div", { class: "metric" }, h("b", {}, show(m.rhr, "")), h("span", {}, "Resting HR")),
        h("button", { type: "button", class: "link", "data-action": "metrics-edit" }, "Edit")));
    return;
  }
  const input = (id, label, value, ph) => h("label", { class: "field" }, h("span", {}, label),
    h("input", { id, type: "text", inputmode: "decimal", autocomplete: "off", placeholder: ph, value: value === null || value === undefined ? "" : String(value) }));
  fill("card-metrics", head,
    m ? null : h("p", { class: "muted small tight" }, "No Whoop data yet today. Type what the Whoop app shows (any you have)."),
    h("div", { class: "field-row" },
      input("m-recovery", "Recovery %", m && m.recovery, "e.g. 72"),
      input("m-hrv", "HRV (ms)", m && m.hrv, "e.g. 64"),
      input("m-rhr", "Resting HR", m && m.rhr, "e.g. 52")),
    h("div", { class: "btn-row" },
      h("button", { type: "button", "data-action": "metrics-save" }, "Save"),
      m ? h("button", { type: "button", class: "secondary", "data-action": "metrics-cancel" }, "Cancel") : null));
}

function renderTraining(plan, data, day) {
  const s = plan.training;
  const zone = s.recovery && s.recovery.zone;
  const logged = data.training.filter((t) => t.date === day);
  const week = T.weekTally(data.training, day);

  const describe = (t) => {
    if (t.type === "gym") {
      const sets = t.sets ? " · " + Object.entries(t.sets).map(([g, n]) => GROUP_NAME[g] + " " + n + " sets").join(", ") : "";
      return "Gym: " + groupList(t.groups) + sets;
    }
    const mins = t.durationMin ? t.durationMin + " min" : "";
    if (t.type === "run") return "Run" + (t.distanceKm ? " " + t.distanceKm + " km" : "") + (mins ? " · " + mins : "");
    return "Football" + (mins ? " · " + mins : "");
  };

  const tab = (name, label) => h("button", {
    type: "button", class: "secondary" + (ui.panel === name ? " active" : ""), "data-action": "panel", "data-panel": name,
  }, label);

  let panel = null;
  if (ui.panel === "gym") {
    panel = h("div", { class: "panel" },
      h("div", { class: "chips" }, ["push", "pull", "legs"].map((g) => h("button", {
        type: "button", class: "chip" + (ui.gymGroups.includes(g) ? " on" : ""), "data-action": "gym-chip", "data-group": g,
      }, GROUP_NAME[g]))),
      ui.gymGroups.length ? h("div", { class: "field-row" }, ui.gymGroups.map((g) => h("label", { class: "field" },
        h("span", {}, GROUP_NAME[g] + " sets"),
        h("input", { id: "sets-" + g, type: "text", inputmode: "numeric", placeholder: "optional", value: ui.gymSets[g] || "" })))) : null,
      h("button", { type: "button", class: "wide", "data-action": "log-gym" },
        ui.gymGroups.length ? "Log gym: " + groupList(ui.gymGroups) : "Pick Push / Pull / Legs"));
  } else if (ui.panel === "run") {
    panel = h("div", { class: "panel" },
      h("div", { class: "field-row" },
        h("label", { class: "field" }, h("span", {}, "Distance (km)"), h("input", { id: "run-km", type: "text", inputmode: "decimal", placeholder: "e.g. 5" })),
        h("label", { class: "field" }, h("span", {}, "Duration (min)"), h("input", { id: "run-min", type: "text", inputmode: "numeric", placeholder: "e.g. 30" }))),
      h("button", { type: "button", class: "wide", "data-action": "log-run" }, "Log run"));
  } else if (ui.panel === "football") {
    panel = h("div", { class: "panel" },
      h("div", { class: "field-row" },
        h("label", { class: "field" }, h("span", {}, "Duration (min, optional)"), h("input", { id: "fb-min", type: "text", inputmode: "numeric", placeholder: "e.g. 90" }))),
      h("button", { type: "button", class: "wide", "data-action": "log-football" }, "Log football"));
  }

  const pill = (label, have, target) => h("span", { class: "pill" + (target && have >= target ? " met" : "") },
    label + " " + have + (target ? "/" + target : ""));

  fill("card-training",
    h("div", { class: "card-head" }, h("h2", {}, "Training"),
      zone ? h("span", { class: "badge zone-" + zone }, "Recovery " + zone) : null),
    h("p", { class: "suggest" }, s.label),
    s.detail ? h("p", { class: "muted small tight" }, s.detail) : null,
    details("training-why", "Why?", h("p", { class: "muted small" }, s.reason)),
    logged.length ? h("ul", { class: "logged" }, logged.map((t) => h("li", {}, "✓ " + describe(t)))) : null,
    h("div", { class: "btn-row tabs" }, tab("gym", "+ Gym"), tab("run", "+ Run"), tab("football", "+ Football")),
    panel,
    h("div", { class: "pills" },
      pill("Push", week.groups.push, week.targets.push),
      pill("Pull", week.groups.pull, week.targets.pull),
      pill("Legs", week.groups.legs, week.targets.legs),
      h("span", { class: "pill" + (week.gymSessions >= week.gymMin ? " met" : "") }, "Gym " + week.gymSessions + "/" + week.gymMin + "–" + week.gymMax),
      pill("Runs", week.runs, 0),
      pill("Football", week.football, 0)),
    h("p", { class: "muted small tight" }, "This week (Mon–Sun). A group counts with 3+ sets."));
}

function renderStudy(plan, data, day) {
  const timer = T.getTimer(LS);
  const checked = data.checkoffs[day] || [];
  const minutesToday = data.studySessions.filter((s) => s.date === day).reduce((a, s) => a + s.minutes, 0);

  const runningRow = (t) => h("div", { class: "timer" },
    h("div", { class: "timer-clock" }, h("span", { "data-timer": "clock" }, "0:00"), h("span", { class: "muted" }, " / " + t.minutes + ":00")),
    h("div", { class: "bar" }, h("div", { class: "bar-fill", "data-timer": "bar" })),
    h("div", { class: "btn-row" },
      h("button", { type: "button", "data-action": "timer-finish" }, "Finish & log"),
      h("button", { type: "button", class: "secondary", "data-action": "timer-cancel" }, "Cancel")));

  const blocks = plan.study.blocks.map((b) => {
    const done = checked.includes(b.key);
    const running = timer && timer.blockKey === b.key;
    let action;
    if (done) action = h("p", { class: "done-text" }, "✓ Done");
    else if (running) action = runningRow(timer);
    else action = h("div", { class: "btn-row" },
      h("button", { type: "button", "data-action": "timer-start", "data-key": b.key, disabled: !!timer }, "▶ Start " + b.minutes + " min"),
      h("button", { type: "button", class: "secondary", "data-action": "study-done", "data-key": b.key }, "Did it, log " + b.minutes));
    return h("div", { class: "item" + (done ? " is-done" : "") },
      h("div", { class: "item-title" }, b.subjectName),
      h("p", { class: "muted small tight" }, b.reason),
      action);
  });

  // A timer that isn't one of today's blocks (e.g. started before midnight).
  const orphan = timer && !plan.study.blocks.some((b) => b.key === timer.blockKey)
    ? h("div", { class: "item" }, h("div", { class: "item-title" }, timer.subjectName + " (running)"), runningRow(timer)) : null;

  const subjects = data.subjects.map((s) => h("option", { value: s.id }, s.name));
  fill("card-study",
    h("div", { class: "card-head" }, h("h2", {}, "Study"), h("span", { class: "badge" }, "Today " + minutesToday + " min")),
    orphan,
    blocks.length ? blocks : h("p", { class: "muted" }, plan.study.reason),
    details("study-other", "Log other study",
      h("div", { class: "field-row" },
        h("label", { class: "field grow" }, h("span", {}, "Subject"), h("select", { id: "other-subject" }, subjects)),
        h("label", { class: "field" }, h("span", {}, "Minutes"), h("input", { id: "other-min", type: "text", inputmode: "numeric", value: "45" }))),
      h("button", { type: "button", class: "wide", "data-action": "study-other" }, "Log study")));
  tick();
}

function renderChores(plan) {
  const statusOf = {};
  for (const c of plan.chores.all) statusOf[c.choreId] = c;
  const row = (choreId, name, sub) => {
    const c = statusOf[choreId];
    const done = c.status === "done-today";
    return h("div", { class: "chore" + (done ? " is-done" : "") },
      h("div", {},
        h("div", { class: "item-title" }, name),
        h("span", { class: "status st-" + c.status }, c.label),
        sub ? h("span", { class: "muted small" }, " · " + sub) : null),
      done ? h("span", { class: "done-text" }, "✓")
        : h("button", { type: "button", class: "check", "data-action": "chore-done", "data-id": choreId, "aria-label": "Mark " + name + " done" }, "Done"));
  };
  const every = (c) => c.minDays === c.maxDays ? "every " + c.maxDays + " d" : "every " + c.minDays + "–" + c.maxDays + " d";
  fill("card-chores",
    h("h2", {}, "Chores"),
    plan.chores.chores.map((c) => row(c.choreId, c.name, null)),
    h("p", { class: "muted small tight" }, plan.chores.reason),
    details("chores-all", "All chores", plan.chores.all.map((c) => row(c.choreId, c.name, every(c)))));
}

let lastDay = null;
function render() {
  const day = today();
  lastDay = day;
  const data = store.get();
  const plan = L.planDay(data, day, { lowEnergy: T.isLowEnergy(LS, day) });
  renderHeader(plan);
  renderMetrics(data, day);
  renderTraining(plan, data, day);
  renderStudy(plan, data, day);
  renderChores(plan);
}

// Updates only the running timer (every second), without redrawing the cards.
function tick() {
  const t = T.getTimer(LS);
  if (!t) return;
  const ms = T.elapsedMs(t, Date.now());
  document.querySelectorAll('[data-timer="clock"]').forEach((el) => { el.textContent = T.formatClock(ms); });
  const pct = Math.min(100, (ms / (t.minutes * 60000)) * 100);
  document.querySelectorAll('[data-timer="bar"]').forEach((el) => {
    el.style.width = pct + "%";
    el.classList.toggle("full", pct >= 100);
  });
}

// =====================================================================
// Actions (what each button does)
// =====================================================================

function saveGymSetsTyped() {
  for (const g of ui.gymGroups) { const v = val("sets-" + g); if (v !== "") ui.gymSets[g] = v; }
}

const actions = {
  "metrics-edit": () => { ui.editMetrics = true; render(); },
  "metrics-cancel": () => { ui.editMetrics = false; render(); },
  "metrics-save": () => {
    const recovery = T.parseNum(val("m-recovery")), hrv = T.parseNum(val("m-hrv")), rhr = T.parseNum(val("m-rhr"));
    if ([recovery, hrv, rhr].some(Number.isNaN)) return showToast("Numbers only, please.", false);
    if (recovery === null && hrv === null && rhr === null) return showToast("Type at least one number.", false);
    if (act("Morning metrics", () => store.setMetrics(today(), { recovery, hrv, rhr, source: "manual" }))) {
      ui.editMetrics = false; render();
    }
  },

  panel: (el) => {
    const p = el.dataset.panel;
    if (ui.panel === "gym") saveGymSetsTyped();
    ui.panel = ui.panel === p ? null : p;
    if (ui.panel === "gym") {
      // Pre-pick the suggested muscle groups, so a normal gym day is: + Gym, Log.
      const s = L.planDay(store.get(), today(), { lowEnergy: T.isLowEnergy(LS, today()) }).training;
      ui.gymGroups = s.type === "gym" ? s.focus.slice() : [];
      ui.gymSets = {};
    }
    render();
  },
  "gym-chip": (el) => {
    saveGymSetsTyped();
    const g = el.dataset.group;
    ui.gymGroups = ui.gymGroups.includes(g) ? ui.gymGroups.filter((x) => x !== g)
      : ["push", "pull", "legs"].filter((x) => x === g || ui.gymGroups.includes(x));
    render();
  },
  "log-gym": () => {
    saveGymSetsTyped();
    const groups = ui.gymGroups.slice();
    if (!groups.length) return showToast("Pick at least one: Push, Pull or Legs.", false);
    const sets = {};
    for (const g of groups) {
      const n = T.parseNum(ui.gymSets[g]);
      if (Number.isNaN(n)) return showToast(GROUP_NAME[g] + " sets: numbers only.", false);
      if (n !== null) sets[g] = n;
    }
    const hasSets = Object.keys(sets).length > 0;
    if (act("Gym (" + groupList(groups) + ")", () => store.addGym({ groups, sets: hasSets ? sets : null }))) {
      ui.panel = null; ui.gymSets = {}; render();
    }
  },
  "log-run": () => {
    const km = T.parseNum(val("run-km")), min = T.parseNum(val("run-min"));
    if (Number.isNaN(km) || Number.isNaN(min)) return showToast("Numbers only, please.", false);
    if (act("Run" + (km ? " " + km + " km" : ""), () => store.addRun({ distanceKm: km, durationMin: min }))) {
      ui.panel = null; render();
    }
  },
  "log-football": () => {
    const min = T.parseNum(val("fb-min"));
    if (Number.isNaN(min)) return showToast("Numbers only, please.", false);
    if (act("Football", () => store.addFootball({ durationMin: min }))) { ui.panel = null; render(); }
  },

  "timer-start": (el) => {
    const day = today();
    const b = L.planDay(store.get(), day, { lowEnergy: T.isLowEnergy(LS, day) }).study.blocks.find((x) => x.key === el.dataset.key);
    if (!b) return render();
    try {
      T.startTimer(LS, { blockKey: b.key, subjectId: b.subjectId, subjectName: b.subjectName, minutes: b.minutes, date: day }, Date.now());
    } catch (err) { showToast(err.message, false); }
    render();
  },
  "timer-cancel": () => { T.cancelTimer(LS); showToast("Timer cancelled. Nothing logged.", false); render(); },
  "timer-finish": () => {
    const t = T.getTimer(LS);
    if (!t) return render();
    const r = T.minutesToLog(t, Date.now());
    // Logged on the day the timer STARTED (studying past midnight counts for that day).
    const ok = act(t.subjectName + ", " + r.minutes + " min", () => {
      store.addStudySession({ subjectId: t.subjectId, minutes: r.minutes, date: t.date });
      store.setChecked(t.date, t.blockKey, true);
    });
    if (ok) {
      T.cancelTimer(LS);
      if (r.forgot) showToast("Timer ran " + Math.round(r.real / 60) + " h, so logged " + r.minutes + " min. Wrong? Undo and use \"Log other study\".", true);
      render();
    }
  },
  "study-done": (el) => {
    const day = today();
    const b = L.planDay(store.get(), day, { lowEnergy: T.isLowEnergy(LS, day) }).study.blocks.find((x) => x.key === el.dataset.key);
    if (!b) return render();
    act(b.subjectName + ", " + b.minutes + " min", () => {
      store.addStudySession({ subjectId: b.subjectId, minutes: b.minutes, date: day });
      store.setChecked(day, b.key, true);
    });
  },
  "study-other": () => {
    const subjectId = val("other-subject"), min = T.parseNum(val("other-min"));
    if (!min || Number.isNaN(min)) return showToast("Type the minutes studied.", false);
    const name = (store.get().subjects.find((s) => s.id === subjectId) || {}).name || subjectId;
    act(name + ", " + min + " min", () => store.addStudySession({ subjectId, minutes: min }));
  },

  "chore-done": (el) => {
    const c = store.get().chores.find((x) => x.id === el.dataset.id);
    if (c) act(c.name + " done", () => store.markChoreDone(c.id));
  },
};

function setupEvents() {
  document.body.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el);
  });
  document.getElementById("toast-undo").addEventListener("click", () => {
    document.getElementById("toast").hidden = true;
    undo();
  });
  document.getElementById("undo-pill").addEventListener("click", undo);
  document.getElementById("low-energy").addEventListener("change", (e) => {
    T.setLowEnergy(LS, today(), e.target.checked);
    render();
  });
  // Coming back to the app (or another tab saved something): redraw.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
  window.addEventListener("storage", () => render());
  // Timer every second; new day after midnight.
  setInterval(() => { if (today() !== lastDay) render(); else tick(); }, 1000);
}

// =====================================================================
// Backup card + offline support (from steps 1 and 2)
// =====================================================================

function setBackupStatus(text) {
  document.getElementById("backup-status").textContent = text;
}

function loadData() {
  store.load();
  // If the saved data had to be repaired, say so instead of failing silently.
  if (store.warnings.length) setBackupStatus(store.warnings.join(" "));
}

function setupBackupButtons() {
  const fileInput = document.getElementById("import-file");
  document.getElementById("export-btn").addEventListener("click", () => {
    PlannerData.downloadBackup(store);
    setBackupStatus("Backup file downloaded.");
  });
  document.getElementById("import-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    PlannerData.importBackupFile(store, file)
      .then((msg) => { if (msg === "Backup imported.") T.clearUndo(LS); setBackupStatus(msg); render(); })
      .catch((err) => setBackupStatus("Import failed: " + err.message))
      .finally(() => { fileInput.value = ""; });
  });
}

function registerServiceWorker() {
  const status = document.getElementById("offline-status");
  if (!("serviceWorker" in navigator)) {
    status.textContent = "Offline mode not supported in this browser.";
    return;
  }
  navigator.serviceWorker.register("sw.js")
    .then(() => { status.textContent = "Ready to work offline."; })
    .catch((err) => { status.textContent = "Offline mode failed: " + err.message; });
}

loadData();
setupBackupButtons();
setupEvents();
render();
registerServiceWorker();
