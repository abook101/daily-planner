# Tests

Three test files, no installs needed:

- `data.test.js`: data layer (step 2): saving, checking, backups.
- `plan.test.js`: daily plan logic (step 3): study, chores, training, low energy mode.
- `today.test.js`: Today screen helpers (step 4): timer, undo, low energy switch, week tally.

Two ways to run them:

- **Browser:** run `python -m http.server 8000` in the project folder, then open
  http://localhost:8000/tests/ (runs all three files)
- **Node** (only if installed): `node tests/data.test.js`, `node tests/plan.test.js` and `node tests/today.test.js`

The tests use a fake in-memory storage, so they never touch your real planner data.
