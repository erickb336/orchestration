// Test helpers (pure): the studio's service commands as the studio's runs will send them (passes 3 and 4), and the
// owner's. Not used by the application.

import { runCommand } from "../commands";
import type { State } from "../types";

/** A SHA-256 written as one repeated hex character. */
export const sha = (c: string) => c.repeat(64);
export const DESIGNER = { role: "designer", provider: "claude", model: "claude-sample-large", attemptId: "run-designer" } as const;
export const ABC = [
  { id: "A", label: "Map first" },
  { id: "B", label: "Timeline" },
  { id: "C", label: "Day cards" },
];

/** Run a command and return the new state and its result. */
export function run<R = unknown>(s: State, name: string, args: object, now: string): { state: State; result: R } {
  const r = runCommand(s, name, args, now);
  return { state: r.state, result: r.result as R };
}

/** Open the next round with this focus; returns its number. */
export function openRound(s: State, focus: string, now: string): { state: State; n: number } {
  const r = run<{ n: number }>(s, "openRound", { focus }, now);
  return { state: r.state, n: r.result.n };
}

/** The designer adds a screen (with the three variants unless given), or a new version of one with `artifactId`. */
export function addScreen(s: State, round: number, now: string, over: Record<string, unknown> = {}): { state: State; id: string; version: number } {
  const args = { round, kind: "screen", title: "Trip plan", variants: ABC, files: [{ path: "trip-plan/index.html", sha256: sha("a") }], devices: ["desktop", "mobile"], madeBy: DESIGNER, ...over };
  const r = run<{ artifactId: string; version: number }>(s, "addStudioArtifact", args, now);
  return { state: r.state, id: r.result.artifactId, version: r.result.version };
}

type V = { variant?: string; verdict: string; reasons?: string; change?: string; budget?: object };
/** One PE pass; each verdict's reasons and (for feasible-if) change are filled in when left out. */
export function pePass(s: State, artifactId: string, version: number, verdicts: V[], now: string): State {
  const full = verdicts.map((v) => ({ reasons: `${v.verdict} for a reason`, ...(v.verdict === "feasible-if" ? { change: "cache the tiles" } : {}), ...v }));
  return run(s, "addPeVerdicts", { artifactId, version, verdicts: full }, now).state;
}

/** A PE pass that agrees on every variant (or the whole artifact when `variants` is empty). */
export function peAgrees(s: State, artifactId: string, version: number, variants: string[], now: string): State {
  return pePass(s, artifactId, version, variants.length ? variants.map((variant) => ({ variant, verdict: "feasible" })) : [{ verdict: "feasible" }], now);
}

/** The owner's feedback on one artifact version. */
export function feedback(s: State, artifactId: string, version: number, entry: Record<string, unknown>, now: string): State {
  return run(s, "sendFeedback", { entries: [{ artifactId, version, mark: null, pins: [], note: "", ...entry }] }, now).state;
}
