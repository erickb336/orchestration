import unittest

from helpers import Tally
from tally import settle


class TestSplit(unittest.TestCase):
    def dinner(self):
        t = Tally()
        t.run("add", "42", "Dinner", "--by", "ana")
        t.run("add", "18", "Taxi", "--by", "ben", "--for", "ben,cy")
        return t

    def test_balances(self):
        out = self.dinner().run("split")[1]
        self.assertIn("ana        28.00", out)
        self.assertIn("cy        -23.00", out)

    def test_balances_sum_to_zero(self):
        t = self.dinner()
        self.assertEqual(sum(settle.balances(t.ledger()).values()), 0)

    def test_fewest_payments(self):
        out = self.dinner().run("split")[1]
        self.assertEqual([line for line in out.splitlines() if " pays " in line], ["cy pays ana 23.00", "ben pays ana 5.00"])

    def test_settles_all(self):
        t = self.dinner()
        bal = settle.balances(t.ledger())
        for debtor, creditor, cents in settle.payments(bal):
            bal[debtor] += cents
            bal[creditor] -= cents
        self.assertEqual(set(bal.values()), {0})

    def test_even(self):
        t = Tally()
        t.run("add", "30", "Fuel", "--by", "ana", "--for", "ana")
        self.assertTrue(t.run("split")[1].endswith("Everyone is even."))
