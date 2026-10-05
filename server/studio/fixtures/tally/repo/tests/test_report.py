import unittest

from helpers import Tally


class TestReport(unittest.TestCase):
    def three(self):
        t = Tally()
        t.run("add", "5", "Snacks", "--by", "ben", "--date", "2026-10-02")
        t.run("add", "42", "Dinner", "--by", "ana", "--date", "2026-10-01")
        t.run("add", "18", "Taxi", "--by", "cy", "--date", "2026-10-03")
        return t

    def test_by_date(self):
        out = self.three().run("report")[1].splitlines()
        self.assertEqual([line.split()[0] for line in out], ["2026-10-01", "2026-10-02", "2026-10-03"])

    def test_since(self):
        out = self.three().run("report", "--since", "2026-10-02")[1].splitlines()
        self.assertEqual([line.split()[-1] for line in out], ["Snacks", "Taxi"])

    def test_since_empty(self):
        self.assertEqual(self.three().run("report", "--since", "2027-01-01")[1], "No expenses.")
