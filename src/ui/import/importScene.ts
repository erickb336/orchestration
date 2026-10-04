// Test fixture (pure): what the Start screen reads of tally, the invented sample repository of ORC-032 (sample data,
// not a real repository), for the UI's tests and the QA journey (scripts/qa/import.mjs), in the shape of unit 2's
// route (POST /api/import/demo). Its counts match the state builders' (src/domain/testing/import.ts), which build
// tally's import at each stage. Here "how it runs" is complete; the tests take parts away. Not used by the application.

import { importEstimate } from "../../domain/studio/import";
import { TALLY_COMMIT, TALLY_SIZE } from "../../domain/testing/import";
import type { FoundRepository } from "./importView";

/** tally, a CLI in Python: a command-line entry, a package, a proposed image, and a test command that writes a JUnit report. */
export const TALLY_START_INFO: FoundRepository = {
  ok: true,
  demo: true,
  path: "/tmp/orchestrator-data/import-demo/tally",
  commit: TALLY_COMMIT,
  branch: "main",
  size: TALLY_SIZE,
  estimate: importEstimate(TALLY_SIZE),
  domains: [
    { domain: "screen", device: "terminal", because: "tally/__main__.py: a command-line entry" },
    { domain: "code", because: "pyproject.toml: a package other programs can use" },
  ],
  proposal: { label: "Python 3.12", image: `python:3.12-slim@sha256:${"a".repeat(64)}`, prepare: [["pip", "install", "-e", ".[test]"]], because: "pyproject.toml names Python 3.12 and pytest." },
  checks: [],
  testReport: { command: { id: "test", label: "Tests with a JUnit report", kind: "check", argv: ["python3", "-m", "pytest", "--junitxml=reports/junit.xml"] }, path: "reports/junit.xml", because: "conftest.py" },
};
