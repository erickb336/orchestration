#!/usr/bin/env bash
# Make a small throwaway repository for the first real import (docs/real-run.md).
#
#   scripts/real-run/make-trial-repo.sh [path]     default: ~/workspace/orchestrator-trial
#
# It writes only into a new folder at the path, and refuses a path that exists. The repository is "tip", a tip
# calculator in Python with the standard library only (as the sample tally), 5 tests that write a JUnit report, and one
# commit. At the end it prints what to type into the import's Start screen.
set -euo pipefail

dest="${1:-$HOME/workspace/orchestrator-trial}"
if [ -e "$dest" ]; then
  echo "Refused: $dest exists. Give a new path, or remove it yourself." >&2
  exit 1
fi
mkdir -p "$(dirname "$dest")"
dest="$(cd "$(dirname "$dest")" && pwd)/$(basename "$dest")"
mkdir "$dest" "$dest/tip" "$dest/tests"

cat >"$dest/README.md" <<'EOF'
# tip

tip splits a restaurant bill between people, with a tip.

    python3 -m tip 84.50 --people 3 --tip 15

It prints what each person pays, rounded up to the cent.

## Rules

- The tip is a percent of the bill, from 0 to 30. The default is 15.
- There is at least one person.
- Each share is rounded up to the cent, so the shares never sum to less than the total.

## Tests

    python3 tests/run.py

The tests write a JUnit report to `reports/junit.xml`.
EOF

cat >"$dest/requirements.txt" <<'EOF'
# tip uses only the Python standard library.
EOF

cat >"$dest/.gitignore" <<'EOF'
reports/
__pycache__/
EOF

cat >"$dest/tip/__init__.py" <<'EOF'
EOF

cat >"$dest/tip/split.py" <<'EOF'
"""Split a bill with a tip. Amounts are in cents, so no float rounding."""

import math


def to_cents(text):
    """'84.50' -> 8450. A negative or malformed amount is refused."""
    whole, _, frac = text.partition(".")
    if not whole.isdigit() or (frac and (not frac.isdigit() or len(frac) > 2)):
        raise ValueError(f"not an amount: {text}")
    return int(whole) * 100 + int(frac.ljust(2, "0") or 0)


def share(bill_cents, people, tip_percent=15):
    """What each person pays, in cents: the bill plus the tip, divided, rounded up to the cent."""
    if people < 1:
        raise ValueError("at least one person")
    if not 0 <= tip_percent <= 30:
        raise ValueError("the tip is from 0 to 30 percent")
    total = bill_cents * (100 + tip_percent)
    return math.ceil(total / (100 * people))
EOF

cat >"$dest/tip/__main__.py" <<'EOF'
from tip.cli import main

raise SystemExit(main())
EOF

cat >"$dest/tip/cli.py" <<'EOF'
import argparse
import sys

from tip.split import share, to_cents


def main(argv=None):
    p = argparse.ArgumentParser(prog="tip", description="Split a bill between people, with a tip.")
    p.add_argument("bill", help="the bill, for example 84.50")
    p.add_argument("--people", type=int, default=1)
    p.add_argument("--tip", type=int, default=15, help="percent, 0 to 30")
    a = p.parse_args(argv)
    try:
        cents = share(to_cents(a.bill), a.people, a.tip)
    except ValueError as e:
        print(f"tip: {e}", file=sys.stderr)
        return 2
    print(f"Each person pays {cents // 100}.{cents % 100:02d}")
    return 0
EOF

cat >"$dest/tests/test_split.py" <<'EOF'
import unittest

from tip.split import share, to_cents


class Split(unittest.TestCase):
    def test_default_tip_is_15_percent(self):
        self.assertEqual(share(10000, 1), 11500)

    def test_share_rounds_up_to_the_cent(self):
        self.assertEqual(share(10000, 3, 0), 3334)

    def test_no_people_is_refused(self):
        with self.assertRaises(ValueError):
            share(1000, 0)

    def test_tip_above_30_is_refused(self):
        with self.assertRaises(ValueError):
            share(1000, 2, 31)

    def test_amount_reads_cents(self):
        self.assertEqual(to_cents("84.5"), 8450)
EOF

cat >"$dest/tests/run.py" <<'EOF'
"""Run the tests and write a JUnit report to reports/junit.xml (standard library only)."""

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
        self.cases.append((test.__class__.__module__ + ".py", test._testMethodName, status, message, time.time() - self.started))

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record(test, "failure", str(err[1]))

    def addError(self, test, err):
        super().addError(test, err)
        self.record(test, "error", str(err[1]))


def junit(cases):
    rows = []
    for suite, name, status, message, secs in cases:
        body = "" if status == "passed" else f"<{status} message={quoteattr(message[:300])}/>"
        rows.append(f'  <testcase classname={quoteattr(suite)} name={quoteattr(name)} time="{secs:.3f}">{body}</testcase>')
    failures = sum(1 for c in cases if c[2] == "failure")
    errors = sum(1 for c in cases if c[2] == "error")
    head = f'<testsuite name="tip" tests="{len(cases)}" failures="{failures}" errors="{errors}">'
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
EOF

# One commit, with a neutral author and no hooks, so nothing of your own git setup runs or is recorded.
git -C "$dest" init --quiet -b main
git -C "$dest" add -A
git -C "$dest" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name="Orchestrator trial" -c user.email="trial@localhost" \
  commit --quiet -m "tip: split a bill with a tip"
commit="$(git -C "$dest" rev-parse HEAD)"

cat <<EOF
Made the trial repository. Type these into Start (Settings › Project › Start a new project › Import an existing repository):

  Repository path (absolute):  $dest
  Test command:                python3 tests/run.py
  JUnit report path:           reports/junit.xml
  Import budget (dollars):     5

Start has no commit field: it reads the last commit itself. Check that "✓ Found" names this one:

  Commit:                      ${commit:0:7} on main  ($commit)
EOF
