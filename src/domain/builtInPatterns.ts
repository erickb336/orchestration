// ORC-016: the manifest of built-in pattern files, compiled into the app through JSON imports so the
// domain stays free of I/O and seeds and tests need no file access. One import per file in patterns/;
// a test checks that every file there appears here once. Editing a built-in means a commit and a restart.

import bugfix from "../../patterns/bugfix.json";
import changeBestOfTwo from "../../patterns/change-best-of-two.json";
import changeCrossReview from "../../patterns/change-cross-review.json";
import changeLean from "../../patterns/change-lean.json";
import change from "../../patterns/change.json";
import design from "../../patterns/design.json";
import featureDesignGate from "../../patterns/feature-design-gate.json";
import feature from "../../patterns/feature.json";
import goalPlanGate from "../../patterns/goal-plan-gate.json";
import goal from "../../patterns/goal.json";
import investigation from "../../patterns/investigation.json";
import type { PatternFile, RawPattern } from "./patterns";

const builtIn = (file: string, raw: unknown): PatternFile => ({ file: `patterns/${file}`, source: "built-in", raw: raw as RawPattern });

export const BUILT_IN_FILES: PatternFile[] = [
  builtIn("change.json", change),
  builtIn("change-cross-review.json", changeCrossReview),
  builtIn("change-best-of-two.json", changeBestOfTwo),
  builtIn("change-lean.json", changeLean),
  builtIn("feature.json", feature),
  builtIn("feature-design-gate.json", featureDesignGate),
  builtIn("bugfix.json", bugfix),
  builtIn("investigation.json", investigation),
  builtIn("design.json", design),
  builtIn("goal.json", goal),
  builtIn("goal-plan-gate.json", goalPlanGate),
];
