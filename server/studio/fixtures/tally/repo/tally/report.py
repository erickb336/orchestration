"""The report: each expense by date, oldest first, as text or CSV."""

import csv
import io

from tally.money import show


def rows(ledger, since=None):
    out = [e for e in ledger["expenses"] if since is None or e["date"] >= since]
    return sorted(out, key=lambda e: e["date"])


def text(ledger, since=None):
    lines = [f'{e["date"]}  {e["payer"]:<6} {show(e["cents"]):>9}  {e["note"]}' for e in rows(ledger, since)]
    return "\n".join(lines) if lines else "No expenses."


def as_csv(ledger, since=None):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["date", "payer", "amount", "note"])
    for e in rows(ledger, since):
        w.writerow([e["date"], e["payer"], show(e["cents"]), e["note"]])
    return buf.getvalue().rstrip("\n")
