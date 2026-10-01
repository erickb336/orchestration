// The six built-in flows, compiled into the app through JSON imports so the domain stays free of I/O
// and seeds and tests need no file access. One import per file in flows/, in the order the picker shows
// them; a test checks that every file there appears here once. Changing a flow means editing its file,
// running the tests, and a commit.

import bugfix from "../../flows/bugfix.json";
import change from "../../flows/change.json";
import design from "../../flows/design.json";
import feature from "../../flows/feature.json";
import goal from "../../flows/goal.json";
import investigation from "../../flows/investigation.json";
import type { FlowFile, RawFlow } from "./flows";

const builtIn = (file: string, raw: unknown): FlowFile => ({ file: `flows/${file}`, raw: raw as RawFlow });

export const BUILT_IN_FILES: FlowFile[] = [builtIn("change.json", change), builtIn("bugfix.json", bugfix), builtIn("feature.json", feature), builtIn("design.json", design), builtIn("investigation.json", investigation), builtIn("goal.json", goal)];
