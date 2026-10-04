# tally split, as the code does it today. The capture types this in its own copy of the repository, at its root,
# so it starts with no ledger.
Output demo.gif
Output demo.webm
Output demo.txt

Set Shell bash
Set Columns 80
Set Rows 24
Set FontSize 16
Set TypingSpeed 40ms

Hide
Type "alias tally='python3 -m tally'"
Enter
Type "tally join ana >/dev/null && tally join ben >/dev/null && tally join cy >/dev/null && tally add 42 Dinner --by ana >/dev/null && tally add 18 Taxi --by ben --for ben,cy >/dev/null && clear"
Enter
Show

Type "tally split"
Enter
Sleep 2s
