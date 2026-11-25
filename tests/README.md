# Tests

Data layer tests (step 2). Two ways to run them, no installs needed:

- **Browser:** run `python -m http.server 8000` in the project folder, then open
  http://localhost:8000/tests/
- **Node** (only if installed): `node tests/data.test.js`

The tests use a fake in-memory storage, so they never touch your real planner data.
