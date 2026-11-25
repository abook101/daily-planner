// Daily Planner: the Settings screen (opened with the gear on Today).
//
// Only drawing and buttons live here. The rules (what counts as valid, what
// gets removed with a subject, ...) are in js/store.js and are tested in
// tests/settings.test.js. Every save goes through the store, which checks
// everything and saves nothing if anything is wrong.
//
// This file is loaded before app.js and uses its helpers (h, fill, store,
// showToast, ...) only when a function runs, never while loading.
"use strict";

const isSettingsView = () => location.hash === "#settings";

// ---------- form helpers ----------
// Inputs remember their saved value as defaultValue. That way we can tell
// which fields you changed but haven't saved yet, and keep them when the
// screen redraws after saving something else.
function sInput(id, value, attrs) {
  const el = h("input", Object.assign({ id, type: "text", autocomplete: "off" }, attrs || {}));
  el.defaultValue = value === null || value === undefined ? "" : String(value);
  el.value = el.defaultValue;
  return el;
}
function sCheck(id, checked) {
  const el = h("input", { id, type: "checkbox" });
  el.defaultChecked = !!checked;
  el.checked = !!checked;
  return el;
}
const sField = (label, input, cls) => h("label", { class: "field" + (cls ? " " + cls : "") }, h("span", {}, label), input);
const sNum = (id, value, ph) => sInput(id, value, { inputmode: "numeric", placeholder: ph || "" });
const sDate = (id, value) => sInput(id, value, { type: "date" });
const msgLine = (key) => h("p", { class: "form-msg", "data-msg": key, role: "status" });
const checkedVal = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
// Whole numbers typed by hand: "" -> null, "3" -> 3, "abc" -> NaN (the store then says what's wrong).
const intVal = (id) => T.parseNum(val(id));

function hoursText(minutes) {
  if (minutes < 60) return minutes + " min";
  const hrs = Math.floor(minutes / 60), m = minutes % 60;
  return hrs + " h" + (m ? " " + m + " min" : "");
}

// ---------- drawing ----------

function subjectRow(s, usage) {
  const p = "subj-" + s.id;
  return h("div", { class: "item set-item" },
    sField("Name", sInput(p + "__name", s.name, { maxlength: PlannerData.NAME_MAX })),
    h("div", { class: "field-row" },
      sField("Exam date", sDate(p + "__date", s.examDate), "grow"),
      h("label", { class: "check-label" }, sCheck(p + "__conf", s.examDateConfirmed), h("span", {}, "Date is final"))),
    h("p", { class: "muted small tight" }, usage.sessions
      ? usage.sessions + " study session" + (usage.sessions === 1 ? "" : "s") + " logged (" + hoursText(usage.minutes) + ")"
      : "Nothing logged yet"),
    h("div", { class: "btn-row" },
      h("button", { type: "button", "data-action": "set-subject-save", "data-id": s.id }, "Save"),
      h("button", { type: "button", class: "danger", "data-action": "set-subject-remove", "data-id": s.id }, "Remove")),
    msgLine(p));
}

function choreRow(c) {
  const p = "chore-" + c.id;
  return h("div", { class: "item set-item" },
    sField("Name", sInput(p + "__name", c.name, { maxlength: PlannerData.NAME_MAX })),
    h("div", { class: "field-row" },
      sField("Every (days)", sNum(p + "__min", c.minDays)),
      sField("to (days)", sNum(p + "__max", c.maxDays)),
      sField("Last done", sDate(p + "__last", c.lastDone), "grow")),
    h("div", { class: "btn-row" },
      h("button", { type: "button", "data-action": "set-chore-save", "data-id": c.id }, "Save"),
      h("button", { type: "button", class: "danger", "data-action": "set-chore-remove", "data-id": c.id }, "Remove")),
    msgLine(p));
}

