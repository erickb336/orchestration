# Splitting

How tally splits a cost and settles the group, as the code does it today (tally/settle.py, tally/money.py).

## The share of each person

```
base, extra = divmod(cents, number of people in the split)
each person pays base; the first `extra` people in the split pay one cent more
```

| Case | Outcome |
| --- | --- |
| 42.00 among ana, ben and cy | 14.00 each |
| 10.00 among ana, ben and cy | ana 3.34, ben 3.33, cy 3.33 |

## Settling up

```
balance = what a person paid - their shares
while someone owes and someone is owed:
    the largest debt pays the largest credit, as much as both allow
```

| Case | Outcome |
| --- | --- |
| Every balance is zero | "Everyone is even." |
| ana +28.00, ben -5.00, cy -23.00 | cy pays ana 23.00; ben pays ana 5.00 |
