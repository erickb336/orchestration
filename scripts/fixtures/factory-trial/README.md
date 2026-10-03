# The factory trial's fixture

`scripts/factory-trial.mjs` (`npm run trial:factory`) builds one Feature task on this sample, so that "Design and reality" has evidence to show. The sample is Split: friends split a bill, on a web page and with a `split` command.

- `repo/` is the sample repository before the task: a static page served by a short Node server (`server.js`, no dependencies), a CLI that prints its usage, and the core in `public/split.js`. `npm test` runs Node's test runner and writes a JUnit report to `reports/junit.xml`; `npm run preview` serves the page.
- `design/` holds the three items the owner approves before the factory starts, as a designer hands them in (`studio.json`): the screen's prototype, the CLI's terminal demo, and the flow "Splitting a bill" with 3 EARS rules and 1 example (`flow/rules.json`).
- `r3-test.template.js` is the test of rule R3 (named so that no test runner collects it here). The trial writes it to `test/rules-r3.test.js`, with the flow's blueprint item id in its tag, before the factory starts.

**R3 fails on purpose.** R3 says that the cents left over after rounding go to the first person. The core drops them, and the task's spec tells the agents to leave the core and the R3 test as they are. The R3 test is a todo test: Node's test runner does not fail the run for it, and its JUnit report still records the failure. So the checks pass and the task lands, while the rule results show R1, R2 and E1 passing and R3 failing, and the flow reads "fails a check".
