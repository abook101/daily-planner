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
| `js/app.js` | The Today screen: draws the cards and wires the buttons |
| `js/store.js` | Data layer: saving, checking and backing up all data |
| `js/plan.js` | Daily plan logic: what to study, which chores, run/gym/rest |
| `js/today.js` | Today screen rules: study timer, undo, low energy switch, week tally |
| `js/settings.js` | The Settings screen (gear on Today) |
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

## Install on iPhone

To be written in step 7. Note: iPhone only allows offline mode for pages served
over HTTPS (or localhost), so step 7 will pick a way to serve it securely.

## Build steps

1. Project setup ✅
2. Data model and backups ✅
3. Daily logic and tests ✅
4. Today screen, timer and logging ✅
5. Settings ✅
6. Whoop laptop sync
7. Tests, README and phone install
