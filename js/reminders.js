// Daily Planner: the Reminders screen (bell on Today) and the Reminders card on Today.
//
// Reminders are for anything the rest of the app doesn't cover. Name and start
// date are required; end date, time, location and description are optional.
// The rules (what's valid, how they're sorted) are in js/store.js and tested
// in tests/reminders.test.js. Reminders are part of the saved data, so they
// are in every Export backup.
//
// Loaded after settings.js and before app.js; uses their helpers (h, fill,
// store, sInput, sField, msgLine, saveSetting, ...) only when a function runs.
"use strict";

const isRemindersView = () => location.hash === "#reminders";

// "2026-12-01" -> a local Date (no time zone surprises).
function remDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const remDay = (s) => remDate(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const daysBetween = (from, to) => Math.round((remDate(to) - remDate(from)) / 86400000);

function remWhen(r) {
  return r.endDate ? remDay(r.startDate) + " – " + remDay(r.endDate) : remDay(r.startDate);
}
function remSoon(r, day) {
  const n = daysBetween(day, r.startDate);
  if (n === 1) return "tomorrow";
  if (n > 1 && n <= 13) return "in " + n + " days";
  return null;
}
// One line: date(s) · time · location (any part can be missing).
function remMeta(parts) {
  return h("p", { class: "muted small tight rem-meta" }, parts.filter(Boolean).join(" · "));
}

const remLast = (r) => r.endDate || r.startDate;
// "carried over from Wed 25 Nov" for a reminder that comes back after its last day.
const remCarriedNote = (r, day) => (PlannerData.reminderState(r, day) === "carried" ? "carried over from " + remDay(remLast(r)) : null);
const remDoneBtn = (r, day) => PlannerData.reminderState(r, day) === "done"
  ? h("button", { type: "button", class: "link", "data-action": "rem-undone", "data-id": r.id, "aria-label": "Undo done for " + r.name }, "Undo")
  : h("button", { type: "button", class: "done-btn", "data-action": "rem-done", "data-id": r.id, "aria-label": "Mark " + r.name + " done" }, "Done");

// ---------- Today card ----------
// Shows reminders for today: running multi-day ones and carried-over ones too, until marked done. Hidden when none.
function renderRemindersCard(data, day) {
  const card = document.getElementById("card-reminders");
  const list = PlannerData.reminderGroups(data.reminders, day).today;
  card.hidden = list.length === 0;
  if (!list.length) { card.replaceChildren(); return; }
  fill("card-reminders",
    h("div", { class: "card-head" },
      h("h2", {}, "Reminders"),
      h("button", { type: "button", class: "link", "data-action": "open-reminders" }, "All ›")),
    list.map((r) => h("div", { class: "item" },
      h("div", { class: "rem-row" },
        h("div", { class: "item-title" }, r.name),
        remDoneBtn(r, day)),
      remMeta([remCarriedNote(r, day), r.time, r.location, r.endDate ? "until " + remDay(r.endDate) : null]),
      r.description ? h("p", { class: "small tight rem-desc" }, r.description) : null)));
}

// ---------- Reminders screen ----------

function remTextarea(id, value) {
  const el = h("textarea", { id, rows: "3", maxlength: PlannerData.REMINDER_DESC_MAX });
  el.defaultValue = value || "";
  el.value = el.defaultValue;
  return el;
}

// The form for a new reminder (p = "new-rem") or for editing one (p = "rem-<id>").
function reminderForm(p, r, buttons) {
  r = r || {};
  return h("div", { class: "rem-form" },
    sField("Name *", sInput(p + "__name", r.name, { maxlength: PlannerData.REMINDER_NAME_MAX, placeholder: "e.g. Call the landlord" })),
    h("div", { class: "field-row" },
      sField("Start date *", sDate(p + "__start", r.startDate), "grow"),
      sField("End date", sDate(p + "__end", r.endDate), "grow")),
    h("div", { class: "field-row" },
      sField("Time", sInput(p + "__time", r.time, { type: "time" })),
      sField("Location", sInput(p + "__loc", r.location, { maxlength: PlannerData.REMINDER_PLACE_MAX, placeholder: "optional" }), "grow")),
    h("div", { class: "field-row" },
      sField("Description", remTextarea(p + "__desc", r.description), "grow")),
    h("label", { class: "check-label wrap" }, sCheck(p + "__carry", !!r.carryOver), h("span", {}, "Carry over to the next day if I haven't marked it done")),
    h("label", { class: "check-label wrap" }, sCheck(p + "__hourly", r.hourly !== false), h("span", {}, "All-day: notify me every hour until it's done")),
    buttons,
    msgLine(p));
}

function reminderItem(r, day) {
  if (ui.editReminder === r.id) {
    const p = "rem-" + r.id;
    return h("div", { class: "item set-item" },
      reminderForm(p, r, h("div", { class: "btn-row" },
        h("button", { type: "button", "data-action": "rem-save", "data-id": r.id }, "Save"),
        h("button", { type: "button", class: "secondary", "data-action": "rem-cancel" }, "Cancel"),
        h("button", { type: "button", class: "danger", "data-action": "rem-delete", "data-id": r.id }, "Delete"))));
  }
  return h("div", { class: "item rem-item" + (PlannerData.reminderState(r, day) === "done" ? " rem-done" : "") },
    h("div", { class: "rem-row" },
      h("div", { class: "item-title" }, r.name),
      h("div", { class: "rem-btns" },
        ["open", "carried", "done"].includes(PlannerData.reminderState(r, day)) ? remDoneBtn(r, day) : null,
        h("button", { type: "button", class: "link", "data-action": "rem-edit", "data-id": r.id, "aria-label": "Edit " + r.name }, "Edit"),
        h("button", { type: "button", class: "link danger-link", "data-action": "rem-delete", "data-id": r.id, "aria-label": "Delete " + r.name }, "Delete"))),
    remMeta([remWhen(r), remSoon(r, day), remCarriedNote(r, day), r.time, r.location, r.carryOver ? "repeats until done" : null]),
    r.description ? h("p", { class: "small tight rem-desc" }, r.description) : null);
}

function renderReminders() {
  const day = today();
  const data = store.get();
  const g = PlannerData.reminderGroups(data.reminders, day);
  if (ui.editReminder && !data.reminders.some((r) => r.id === ui.editReminder)) ui.editReminder = null;

  // Keep what you typed but haven't saved (except the form just saved).
  const keep = {};
  document.querySelectorAll("#reminders-main input, #reminders-main textarea").forEach((el) => {
    if (ui.justSaved && el.id.startsWith(ui.justSaved + "__")) return;
    if (el.value !== el.defaultValue) keep[el.id] = el.value;
  });
  ui.justSaved = null;

  const section = (title, list, empty) => h("section", { class: "card" },
    h("h2", {}, title),
    list.length ? list.map((r) => reminderItem(r, day)) : h("p", { class: "muted small tight" }, empty));

  fill("reminders-main",
    h("section", { class: "card" },
      h("h2", {}, "New reminder"),
      reminderForm("new-rem", null,
        h("button", { type: "button", class: "wide", "data-action": "rem-add" }, "Add reminder"))),
    g.today.length ? section("Today", g.today, "") : null,
    g.done.length ? section("Done today", g.done, "") : null,
    section("Upcoming", g.upcoming, "Nothing coming up."),
    g.past.length ? h("section", { class: "card" },
      details("rem-past", "Past (" + g.past.length + ")", g.past.map((r) => reminderItem(r, day)))) : null);

  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (el) el.value = v;
  }
}