function renderSettings() {
  const data = store.get();
  const st = PlannerData.settingsOf(data);

  // Keep what you typed but haven't saved (except the form just saved).
  const keep = {};
  document.querySelectorAll("#settings-main input").forEach((el) => {
    if (ui.justSaved && el.id.startsWith(ui.justSaved + "__")) return;
    if (el.type === "checkbox" ? el.checked !== el.defaultChecked : el.value !== el.defaultValue) {
      keep[el.id] = el.type === "checkbox" ? el.checked : el.value;
    }
  });
  ui.justSaved = null;

  const usage = {};
  for (const s of data.studySessions) {
    const u = usage[s.subjectId] || (usage[s.subjectId] = { sessions: 0, minutes: 0 });
    u.sessions++; u.minutes += s.minutes;
  }
  const subjects = data.subjects.slice().sort((a, b) => (a.examDate || "9999").localeCompare(b.examDate || "9999"));

  fill("settings-main",
    h("section", { class: "card" },
      h("h2", {}, "Subjects and exams"),
      h("p", { class: "muted small tight" }, "Leave the date empty if it isn't known yet. Tick \"Date is final\" once it's confirmed (the ~ on Today goes away)."),
      subjects.map((s) => subjectRow(s, usage[s.id] || { sessions: 0, minutes: 0 })),
      details("set-add-subject", "+ Add subject",
        h("div", { class: "panel" },
          sField("Name", sInput("new-subj__name", "", { maxlength: PlannerData.NAME_MAX, placeholder: "e.g. Thermodynamics" })),
          h("div", { class: "field-row" },
            sField("Exam date", sDate("new-subj__date", null), "grow"),
            h("label", { class: "check-label" }, sCheck("new-subj__conf", false), h("span", {}, "Date is final"))),
          h("button", { type: "button", class: "wide", "data-action": "set-subject-add" }, "Add subject"),
          msgLine("new-subj")))),

    h("section", { class: "card" },
      h("h2", {}, "Chores"),
      h("p", { class: "muted small tight" }, "\"Every 5 to 7 days\": due after 5, overdue after 7. 1 to 1 = daily. Set \"Last done\" if you did it without logging."),
      data.chores.map(choreRow),
      details("set-add-chore", "+ Add chore",
        h("div", { class: "panel" },
          sField("Name", sInput("new-chore__name", "", { maxlength: PlannerData.NAME_MAX, placeholder: "e.g. Clean bathroom" })),
          h("div", { class: "field-row" },
            sField("Every (days)", sNum("new-chore__min", "", "e.g. 7")),
            sField("to (days)", sNum("new-chore__max", "", "e.g. 10")),
            sField("Last done", sDate("new-chore__last", null), "grow")),
          h("button", { type: "button", class: "wide", "data-action": "set-chore-add" }, "Add chore"),
          msgLine("new-chore")))),

    h("section", { class: "card" },
      h("h2", {}, "Training targets (per week, Mon–Sun)"),
      h("div", { class: "field-row" },
        sField("Gym sessions, min", sNum("tgt__gymMin", st.gymMin)),
        sField("Gym sessions, max", sNum("tgt__gymMax", st.gymMax))),
      h("div", { class: "field-row" },
        sField("Push", sNum("tgt__push", st.push)),
        sField("Pull", sNum("tgt__pull", st.pull)),
        sField("Legs", sNum("tgt__legs", st.legs))),
      h("div", { class: "field-row" },
        sField("Runs (football counts)", sNum("tgt__runs", st.runs))),
      h("p", { class: "muted small tight" }, "One gym session can cover several groups (e.g. upper body = Push + Pull). Defaults: gym 3–4, Push 2, Pull 2, Legs 1, runs 2."),
      h("button", { type: "button", class: "wide", "data-action": "set-targets-save" }, "Save training targets"),
      msgLine("tgt")),

    h("section", { class: "card" },
      h("h2", {}, "Study"),
      h("div", { class: "field-row" },
        sField("Study block length (minutes)", sNum("study__blockMin", st.studyBlockMin))),
      h("p", { class: "muted small tight" }, "Used for the timer and \"Did it, log\" buttons from now on. Already logged sessions keep their minutes. Default 45."),
      h("button", { type: "button", class: "wide", "data-action": "set-study-save" }, "Save study block"),
      msgLine("study")));

  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v; else el.value = v;
  }
}

