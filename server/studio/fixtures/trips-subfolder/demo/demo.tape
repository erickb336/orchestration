# Mirrors the real studio trial of ORC-029 pass 3: the tape and its script in a subfolder, and the script called by
# its path from the artifact's root (node demo/trips.js), as the manifest writes paths. Output and Source are VHS's
# own, relative to the tape's folder.
Output demo.gif
Output demo.txt
Set Shell bash
Set Columns 80
Set Rows 24
Set TypingSpeed 20ms

Source setup.tape

Type "trips plan"
Enter
Sleep 1.5s
