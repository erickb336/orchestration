// Test fixture (pure): what the Start screen reads of tally, the invented sample repository of ORC-032 (sample data,
// not a real repository), for the UI's tests and the QA journey (scripts/qa/import.mjs). Its counts match the state
// builders' (src/domain/testing/import.ts), which build tally's import at each stage. Not used by the application.

import { TALLY_COMMIT, TALLY_SIZE } from "../../domain/testing/import";
import type { ImportStartInfo } from "./importView";

/** GET /api/import/start?sample=tally, as unit 2's route is to answer it: a CLI in Python, with a test command and its report. */
export const TALLY_START_INFO: ImportStartInfo = {
  ok: true,
  path: "/tmp/orchestrator-samples/tally",
  sample: true,
  commit: TALLY_COMMIT,
  branch: "main",
  size: TALLY_SIZE,
  holds: ["a README", "a pyproject"],
  kinds: [
    { domain: "screen", found: true, because: "A CLI in a terminal: the console script tally in pyproject.toml. The designer records terminal demos." },
    { domain: "code", found: true, because: "tally/settle.py and tally/money.py hold the split and its rounding: core algorithms." },
    { domain: "infrastructure", found: false, because: "no compose file, no IaC, no deploy scripts." },
  ],
  devices: [
    { device: "desktop", found: false, because: "no web app." },
    { device: "mobile", found: false, because: "no phone app." },
    { device: "terminal", found: true, because: "the console script tally." },
  ],
  environment: {
    ref: TALLY_COMMIT,
    proposal: { label: "Python 3.12", image: `python:3.12-slim@sha256:${"a".repeat(64)}`, prepare: [["pip", "install", "-e", ".[test]"]], because: "pyproject.toml names Python 3.12 and pytest." },
  },
  testCommand: { argv: ["pytest", "--junitxml=reports/junit.xml"], because: "pyproject.toml has pytest under [project.optional-dependencies] test." },
  testReport: { path: "reports/junit.xml", because: "The test command writes it (--junitxml)." },
};
