# Daily Planner

A personal planner that runs on my iPhone home screen and works offline.
Live at **https://abook101.github.io/daily-planner/** (see *Put it online* below).
Plain HTML, CSS and JavaScript: no frameworks, no build step, no installs.
All data stays on the phone (browser local storage).

## What it does

- Exam countdowns for my 6 subjects
- 45-minute study blocks with a timer
- Chore rotation (each chore has a "due every X–Y days" range)
- Logging gym sessions (Push / Pull / Legs), runs and football
- A daily suggestion: run, gym or rest, based on Whoop recovery, HRV and resting HR
- A laptop Python script that sends Whoop data to the phone over home Wi-Fi
- Reminders for anything else (name + start date; optional end date, time, location, description)

## Folder layout

| Path | What it is |
|---|---|
| `index.html` | The single page of the app |
| `css/styles.css` | Look and layout (mobile first) |
| `js/app.js` | The Today screen: draws the cards and wires the buttons |
| `js/store.js` | Data layer: saving, checking and backing up all data |
| `js/plan.js` | Daily plan logic: what to study, which chores, run/gym/rest |
| `js/today.js` | Today screen rules: study timer, undo, low energy switch, week tally |
| `js/settings.js` | The Settings screen (gear on Today) |
| `js/reminders.js` | The Reminders screen (bell on Today) and the Reminders card on Today |
| `js/sync.js` | Whoop numbers from the laptop: fetching and the merge rules |
| `sw.js` | Service worker: stores the files on the phone so it works offline (internet first, stored copy when offline) |
| `manifest.webmanifest` | Name, icon and colours for "Add to Home Screen" |
| `icons/` | App icons |
| `privacy.html` | Short privacy page (also linked from the Whoop developer app) |
| `sync/` | Laptop Python program for Whoop (see `sync/README.md`) |
| `tests/` | Automated tests (open `/tests/` in the browser) |
| `tools/build_site.py` | Copies only the app files into `_site/` for the website |
| `.github/workflows/pages.yml` | Runs all tests and publishes the website on every push |

## Run it on the laptop

Open a terminal in this folder and run:

```
python -m http.server 8000
```

Then open http://localhost:8000 in a browser. Stop it with Ctrl+C.

## Updating the app

When you change any file, bump `CACHE_VERSION` in `sw.js` (e.g. `planner-v8` to
`planner-v9`) and `APP_VERSION` in `js/app.js` (`"8"` to `"9"`); a test checks they match.
The version shows at the bottom of Today, so you can see which one the phone runs.
A new app file must also be added to the `FILES` list in `sw.js` (that list is
also what gets published, see below).

Then publish (see *Put it online*). The app loads its files from the internet
first when it can (stored copy when offline), so the phone shows the new version
the next time it's opened with internet.

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

## How the daily plan works (`js/plan.js`)

`PlannerLogic.planDay(data, "YYYY-MM-DD", { lowEnergy })` returns today's plan.
It only reads the data it is given (never saves anything), and every suggestion
comes with a short reason. All the numbers below are settings at the top of the file.

**Study (2 blocks of 45 min).** Each subject gets a score:
how close the exam is (1 / days left², so the closer exam matters much more)
x how little you studied it in the last 14 days (300 min studied halves its score).
The top 2 subjects get a block each. If an exam is 3 days away or less, both blocks go to it.
Finished exams are skipped. Only sessions before today count, so the plan
doesn't reshuffle after you log your first block.

**Chores.** Each chore is *not due* (under min days), *due* (min to max days),
*overdue* (over max days) or *never logged*. Dishes (daily) are always on the list,
plus the most overdue other chore, plus a second one only if it is overdue too.
"Most overdue" = days since done / max days. A chore you already did today uses up a slot.

**Training (run / gym / rest).** In this order:
1. Already logged training today → done.
2. Low energy mode → rest or easy walk.
3. An exam within 2 days → rest or a light walk.
4. Whoop recovery: red (under 34 %) → rest; yellow (34–66 %) → easy zone-2 run;
   green (67 %+) → gym. HRV 15 %+ below its 7-day average → rest. Resting HR 5+ bpm
   above its 7-day average → one colour worse. (Averages need 3+ days of data.)
5. Gym picks the muscle group furthest behind this week's targets
   (Push 2, Pull 2, Legs 1, at least 3 sets each; max 4 gym sessions, week = Mon–Sun).
   If more is left than gym days, groups are combined (e.g. Upper body = Push + Pull).
   If the weekly gym target is met → run instead (runs + football target: 2/week).
