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
| `js/app.js` | App logic |
| `sw.js` | Service worker: stores the files on the phone so it works offline |
| `manifest.webmanifest` | Name, icon and colours for "Add to Home Screen" |
| `icons/` | App icons |
| `sync/` | Laptop Python script for Whoop (step 6) |
| `tests/` | Automated tests (step 3) |

## Run it on the laptop

Open a terminal in this folder and run:

```
python -m http.server 8000
```

Then open http://localhost:8000 in a browser. Stop it with Ctrl+C.

## Updating the app

When you change any file, open `sw.js` and bump `CACHE_VERSION`
(e.g. `planner-v1` to `planner-v2`). Otherwise the phone keeps showing the old copy.

## Install on iPhone

To be written in step 7. Note: iPhone only allows offline mode for pages served
over HTTPS (or localhost), so step 7 will pick a way to serve it securely.

## Build steps

1. Project setup ✅
2. Data model and backups
3. Daily logic and tests
4. Today screen, timer and logging
5. Settings
6. Whoop laptop sync
7. Tests, README and phone install
