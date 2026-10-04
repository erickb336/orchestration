"""Balances and the fewest payments that settle them."""

from tally.money import shares


def balances(ledger):
    out = {p: 0 for p in ledger["people"]}
    for e in ledger["expenses"]:
        out[e["payer"]] = out.get(e["payer"], 0) + e["cents"]
        for person, share in shares(e["cents"], e["people"]).items():
            out[person] = out.get(person, 0) - share
    return out


def payments(bal):
    """Greedy: the largest debt pays the largest credit, until every balance is zero."""
    owe = sorted(((-v, p) for p, v in bal.items() if v < 0), reverse=True)
    get = sorted(((v, p) for p, v in bal.items() if v > 0), reverse=True)
    out = []
    while owe and get:
        (d, debtor), (c, creditor) = owe[0], get[0]
        pay = min(d, c)
        out.append((debtor, creditor, pay))
        owe[0], get[0] = (d - pay, debtor), (c - pay, creditor)
        owe = sorted((x for x in owe if x[0] > 0), reverse=True)
        get = sorted((x for x in get if x[0] > 0), reverse=True)
    return out