6. No Whoop data → decided from the week's progress alone.

**Low energy mode.** 1 study block, dishes only, rest or a walk, so no day is a total zero.

## The Today screen (step 4)

From top to bottom:

- **Low energy switch** (top right): switches to the minimal plan (1 study block, dishes,
  rest or walk). It turns itself off the next day.
- **Exam strip**: days left per subject, nearest first (scroll sideways).
  Red = 7 days or less, yellow = 21 or less. `~` = exam date not final yet.
- **Morning metrics**: recovery %, HRV, resting HR. If Whoop data is already there it shows
  "From Whoop"; otherwise type the numbers (saved as typed in). Any one number is enough.
- **Training**: today's suggestion (tap *Why?* for the reason), then *+ Gym* (Push/Pull/Legs chips,
  the suggested ones are already picked; sets are optional), *+ Run* (km and minutes, both optional),
  *+ Football*. Below: this week's progress including today.
- **Study**: today's 45-min blocks. *Start* starts a timer; only the start time is saved, so
  closing the app or reloading doesn't stop it. *Finish & log* logs the real minutes on the day
  the timer started. If it ran over 2x the block (forgot to stop it), it logs 45 min and says so.
  *Did it, log 45* logs without the timer. *Log other study* = any subject, any minutes.
- **Chores**: today's chores with their status; *Done* sets "last done" to today.
  *All chores* lists every chore.
- **Undo**: after every log a message with *Undo* shows for 8 s; after that the
  "Undo last" button under the exams works for 12 h. Undo only reverses the last log, and
  refuses if other data changed since (e.g. a Whoop sync), so it can't wipe anything else.

The timer, undo copy and low energy switch are kept in separate local storage keys
(`planner.timer`, `planner.undo`, `planner.lowEnergy`), not in backups.

## Settings (step 5)

Tap the gear (top right on Today). The address becomes `#settings`; *‹ Today* goes back.

- **Subjects and exams**: rename, set or clear the exam date, tick *Date is final*
  (removes the `~` on Today). *+ Add subject* adds one. *Remove* asks first and says how
  many study sessions are logged for it: those are deleted with the subject (a session
  must belong to a subject). Renaming keeps all logged sessions.
