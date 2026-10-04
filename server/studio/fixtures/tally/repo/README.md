# tally

tally splits shared costs in a small group. It keeps a ledger in the folder where you run it.

    python3 -m tally join ana
    python3 -m tally add 42 Dinner --by ana
    python3 -m tally split
    python3 -m tally report

## Expenses

`tally add <amount> <note> --by <person>` records an expense. Without `--for`, everyone in the group shares it.

## Currency

Each expense has its own currency: `tally add 12 Taxi --by ben --currency USD`.

## Reports

`tally report` lists the expenses, oldest first. `tally report --csv` prints them as CSV.

## Tests

    python3 tests/run.py

The tests write a JUnit report to `reports/junit.xml`.
