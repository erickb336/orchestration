"""The tally command line: join, add, split and report."""

import argparse
import datetime
import os
import sys

from tally import ledger as L
from tally import report, settle
from tally.money import MoneyError, show, to_cents


class Stop(Exception):
    pass


def parser():
    p = argparse.ArgumentParser(prog="tally")
    sub = p.add_subparsers(dest="command", required=True)
    j = sub.add_parser("join")
    j.add_argument("name")
    a = sub.add_parser("add")
    a.add_argument("amount")
    a.add_argument("note")
    a.add_argument("--by", required=True)
    a.add_argument("--for", dest="people")
    a.add_argument("--date")
    a.add_argument("--currency")
    sub.add_parser("split")
    r = sub.add_parser("report")
    r.add_argument("--since")
    r.add_argument("--format", choices=["text", "csv"], default="text")
    return p


def add(data, args):
    try:
        cents = to_cents(args.amount)
    except MoneyError as e:
        raise Stop(str(e))
    if args.by not in data["people"]:
        raise Stop(f"Unknown person: {args.by}")
    if args.currency and args.currency != data["currency"]:
        raise Stop(f"This group keeps its money in {data['currency']}")
    people = args.people.split(",") if args.people else list(data["people"])
    for p in people:
        if p not in data["people"]:
            raise Stop(f"Unknown person: {p}")
    date = args.date or datetime.date.today().isoformat()
    # A negative amount is a refund: the payer gets money back.
    data["expenses"].append({"cents": cents, "note": args.note, "payer": args.by, "people": people, "date": date})
    return f"Added {show(cents)} {data['currency']} for {args.note}, paid by {args.by}, shared by {', '.join(people)}."


def split(data):
    bal = settle.balances(data)
    lines = [f"{p:<6} {show(v):>9}" for p, v in bal.items()]
    pays = settle.payments(bal)
    if not pays:
        return "\n".join(lines + ["Everyone is even."])
    return "\n".join(lines + [""] + [f"{a} pays {b} {show(c)}" for a, b, c in pays])


def main(argv, cwd=None, out=sys.stdout, err=sys.stderr):
    cwd = cwd or os.getcwd()
    args = parser().parse_args(argv)
    try:
        data = L.load(cwd)
        if args.command == "join":
            if args.name not in data["people"]:
                data["people"].append(args.name)
            L.save(cwd, data)
            print(f"{args.name} is in the group: {', '.join(data['people'])}.", file=out)
        elif args.command == "add":
            msg = add(data, args)
            L.save(cwd, data)
            print(msg, file=out)
        elif args.command == "split":
            print(split(data), file=out)
        else:
            print(report.as_csv(data, args.since) if args.format == "csv" else report.text(data, args.since), file=out)
        return 0
    except (Stop, L.LedgerError) as e:
        print(str(e), file=err)
        return 1