- **Chores**: rename, *Every X to Y days*, and *Last done* (to set it by hand, or empty =
  not logged yet; can't be in the future). Add and remove (asks first). 1 to 1 = daily.
- **Training targets** per week: gym sessions min/max (3–4), Push/Pull/Legs (2/2/1),
  runs (2, football counts too). A group can't need more sessions than the gym max.
- **Study block length**: 45 min by default (10–180). Changes the timer and
  *Did it, log* from now on; already logged minutes stay as they are.

Every Save goes through the data layer's checks. If anything is wrong, a red message
says why, what you typed stays on screen, and nothing is saved. Each save or removal can
be undone with *Undo* (same as logs on Today). Unsaved edits in other boxes are kept
when you save one box.

The targets and block length are saved in the data as `settings` (so they're in backups).
Data from before step 5 has no `settings` and simply uses the defaults: no migration needed.

## Reminders

Tap the bell (top right on Today). The address becomes `#reminders`; *‹ Today* goes back.

- **New reminder**: *Name* and *Start date* are required. *End date*, *Time*, *Location*
  and *Description* are optional. The end date can't be before the start date.
- The list is split into **Today** (today is between start and end date), **Upcoming**
  (sorted by date, then time; "tomorrow" / "in 3 days") and **Past** (folded away).
- *Edit* opens the reminder's form in place; *Delete* removes it (with *Undo*).
- On Today, a **Reminders** card shows everything for today (multi-day ones every day
  until they end). It's hidden when there's nothing.
- Reminders are only shown in the app. They don't send phone notifications (that would
  need a server).

Reminders are saved in the data as `reminders` (schemaVersion 2), so they're in every
backup. Data and backups from version 1 are upgraded automatically with an empty list
(a copy of the old data is kept as `planner.backup.v1`).

## Whoop sync from the laptop (step 6)

A Python program on the laptop (`sync/whoop_sync.py`, standard library only)
downloads recovery, HRV, resting HR, sleep and workouts from Whoop's official API
and serves them over https on the home Wi-Fi. The app fetches them by itself when
opened at home (at most every 10 min; *Sync now* on Today forces it). Setup,
everyday use and troubleshooting: **`sync/README.md`**.

- Typed numbers are never overwritten. If Whoop's differ, Today shows "Whoop says …"
  with a *Use Whoop numbers* button (it can be undone).
- Whoop entries also keep sleep (`sleepHours`, `sleepPerf`), shown under the metrics.
- Laptop address + sync key are saved in local storage `planner.sync` (this phone only,
  not in backups); last result in `planner.syncStatus`, last Whoop numbers in
  `planner.whoopLatest`.
- Laptop off / away / not set up: nothing breaks, type the numbers as before.

## Run the tests

All of these need nothing installed except Python (and Node, optional):

| What | How | Count |
|---|---|---|
| App (in the browser) | `python -m http.server 8000`, open http://localhost:8000/tests/ | 126 |
| App (Node) | `node tests/data.test.js` (and `plan`, `today`, `settings`, `sync`, `reminders`) | 126 |
| Laptop sync | `python sync/test_whoop_sync.py` | 21 |
| Website has no private files | `python tools/test_build_site.py` | 4 |

GitHub also runs all of them on every push and only publishes if they pass.

## Put it online (GitHub Pages, free)

iPhone only allows offline mode and "Add to Home Screen" apps for **https** pages,
so the app is hosted on GitHub Pages: **https://abook101.github.io/daily-planner/**

- The GitHub repository is **public** (free Pages needs that). It holds the code only.
  Your planner data is on the phone, and the Whoop settings, login tokens,
  certificates and Whoop data are ignored by git (`.gitignore`), so they're never
  uploaded. `tools/test_build_site.py` fails if one of them is ever tracked.
- The **website** only gets the app files listed in `sw.js` plus `sw.js` and
  `privacy.html` (`tools/build_site.py`). Nothing from `sync/`, `tests/` or `tools/`.
- Publishing = pushing to `main` on GitHub. The *Publish app* workflow
  (`.github/workflows/pages.yml`) runs all tests, then publishes. Takes ~1 minute.
  See it under the repository's **Actions** tab (green tick = live).

One-time GitHub setup (done in step 7): repository `abook101/daily-planner`,
Settings → Pages → *Source: GitHub Actions*.

## Install on iPhone

1. iPhone in **Safari** (must be Safari): open https://abook101.github.io/daily-planner/
2. Tap the **Share** button (square with an arrow) → scroll → **Add to Home Screen** →
   name *Planner* → **Add**.
3. Open **Planner from the home screen** (not Safari) once while online. The footer
   says it's ready for offline use. From then on it works in airplane mode too.
4. The home-screen app has its **own** storage, separate from Safari. Set it up
   (Settings, laptop sync) inside the home-screen app.
5. Had data on another device/browser? There: *Export backup*. On the phone:
   *Import backup*.

Updates arrive by themselves the next time you open the app with internet.
Check the version number at the bottom of Today.

## Whoop sync starts with Windows (optional)

Double-click **`sync/autostart-on.bat`** once. It puts one small file,
`Daily Planner Whoop sync.bat`, in your Windows Startup folder
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`). From then on,
each time you log in to Windows, the sync window opens minimised in the taskbar.
If Wi-Fi isn't connected yet at login, the sync notices the address within
a minute and makes a matching certificate by itself.

**To remove it:** double-click **`sync/autostart-off.bat`** (or press Win+R, type
`shell:startup`, Enter, and delete `Daily Planner Whoop sync.bat`). Close the
sync window (or restart) to stop the one that's running now.

Note: the sync only works while the laptop is **on and awake**. If it sleeps,
type the numbers on the phone as before.

## Backup and restore

- **Backup:** Today → Backup card → *Export backup*. On iPhone, choose *Save to Files*
  (iCloud Drive is good). Do it weekly: iPhone can clear website data of apps not
  opened for a few weeks.
- **Restore:** *Import backup* → pick the file → check the summary → confirm.
  What you had before is kept as `planner.backup.before-import`.
- Laptop sync settings (address and key) are not in backups: retype them after
  a restore on a new phone.

## Build steps

1. Project setup ✅
2. Data model and backups ✅
3. Daily logic and tests ✅
4. Today screen, timer and logging ✅
5. Settings ✅
6. Whoop laptop sync ✅
7. Tests, README, website and phone install ✅
