"""The ledger: one JSON file, .tally.json, in the folder where you run tally."""

import json
import os

FILE = ".tally.json"


class LedgerError(Exception):
    pass


def path(cwd):
    return os.path.join(cwd, FILE)


def load(cwd):
    p = path(cwd)
    if not os.path.exists(p):
        return {"currency": "EUR", "people": [], "expenses": []}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("expenses"), list):
            raise ValueError("not a ledger")
        return data
    except ValueError:
        raise LedgerError(f"The ledger {FILE} is damaged; nothing was changed.")


def save(cwd, data):
    tmp = path(cwd) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path(cwd))
