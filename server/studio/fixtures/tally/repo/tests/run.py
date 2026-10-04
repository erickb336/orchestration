"""Run tally's tests and write a JUnit report to reports/junit.xml.

Standard library only: unittest, and a small JUnit writer. Each test case is named by its file and its function,
"test_add.py" and "test_records_expense".
"""

import os
import sys
import time
import unittest
from xml.sax.saxutils import quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [ROOT, HERE]


class Recorder(unittest.TextTestResult):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.cases = []
        self.started = 0.0

    def startTest(self, test):
        self.started = time.time()
        super().startTest(test)

    def record(self, test, status, message=""):
        suite = test.__class__.__module__ + ".py"
        self.cases.append((suite, test._testMethodName, status, message, time.time() - self.started))

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record(test, "failure", str(err[1]))

    def addError(self, test, err):
        super().addError(test, err)
        self.record(test, "error", str(err[1]))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.record(test, "skipped", reason)


def junit(cases):
    rows = []
    for suite, name, status, message, secs in cases:
        body = "" if status == "passed" else f"<{status} message={quoteattr(message[:300])}/>"
        rows.append(f'  <testcase classname={quoteattr(suite)} name={quoteattr(name)} time="{secs:.3f}">{body}</testcase>')
    failures = sum(1 for c in cases if c[2] == "failure")
    errors = sum(1 for c in cases if c[2] == "error")
    head = f'<testsuite name="tally" tests="{len(cases)}" failures="{failures}" errors="{errors}">'
    return "\n".join(['<?xml version="1.0" encoding="UTF-8"?>', head, *rows, "</testsuite>", ""])


def main():
    suite = unittest.defaultTestLoader.discover(HERE, pattern="test_*.py", top_level_dir=HERE)
    result = unittest.TextTestRunner(resultclass=Recorder, verbosity=1).run(suite)
    os.makedirs(os.path.join(ROOT, "reports"), exist_ok=True)
    with open(os.path.join(ROOT, "reports", "junit.xml"), "w", encoding="utf-8") as f:
        f.write(junit(result.cases))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
