// The two places in words (ORC-029 pass 5, screen 1; ORC-030 a-header-phone): each place's state sits in its menu
// item, so the header needs no row of pills. "Home · factory running · 3 agents" and "Vision · draft · 5 changes" on a
// desktop; "running" and "draft 5" under the item's name on a phone. The facts come from src/domain/places.ts.

import type { FactoryPlace, VisionPlace } from "../domain/places";
import type { Tone } from "./kit";
import { relTime } from "./common";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A place's state beside its menu item. */
export interface PlaceState {
  /** The words on a desktop, after the item's name: "factory running · 3 agents". */
  text: string;
  /** The words on a phone, under the item's name, when shorter than `text`: "running". */
  short?: string;
  /** The state colour: "you" when it waits for the owner, "work" while agents work. */
  tone: Tone;
  /** The dot pulses while agents work; a pause shows two bars. */
  pulse?: boolean;
  paused?: boolean;
  /** The longer sentence, for the item's title. */
  title: string;
}

/**
 * Vision's state: "draft · 5 changes" ("draft 5" on a phone), "draft · 1 open item", "locked in 2m ago" or "no draft".
 * With changes and open items, the changes lead (what a Lock in puts into force); the title names both.
 */
export function visionPlaceState(p: VisionPlace, now = Date.now()): PlaceState {
  if (p.state === "draft") {
    const title = [p.changes ? `${count(p.changes, "change")} in the draft ${p.changes === 1 ? "waits" : "wait"} for your Lock in.` : "", p.openItems ? `${count(p.openItems, "open item")} ${p.openItems === 1 ? "stays" : "stay"} in the draft until you settle ${p.openItems === 1 ? "it" : "them"}.` : ""]
      .filter(Boolean)
      .join(" ");
    const full = `${title} The factory builds from the version in force.`;
    if (!p.changes) return { text: `draft · ${count(p.openItems, "open item")}`, short: `${p.openItems} open`, tone: "neutral", title: full };
    return { text: `draft · ${count(p.changes, "change")}${p.openItems ? ` · ${p.openItems} open` : ""}`, short: `draft ${p.changes}`, tone: "you", title: full };
  }
  if (p.state === "locked-in") return { text: `locked in ${relTime(p.at, now)}`, short: "locked in", tone: "neutral", title: `No draft. The factory builds from Lock in ${p.rev}.` };
  return { text: "no draft", tone: "neutral", title: "Nothing is approved yet. Open Vision to design the product with the lead." };
}

/**
 * The factory's state, beside Home: "factory running · 4 agents" ("running" on a phone), "factory pausing · 3 runs
 * stopping", "factory paused by you", "factory stopped at the budget" or "factory not started". Pausing and paused come
 * from the project's pause (`projectPause`), the one source, so it never says paused before every run stopped.
 */
export function factoryPlaceState(p: FactoryPlace, live: string): PlaceState {
  if (p.state === "not-started") return { text: "factory not started", short: "not started", tone: "neutral", title: "The factory has not started. Start the factory from Vision: it is your first Lock in." };
  if (p.state === "pausing") {
    const runs = count(p.stopping, "run");
    return { text: `project pausing · ${runs} stopping`, short: "pausing", tone: "work", pulse: true, title: `You paused the project. ${runs} ${p.stopping === 1 ? "is" : "are"} still stopping; it says paused once ${p.stopping === 1 ? "it confirms" : "they confirm"} the stop.` };
  }
  if (p.state === "paused") return { text: "project paused by you", short: "paused", tone: "neutral", paused: true, title: `You paused the project. Nothing starts until you resume it (the Project menu). ${live}.` };
  if (p.state === "budget-stop") return { text: "factory stopped at the budget", short: "stopped", tone: "you", title: `${p.why}. Nothing new starts until you raise the budget or continue past it.` };
  return { text: `factory running · ${p.agents ? count(p.agents, "agent") : "idle"}`, short: "running", tone: p.agents ? "work" : "neutral", pulse: p.agents > 0, title: `The factory runs. ${live}.` };
}
