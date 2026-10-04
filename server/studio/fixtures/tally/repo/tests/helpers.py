import io
import json
import os
import tempfile

from tally.cli import main


class Tally:
    """tally in a folder of its own, as a user runs it."""

    def __init__(self, people=("ana", "ben", "cy")):
        self.dir = tempfile.mkdtemp(prefix="tally-test-")
        for p in people:
            self.run("join", p)

    def run(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        code = main(list(argv), cwd=self.dir, out=out, err=err)
        return code, out.getvalue().strip(), err.getvalue().strip()

    def ledger(self):
        with open(os.path.join(self.dir, ".tally.json"), encoding="utf-8") as f:
            return json.load(f)
