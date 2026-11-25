// Daily Planner: main script.
// Shows today's date, loads the saved data, wires the backup buttons,
// and registers the service worker (offline support).
"use strict";

const store = PlannerData.createStore(window.localStorage);

function showTodayDate() {
  const el = document.getElementById("today-date");
  el.textContent = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });
}

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
      .then(setBackupStatus)
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

showTodayDate();
loadData();
setupBackupButtons();
registerServiceWorker();
