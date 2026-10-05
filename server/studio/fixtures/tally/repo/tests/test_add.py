import unittest

from helpers import Tally


class TestAdd(unittest.TestCase):
    def test_records_expense(self):
        t = Tally()
        code, out, _ = t.run("add", "42", "Dinner", "--by", "ana", "--for", "ana,ben")
        self.assertEqual(code, 0)
        self.assertIn("Added 42.00 EUR for Dinner", out)
        e = t.ledger()["expenses"][0]
        self.assertEqual((e["cents"], e["payer"], e["people"], e["note"]), (4200, "ana", ["ana", "ben"], "Dinner"))

    def test_records_date(self):
        t = Tally()
        t.run("add", "5", "Snacks", "--by", "ben", "--date", "2026-10-01")
        self.assertEqual(t.ledger()["expenses"][0]["date"], "2026-10-01")

    def test_rejects_text(self):
        self.assertEqual(Tally().run("add", "twelve", "Taxi", "--by", "ana")[2], "Amount must be a number")

    def test_rejects_empty(self):
        self.assertEqual(Tally().run("add", "", "Taxi", "--by", "ana")[2], "Amount must be a number")

    def test_rejects_symbols(self):
        self.assertEqual(Tally().run("add", "12$", "Taxi", "--by", "ana")[2], "Amount must be a number")

    def test_unknown_payer(self):
        code, _, err = Tally().run("add", "5", "Snacks", "--by", "sam")
        self.assertEqual((code, err), (1, "Unknown person: sam"))

    def test_default_everyone(self):
        t = Tally()
        t.run("add", "30", "Fuel", "--by", "cy")
        self.assertEqual(t.ledger()["expenses"][0]["people"], ["ana", "ben", "cy"])

    def test_default_after_join(self):
        t = Tally()
        t.run("join", "dee")
        t.run("add", "40", "Boat", "--by", "dee")
        self.assertEqual(t.ledger()["expenses"][0]["people"], ["ana", "ben", "cy", "dee"])

    def test_rejects_other_currency(self):
        code, _, err = Tally().run("add", "12", "Taxi", "--by", "ben", "--currency", "USD")
        self.assertEqual((code, err), (1, "This group keeps its money in EUR"))
