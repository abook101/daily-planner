# Tests

Four test files, no installs needed:

- `data.test.js`: data layer (step 2): saving, checking, backups.
- `plan.test.js`: daily plan logic (step 3): study, chores, training, low energy mode.
- `today.test.js`: Today screen helpers (step 4): timer, undo, low energy switch, week tally.
- `settings.test.js`: Settings (step 5): editing subjects, chores, targets, block length; plan uses them.

Two ways to run them:

- **Browser:** run `python -m http.server 8000` in the project folder, then open
  http://localhost:8000/tests/ (runs all four files)
- **Node** (only if installed): `node tests/data.test.js`, `node tests/plan.test.js`, `node tests/today.test.js` and `node tests/settings.test.js`

The tests use a fake in-memory storage, so they never touch your real planner data.
