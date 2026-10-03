// Settings › Project › Environment, as pure functions: the form's fields from the project's environment setting, the
// setEnvironment command they make, the domain's refusal in its own words (normalizeEnvironment), and the lines the
// card shows: where the environment comes from, and the last prepare's result. Prepare commands are one per line,
// each a list of arguments (quotes keep an argument with spaces whole).

import type { EnvironmentFound } from "../../api";
import { lastEnvironmentRun, normalizeEnvironment, type EnvironmentInput } from "../../domain/environment";
import type { State } from "../../domain/types";
import type { SendResult } from "../store";
import { argvLine, splitArgv } from "./preview";

export type EnvironmentDraft = { envImage: string; envPrepare: string; envHosts: string[] };
export const ENVIRONMENT_KEYS: readonly (keyof EnvironmentDraft)[] = ["envImage", "envPrepare", "envHosts"];

export function liveEnvironment(s: State): EnvironmentDraft {
  const e = s.project.environment;
  return { envImage: e?.image ?? "", envPrepare: (e?.prepare ?? []).map(argvLine).join("\n"), envHosts: [...(e?.hosts ?? [])] };
}

/** What the form saves: the setting, or null when every field is empty (the setting is cleared). */
export function environmentInput(v: EnvironmentDraft): EnvironmentInput | null {
  const image = v.envImage.trim();
  const prepare = v.envPrepare.split("\n").map(splitArgv).filter((a) => a.length);
  if (!image && !prepare.length && !v.envHosts.length) return null;
  return { ...(image ? { image } : {}), prepare, hosts: v.envHosts };
}

/** Why the domain refuses the form's setting, in its words; undefined when it takes it. */
export function environmentProblem(v: EnvironmentDraft): string | undefined {
  const input = environmentInput(v);
  if (!input) return undefined;
  const r = normalizeEnvironment(input);
  return "refused" in r ? r.refused : undefined;
}

/** The owner's command that saves the form, when one of its fields changed. */
export function environmentSteps(v: EnvironmentDraft, changed: ReadonlySet<string>, send: (name: "setEnvironment", args: object) => Promise<SendResult>): (() => Promise<SendResult> | null)[] {
  if (!ENVIRONMENT_KEYS.some((k) => changed.has(k))) return [];
  return [() => send("setEnvironment", { environment: environmentInput(v) })];
}

/** "Use this image": the proposed image, and its prepare commands when the form has none. */
export function takeProposal(v: EnvironmentDraft, p: NonNullable<EnvironmentFound["proposal"]>): Partial<EnvironmentDraft> {
  return { envImage: p.image, ...(v.envPrepare.trim() ? {} : { envPrepare: p.prepare.map(argvLine).join("\n") }) };
}

/** A host typed into "Add a host", added to the list; the domain's refusal when it is not a host name. */
export function addHost(v: EnvironmentDraft, text: string): { hosts: string[] } | { refused: string } {
  const h = text.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return { refused: "Type a host name first." };
  const r = normalizeEnvironment({ hosts: [h] });
  if ("refused" in r) return { refused: r.refused };
  if (!r.hosts.length) return { refused: `${h} is already allowed.` };
  return { hosts: v.envHosts.includes(h) ? v.envHosts : [...v.envHosts, h] };
}

/** An image reference with its digest shortened, for reading. */
export const shortImage = (ref: string) => ref.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, "@sha256:$1…");

/** Where the checks' environment comes from, first match wins, as the card's status line: the saved setting, not the form. */
export function sourceLine(found: EnvironmentFound | null, savedImage: string | undefined): { tone: "done" | "neutral" | "fail"; label: string; text: string } {
  const dc = found?.devcontainer;
  if (dc && !dc.refused) return { tone: "done", label: "Dev container", text: `${dc.file}: ${dc.image ? `the image ${shortImage(dc.image)}` : `the Dockerfile ${dc.dockerfile} (context ${dc.context})`}. It comes first; the image below is used only without it.` };
  const why = dc?.refused ? `${dc.refused} ` : "";
  if (savedImage) return { tone: dc?.refused ? "fail" : "done", label: "Confirmed image", text: `${why}The checks use ${shortImage(savedImage)}.` };
  return { tone: dc?.refused ? "fail" : "neutral", label: "Not set up", text: `${why}Checks run on this computer as before: only npm, pnpm and yarn installs get the network there.` };
}

/** The last prepare's result, from the newest check run's record. */
export function lastPrepareLine(s: State): string | undefined {
  const last = lastEnvironmentRun(s);
  if (!last) return undefined;
  const r = last.record;
  const when = `${last.sha.slice(0, 12)}, ${new Date(last.at).toLocaleString()}`;
  if (r.ran === "host") return `Last run (${when}): on this computer, because ${r.reason}.`;
  if (r.prepare === "none") return `Last run (${when}): in ${shortImage(r.image)}; no prepare command ran: the environment and the checks have none. Set them above if the checks need dependencies.`;
  const fromChecks = r.prepareFrom === "checks" ? " with the checks' own prepare commands, because the environment has none," : "";
  const what = r.prepare === "reused" ? `reused the prepare of ${r.reusedFrom?.slice(0, 12) ?? "an earlier commit"}${fromChecks}` : r.prepare === "ran" ? `prepared in ${(r.prepareMs / 1000).toFixed(1)} s${fromChecks}` : `the prepare failed${fromChecks}`;
  return `Last run (${when}): ${what}${fromChecks ? "" : ","} in ${shortImage(r.image)}.${r.refused?.length ? ` The proxy refused: ${r.refused.join("; ")}.` : ""}`;
}

