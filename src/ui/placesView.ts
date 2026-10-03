// The header's two places in words (ORC-029 pass 5, screen 1): "Vision · draft, 3 changes" and "Factory running ·
// 4 agents", with the state colour of each and a longer title. The facts come from src/domain/places.ts.

import type { FactoryPlace, VisionPlace } from "../domain/places";
import type { Tone } from "./kit";
import { relTime } from "./common";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface PlaceWords {
  text: string;
  /** The state colour: "you" when it waits for the owner, "work" while agents work. */
  tone: Tone;
  title: string;
}

/**
 * "Vision · draft, 3 changes", "Vision · draft, 1 open item", "Vision · locked in 2m ago" or "Vision · no draft". With
 * changes and open items, the changes (what a Lock in puts into force); the title names both.
 */
export function visionPlaceWords(p: VisionPlace, now = Date.now()): PlaceWords {
  if (p.state === "draft") {
    const what = p.changes ? count(p.changes, "change") : count(p.openItems, "open item");
    const title = [p.changes ? `${count(p.changes, "change")} in the draft ${p.changes === 1 ? "waits" : "wait"} for your Lock in.` : "", p.openItems ? `${count(p.openItems, "open item")} ${p.openItems === 1 ? "stays" : "stay"} in the draft until you settle ${p.openItems === 1 ? "it" : "them"}.` : ""]
      .filter(Boolean)
      .join(" ");
    return { text: `Vision · draft, ${what}`, tone: p.changes ? "you" : "neutral", title: `${title} The factory builds from the version in force.` };
  }
  if (p.state === "locked-in") return { text: `Vision · locked in ${relTime(p.at, now)}`, tone: "neutral", title: `No draft. The factory builds from Lock in ${p.rev}.` };
  return { text: "Vision · no draft", tone: "neutral", title: "Nothing is approved yet. Open Vision to design the product with the lead." };
}

/** "Factory not started", "Factory running · 4 agents", "Factory pausing · 3 runs stopping", "Factory paused · by you" or "Factory stopped at the budget · needs you". */
export function factoryPlaceWords(p: FactoryPlace, live: string): PlaceWords {
  if (p.state === "not-started") return { text: "Factory not started", tone: "neutral", title: "Start the factory on Home. It is your first Lock in." };
  if (p.state === "pausing") {
    const runs = count(p.stopping, "run");
    return { text: `Factory pausing · ${runs} stopping`, tone: "work", title: `You paused the project. ${runs} ${p.stopping === 1 ? "is" : "are"} still stopping; it says paused once ${p.stopping === 1 ? "it confirms" : "they confirm"} the stop.` };
  }
  if (p.state === "paused") return { text: "Factory paused · by you", tone: "neutral", title: `You paused the project. Nothing starts until you resume it. ${live}.` };
  if (p.state === "budget-stop") return { text: "Factory stopped at the budget · needs you", tone: "you", title: p.why };
  return { text: `Factory running · ${p.agents ? count(p.agents, "agent") : "idle"}`, tone: p.agents ? "work" : "neutral", title: `${live}. Open the tasks.` };
}
