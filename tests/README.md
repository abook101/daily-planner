# Tests

Two test files, no installs needed:

- `data.test.js`: data layer (step 2): saving, checking, backups.
- `plan.test.js`: daily plan logic (step 3): study, chores, training, low energy mode.

Two ways to run them:

- **Browser:** run `python -m http.server 8000` in the project folder, then open
  http://localhost:8000/tests/ (runs both files)
- **Node** (only if installed): `node tests/data.test.js` and `node tests/plan.test.js`

The tests use a fake in-memory storage, so they never touch your real planner data.