// ---------- buttons ----------

function reminderFields(p) {
  return {
    name: val(p + "__name"),
    startDate: val(p + "__start"),
    endDate: val(p + "__end") || null,
    time: val(p + "__time") || null,
    location: val(p + "__loc"),
    description: val(p + "__desc"),
    carryOver: checkedVal(p + "__carry"),
    hourly: checkedVal(p + "__hourly"),
  };
}

const remindersActions = {
  "open-reminders": () => { location.hash = "reminders"; },
  "rem-add": () => {
    const f = reminderFields("new-rem");
    saveSetting("new-rem", "Added reminder: " + f.name.trim(), () => store.addReminder(f));
  },
  "rem-done": (el) => {
    const r = store.get().reminders.find((x) => x.id === el.dataset.id);
    if (!r) return render();
    saveSetting("rem-" + r.id, "Done: " + r.name, () => store.setReminderDone(r.id, today(), true));
  },
  "rem-undone": (el) => {
    const r = store.get().reminders.find((x) => x.id === el.dataset.id);
    if (!r) return render();
    saveSetting("rem-" + r.id, "Not done: " + r.name, () => store.setReminderDone(r.id, today(), false));
  },
  "rem-edit": (el) => { ui.editReminder = el.dataset.id; render(); },
  "rem-cancel": () => { ui.editReminder = null; render(); },
  "rem-save": (el) => {
    const id = el.dataset.id, p = "rem-" + id, f = reminderFields(p);
    if (saveSetting(p, "Saved reminder: " + f.name.trim(), () => store.updateReminder(id, f))) {
      ui.editReminder = null; render();
    }
  },
  "rem-delete": (el) => {
    const r = store.get().reminders.find((x) => x.id === el.dataset.id);
    if (!r) return render();
    if (ui.editReminder === r.id) ui.editReminder = null;
    saveSetting("rem-" + r.id, "Deleted reminder: " + r.name, () => store.removeReminder(r.id));
  },
};
