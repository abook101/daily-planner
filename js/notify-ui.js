// Daily Planner: the "Notifications & widget" card in Settings, and its buttons.
//
// The rules (what counts as important, checks, uploading) are in js/notify.js and
// tested in tests/notify.test.js. This file only draws the card and wires buttons.
// Loaded after reminders.js and before app.js; uses helpers from settings.js and
// app.js (h, sInput, sField, sCheck, msgLine, formMsg, ...) only when a function runs.
"use strict";

const isStandaloneApp = () =>
  window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

function notifyCard() {
  const c = NF.getConfig(LS);
  const kind = (k, label) => h("label", { class: "check-label" }, sCheck("push__k-" + k, c ? c.kinds[k] : true), h("span", {}, label));
  return h("section", { class: "card" },
    h("h2", {}, "Notifications & widget"),
    h("p", { class: "muted small tight" },
      "Important events show in your iPhone's notifications even when the app is closed, and the widget counts down to the next one. " +
      "This needs your own free Cloudflare Worker (setup steps in push/README.md). The address and key stay on this phone only."),
    isStandaloneApp() ? null : h("p", { class: "form-msg error" },
      "Open the planner from its home-screen icon first. iPhone only allows notifications for apps added to the home screen."),
    h("div", { class: "field-row" },
      sField("Worker address", sInput("push__url", c ? c.url : "", { placeholder: "https://daily-planner-push.yourname.workers.dev", inputmode: "url", autocapitalize: "off" }), "grow")),
    h("div", { class: "field-row" },
      sField("Key (API_KEY)", sInput("push__key", c ? c.key : "", { placeholder: "the secret you set in Cloudflare", autocapitalize: "off", autocomplete: "off" }), "grow")),
    h("div", { class: "field-row" },
      sField("Morning at", sInput("push__morning", c ? c.morning : NF.DEFAULTS.morning, { placeholder: "08:00" })),
      sField("Study at", sInput("push__study", c ? c.study : NF.DEFAULTS.study, { placeholder: "18:00" })),
      sField("Min before", sNum("push__lead", c ? c.lead : NF.DEFAULTS.lead))),
    h("div", { class: "field-row" },
      sField("Hourly until", sInput("push__hourlyEnd", c ? c.hourlyEnd : NF.DEFAULTS.hourlyEnd, { placeholder: "22:00" }))),
    h("div", { class: "panel" },
      kind("reminder", "Reminders (at their time; no time = morning plan time)"),
      kind("digest", "Morning plan (study, chores, reminders, training)"),
      kind("study", "Study nudge if nothing is logged yet today"),
      kind("hourly", "All-day reminders: notify every hour until done"),
      kind("timer", "Study timer finished")),
    h("div", { class: "btn-row" },
      h("button", { type: "button", "data-action": "push-save" }, "Save & turn on"),
      c ? h("button", { type: "button", class: "secondary", "data-action": "push-test" }, "Send test") : null,
      c ? h("button", { type: "button", class: "secondary", "data-action": "push-widget" }, "Copy widget script") : null,
      c ? h("button", { type: "button", class: "secondary", "data-action": "push-off" }, "Turn off") : null),
    h("p", { class: "muted small tight" }, NF.statusLine(LS, Date.now())),
    msgLine("push"));
}

const pushEnv = () => ({
  navigator: window.navigator, hasPushManager: "PushManager" in window, Notification: window.Notification,
  fetchFn: (u, o) => window.fetch(u, o), caches: window.caches,
});

const notifyActions = {
  "push-save": async () => {
    const kinds = {};
    for (const k of ["reminder", "digest", "study", "timer", "hourly"]) kinds[k] = checkedVal("push__k-" + k);
    try {
      NF.setConfig(LS, { url: val("push__url"), key: val("push__key"), morning: val("push__morning"), study: val("push__study"), hourlyEnd: val("push__hourlyEnd"), lead: val("push__lead"), kinds });
    } catch (err) { return formMsg("push", err.message, true); }
    ui.justSaved = "push";
    render();
    formMsg("push", "Saved. Turning notifications on…", false);
    const on = await NF.enablePush(LS, pushEnv());
    if (!on.ok) { render(); return formMsg("push", on.message, true); }
    const up = await NF.syncEvents({
      data: store.get(), storage: LS, fetchFn: pushEnv().fetchFn, nowMs: Date.now(),
      timer: T.getTimer(LS), lowEnergy: (d) => T.isLowEnergy(LS, d), force: true,
    });
    ui.justSaved = "push";
    render();
    formMsg("push", up.ok ? on.message + " " + up.message + " Tap \"Send test\" to see one." : "Notifications are on, but sending events failed: " + up.message, !up.ok);
  },
  "push-test": async () => {
    const c = NF.getConfig(LS);
    if (!c) return;
    formMsg("push", "Sending a test…", false);
    const r = await NF.api(c, "/test", { method: "POST" }, pushEnv().fetchFn);
    if (!r.ok) return formMsg("push", r.error, true);
    formMsg("push", r.data.ok ? "Test sent. It should appear on this phone within a few seconds (leave the app to see it as a banner)." : "The push service refused it: " + r.data.error, !r.data.ok);
  },
  "push-widget": async () => {
    const c = NF.getConfig(LS);
    if (!c) return;
    try {
      await window.navigator.clipboard.writeText(NF.widgetScript(c));
      formMsg("push", "Copied. Open Scriptable, tap +, paste, and name it \"Planner\". Then add a Scriptable widget on your home screen and pick that script (steps in push/README.md).", false);
    } catch (err) {
      formMsg("push", "Couldn't copy automatically. Tap \"Copy widget script\" again while the app is open in front.", true);
    }
  },
  "push-off": async () => {
    if (!window.confirm("Turn off notifications on this phone? The widget script keeps working until you delete the Worker or its key.")) return;
    try {
      const reg = await window.navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      if (window.caches) await window.caches.delete(NF.SW_CACHE);
    } catch (err) { /* still turn off the app side */ }
    NF.clearConfig(LS);
    ui.justSaved = "push";
    render();
    formMsg("push", "Notifications are off.", false);
  },
};
