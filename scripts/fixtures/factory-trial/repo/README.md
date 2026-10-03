# Split

Split a bill between friends, on a web page and with the `split` command.

- `npm test` runs the tests with Node's test runner and writes a JUnit report to `reports/junit.xml`.
- `npm run preview` serves `public/` on `$PORT` (4173 when it is not set).
- `public/split.js` is the core, shared by the page and the CLI (`bin/split.js`).

This repository is the sample of Orchestrator's factory trial. `public/split.js` is frozen for the trial: it drops the cents left over after rounding, which rule R3 forbids, and `test/rules-r3.test.js` records that R3 fails. Do not change either file.
