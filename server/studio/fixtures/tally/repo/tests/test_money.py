import unittest

from helpers import Tally
from tally.money import to_cents


class TestMoney(unittest.TestCase):
    def test_whole_cents(self):
        t = Tally()
        t.run("add", "12.5", "Taxi", "--by", "ana")
        self.assertEqual(t.ledger()["expenses"][0]["cents"], 1250)

    def test_no_floats(self):
        self.assertEqual(to_cents("0.1") + to_cents("0.2"), 30)
        self.assertIsInstance(to_cents("0.1"), int)
