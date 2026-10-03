# The Python fixture's CLI (unit E2): adds two numbers, with pytest from the prepare phase. It tells whether its output
# is a terminal, so the recording shows it ran in one.
import os
import sys

import pytest

a, b = (int(x) for x in sys.argv[1:3])
tty = "a terminal" if sys.stdout.isatty() else "not a terminal"
print(f"{a} + {b} = {a + b} (pytest {pytest.__version__}; stdout is {tty}, {os.get_terminal_size().columns if sys.stdout.isatty() else '?'} columns)")
