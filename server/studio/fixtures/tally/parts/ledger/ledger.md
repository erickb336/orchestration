# The ledger

What tally keeps, as the code does it today (tally/ledger.py): one JSON file, `.tally.json`, in the folder where you run tally.

| Field | What it holds |
| --- | --- |
| currency | the group's currency, "EUR" in a new ledger |
| people | the names in the group, in the order they joined |
| expenses | each expense: cents, note, payer, people, date |

```json
{ "currency": "EUR", "people": ["ana", "ben"], "expenses": [{ "cents": 4200, "note": "Dinner", "payer": "ana", "people": ["ana", "ben"], "date": "2026-10-01" }] }
```

| Case | Outcome |
| --- | --- |
| No .tally.json | an empty ledger; nothing is written until a change |
| A .tally.json that is not a ledger | tally stops, says the ledger is damaged, and changes nothing |
