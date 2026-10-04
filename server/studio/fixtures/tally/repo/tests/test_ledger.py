import os
import tempfile
import unittest

from helpers import Tally
from tally.cli import main


class TestLedger(unittest.TestCase):
    def test_missing(self):
        d = tempfile.mkdtemp(prefix="tally-test-")
        self.assertEqual(main(["report"], cwd=d, out=open(os.devnull, "w")), 0)
        self.assertFalse(os.path.exists(os.path.join(d, ".tally.json")))

    def damaged(self):
        t = Tally()
        with open(os.path.join(t.dir, ".tally.json"), "w", encoding="utf-8") as f:
            f.write("{ not json")
        return t

    def test_damaged_untouched(self):
        t = self.damaged()
        t.run("add", "5", "Snacks", "--by", "ana")
        with open(os.path.join(t.dir, ".tally.json"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "{ not json")

    def test_damaged_message(self):
        code, _, err = self.damaged().run("split")
        self.assertEqual((code, err), (1, "The ledger .tally.json is damaged; nothing was changed."))
