# Splitting a bill

A person enters the bill's total and the number of people, on the page or with `split <total> <people>`. Split shows what each person pays.

1. The person gives the total in dollars (for example 90.00) and the number of people (for example 3).
2. Split divides the total equally and shows the share each person pays, to the cent.
3. When the number of people is less than one, Split refuses and says "Need at least one person".
4. When the total does not divide equally, the first person pays the cents left over, so the shares add up to the total.

The rules and the example are in `rules.json`.
