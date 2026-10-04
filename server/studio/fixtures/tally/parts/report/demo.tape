# tally report, as the code does it today. The capture types this in a copy of the repository, at its root.
Output demo.gif
Output demo.webm
Output demo.txt

Set Shell bash
Set Columns 80
Set Rows 24
Set FontSize 16
Set TypingSpeed 40ms

Hide
Type "alias tally='python3 -m tally' && tally join ana && tally join ben && tally add 42 Dinner --by ana --date 2026-10-01 && tally add 18 Taxi --by ben --date 2026-10-02 && clear"
Enter
Show

Type "tally report"
Enter
Sleep 1s

Type "tally report --format csv"
Enter
Sleep 2s
