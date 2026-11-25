// Daily Planner: main script.
// Step 1 only shows today's date and registers the service worker (offline support).
"use strict";

function showTodayDate() {
  const el = document.getElementById("today-date");
  el.textContent = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
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

showTodayDate();
registerServiceWorker();
