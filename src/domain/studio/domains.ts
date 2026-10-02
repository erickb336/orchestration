// Project domains (ORC-029 r9): what kind of product the project is, which decides what the studio's designer makes.
// The owner chooses them in the app (`setDomains`, the owner's command). The lead may recommend them in its message;
// it never asks about them in its questions and never sets them (real trial finding 3). Designer briefs follow them:
// screens, terminal demos and TUIs for a screen product; the interface and the core algorithms for a code product; the
// topology, with failure and recovery and scale and cost, for an infrastructure system. Pure.

import { draft, event } from "../model/core";
import { ControlError, PROJECT_DOMAINS, type ProjectDomain, type State } from "../types";
import type { StudioArtifactKind } from "./types";

/** "a screen product" */
export const DOMAIN_WORDS: Record<ProjectDomain, string> = { screen: "a screen product", code: "a code product", infrastructure: "an infrastructure system" };

/** What the studio shows for each domain: the kinds a designer makes for it, and what they hold. */
export const DOMAIN_ARTIFACTS: Record<ProjectDomain, { kinds: StudioArtifactKind[]; what: string }> = {
  screen: {
    kinds: ["screen", "terminal-demo", "tui"],
    what: "clickable screens for desktop and mobile; terminal demos and TUIs for the terminal",
  },
  code: {
    kinds: ["interface", "algorithm"],
    what: "the interface (names, signatures, the error model, usage examples as a caller writes them) and the core algorithms and primitives (plain pseudo-code, a worked trace, invariants, cost and complexity), with worked input and output pairs",
  },
  infrastructure: {
    kinds: ["topology"],
    what: "the topology (the components and what talks to what, as a Mermaid diagram), a failure and recovery table, a scaling and cost model, and service-level targets",
  },
};

/** One line per domain the owner confirmed, saying what its designer makes; or that none is chosen yet. */
export function domainLines(domains: readonly ProjectDomain[]): string[] {
  if (!domains.length) return ["Not chosen yet by the owner."];
  return PROJECT_DOMAINS.filter((d) => domains.includes(d)).map((d) => `${DOMAIN_WORDS[d][0].toUpperCase()}${DOMAIN_WORDS[d].slice(1)} (${DOMAIN_ARTIFACTS[d].kinds.join(", ")}): ${DOMAIN_ARTIFACTS[d].what}.`);
}

/**
 * The owner confirms the product's domains: at least one, each once, in a fixed order. Any time: they decide what the
 * studio's designer makes, and nothing in the factory reads them. The lead never calls this; it may recommend domains
 * in its message.
 */
export function setDomains(state: State, domains: ProjectDomain[], now: string): State {
  const chosen = PROJECT_DOMAINS.filter((d) => domains.includes(d));
  if (!chosen.length) throw new ControlError("Choose at least one domain: screen, code or infrastructure.");
  if (chosen.length === state.project.domains.length && chosen.every((d, i) => state.project.domains[i] === d)) return state;
  const s = draft(state);
  s.project.domains = chosen;
  event(s, now, "user", "vision", `Domains: ${chosen.map((d) => DOMAIN_WORDS[d]).join(" and ")}`);
  return s;
}