// ---------- saving ----------

// Shows a message under the form. Errors stay until the next try.
function formMsg(key, text, isError) {
  const el = document.querySelector('[data-msg="' + key + '"]');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

// Saves through the store with an undo copy. If the store refuses, the
// typed values stay on screen with the reason, and nothing is changed.
function saveSetting(formKey, label, fn) {
  try {
    T.withUndo(store, LS, label, fn, Date.now());
  } catch (err) {
    formMsg(formKey, T.friendlyError(err), true);
    showToast(T.friendlyError(err), false);
    return false;
  }
  ui.justSaved = formKey;
  showToast(label, true);
  render();
  return true;
}

const settingsActions = {
  "open-settings": () => { location.hash = "settings"; },
  "close-settings": () => { history.replaceState(null, "", location.pathname + location.search); render(); window.scrollTo(0, 0); },

  "set-subject-save": (el) => {
    const id = el.dataset.id, p = "subj-" + id;
    const name = val(p + "__name");
    saveSetting(p, "Saved " + (name.trim() || "subject"), () => store.updateSubject(id, {
      name, examDate: val(p + "__date") || null, examDateConfirmed: checkedVal(p + "__conf"),
    }));
  },
  "set-subject-add": () => {
    const name = val("new-subj__name");
    if (saveSetting("new-subj", "Added " + name.trim(), () => store.addSubject({
      name, examDate: val("new-subj__date") || null, examDateConfirmed: checkedVal("new-subj__conf"),
    }))) { ui.open["set-add-subject"] = false; render(); }
  },
  "set-subject-remove": (el) => {
    const s = store.get().subjects.find((x) => x.id === el.dataset.id);
    if (!s) return render();
    const timer = T.getTimer(LS);
    if (timer && timer.subjectId === s.id) {
      return formMsg("subj-" + s.id, "A study timer is running for this subject. Finish or cancel it on Today first.", true);
    }
    const u = store.subjectUsage(s.id);
    const msg = "Remove \"" + s.name + "\"?\n\n" + (u.sessions
      ? "This also DELETES its " + u.sessions + " logged study session" + (u.sessions === 1 ? "" : "s") +
        " (" + hoursText(u.minutes) + "). You can undo right after, and exporting a backup first keeps a copy."
      : "Nothing is logged for it yet.");
    if (!window.confirm(msg)) return;
    saveSetting("subj-" + s.id, "Removed " + s.name, () => store.removeSubject(s.id));
  },

  "set-chore-save": (el) => {
    const id = el.dataset.id, p = "chore-" + id;
    const name = val(p + "__name");
    saveSetting(p, "Saved " + (name.trim() || "chore"), () => store.updateChore(id, {
      name, minDays: intVal(p + "__min"), maxDays: intVal(p + "__max"), lastDone: val(p + "__last") || null,
    }));
  },
  "set-chore-add": () => {
    const name = val("new-chore__name");
    if (saveSetting("new-chore", "Added " + name.trim(), () => store.addChore({
      name, minDays: intVal("new-chore__min"), maxDays: intVal("new-chore__max"), lastDone: val("new-chore__last") || null,
    }))) { ui.open["set-add-chore"] = false; render(); }
  },
  "set-chore-remove": (el) => {
    const c = store.get().chores.find((x) => x.id === el.dataset.id);
    if (!c) return render();
    if (!window.confirm("Remove the chore \"" + c.name + "\"? It disappears from Today. You can undo right after.")) return;
    saveSetting("chore-" + c.id, "Removed " + c.name, () => store.removeChore(c.id));
  },

  "set-targets-save": () => {
    const v = {};
    for (const k of ["gymMin", "gymMax", "push", "pull", "legs", "runs"]) v[k] = intVal("tgt__" + k);
    saveSetting("tgt", "Saved training targets", () => store.setSettings(v));
  },
  "set-study-save": () => {
    saveSetting("study", "Saved study block length", () => store.setSettings({ studyBlockMin: intVal("study__blockMin") }));
  },
};
