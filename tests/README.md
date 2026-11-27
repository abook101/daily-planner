# Tests

Six test files for the app, plus one for the laptop sync, no installs needed:

- `data.test.js`: data layer (step 2): saving, checking, backups.
- `plan.test.js`: daily plan logic (step 3): study, chores, training, low energy mode.
- `today.test.js`: Today screen helpers (step 4): timer, undo, low energy switch, week tally.
- `settings.test.js`: Settings (step 5): editing subjects, chores, targets, block length; plan uses them.
- `sync.test.js`: Whoop laptop sync (step 6): merge rules (typed numbers win), fake laptop, errors.
- `reminders.test.js`: Reminders: add, edit, delete, required fields, Today/Upcoming/Past, upgrade of old data, backups.
- `../sync/test_whoop_sync.py`: the laptop program (step 6) with a fake Whoop: login, token renewal, download, https server. Run `python sync/test_whoop_sync.py`.
- `../tools/test_build_site.py`: the website only gets app files, and no private file (Whoop settings, tokens, certificates, data) is tracked by git. Run `python tools/test_build_site.py`.

Two ways to run them:

- **Browser:** run `python -m http.server 8000` in the project folder, then open
  http://localhost:8000/tests/ (runs all six files)
- **Node** (only if installed): `node tests/data.test.js`, `node tests/plan.test.js`, `node tests/today.test.js`, `node tests/settings.test.js`, `node tests/sync.test.js` and `node tests/reminders.test.js`

The tests use a fake in-memory storage, so they never touch your real planner data.
