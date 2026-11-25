# Daily Planner

A personal planner that runs on my iPhone home screen and works offline.
Plain HTML, CSS and JavaScript: no frameworks, no build step, no installs.
All data stays on the phone (browser local storage).

## What it will do

- Exam countdowns for my 6 subjects
- 45-minute study blocks with a timer
- Chore rotation (each chore has a "due every X–Y days" range)
- Logging gym sessions (Push / Pull / Legs), runs and football
- A daily suggestion: run, gym or rest, based on Whoop recovery, HRV and resting HR
- A laptop Python script that sends Whoop data to the phone over home Wi-Fi

## Folder layout

| Path | What it is |
|---|---|
| `index.html` | The single page of the app |
| `css/styles.css` | Look and layout (mobile first) |
| `js/app.js` | App logic (screen) |
| `js/store.js` | Data layer: saving, checking and backing up all data |
| `sw.js` | Service worker: stores the files on the phone so it works offline |
| `manifest.webmanifest` | Name, icon and colours for "Add to Home Screen" |
| `icons/` | App icons |
| `sync/` | Laptop Python script for Whoop (step 6) |
| `tests/` | Automated tests (open `/tests/` in the browser) |

## Run it on the laptop

Open a terminal in this folder and run:

```
python -m http.server 8000
```

Then open http://localhost:8000 in a browser. Stop it with Ctrl+C.

## Updating the app

When you change any file, open `sw.js` and bump `CACHE_VERSION`
(e.g. `planner-v1` to `planner-v2`). Otherwise the phone keeps showing the old copy.

## How data is stored

Everything is one JSON document in the browser's local storage (key `planner.data`).

- Every change is checked first. If something is wrong (unknown subject, negative minutes,
  recovery over 100 %, ...) nothing is saved.
- The previous good copy is kept (`planner.data.prev`). If the main copy ever gets
  corrupted, the app restores the previous copy and keeps the broken text under
  `planner.corrupt.<time>` instead of deleting it.
- `schemaVersion` says which data layout is saved. When a later step changes the layout,
  a migration upgrades the old data, after saving a full copy as `planner.backup.v<old>`.

**Backups:** the Backup card has *Export backup* (downloads `planner-backup-<date>.json`)
and *Import backup* (checks the file, shows what's in it, and asks before replacing
anything; the data you had is kept as `planner.backup.before-import`).
Note: on iPhone, local storage can be wiped if the app isn't opened for a few weeks or
the phone is low on space, so export a backup regularly (e.g. weekly, to Files/iCloud).

## Install on iPhone

To be written in step 7. Note: iPhone only allows offline mode for pages served
over HTTPS (or localhost), so step 7 will pick a way to serve it securely.

## Build steps

1. Project setup ✅
2. Data model and backups ✅
3. Daily logic and tests
4. Today screen, timer and logging
5. Settings
6. Whoop laptop sync
7. Tests, README and phone install
