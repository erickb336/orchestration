// Which provider and model run a step (resolveStep), and who authored a change, so that a review can be
// independent of the change's writers.

import {
  type Artifact,
  type ChangeAuthor,
  type PrDelivery,
  type ModelSelection,
  type ProviderId,
  type Runner,
  type SelectionSource,
  type State,
  type Step,
  type StepDef,
  type Task,
  roleDefaultFor,
  isProvider,
} from "../types";
import { consumedInputs } from "./artifacts";

type Resolution =
  | { ok: true; selection: ModelSelection; source: SelectionSource; reason: string }
  | { ok: false; reason: string };

/** The commit a code-change artifact names ("<sha> on <branch>", or the hash a person typed). */
const commitOf = (a: Artifact) => a.ref?.trim().split(" ")[0] ?? "";
const sameCommit = (a: Artifact, b: Artifact) => {
  const [x, y] = [commitOf(a).toLowerCase(), commitOf(b).toLowerCase()];
  return x === y || (x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x)));
};

/**
 * Who wrote the commit a code-change artifact names. A version a person edited is theirs only when the
 * edit supplied another commit; an edit of the summary alone leaves the commit with the run that made
 * it. A run that is not on record is "unknown", never "user": nothing is assumed about it.
 */
export function artifactAuthor(s: State, art: Artifact): ChangeAuthor {
  let made = art;
  if (art.author === "user") {
    const run = s.artifacts
      .filter((a) => a.taskId === art.taskId && a.stepId === art.stepId && a.name === art.name && a.version < art.version && a.author !== "user")
      .sort((a, b) => a.version - b.version)
      .pop();
    if (!run) return commitOf(art) ? "user" : "unknown";
    if (!sameCommit(run, art)) return "user";
    made = run;
  }
  const p = s.attempts.find((a) => a.id === made.attemptId)?.snapshot.provider;
  return p && isProvider(p) ? p : "unknown";
}

/** Everyone who authored a change a pull request holds. Records from before the set was kept name only the newest author. */
export const prAuthors = (pr: PrDelivery): ChangeAuthor[] => (pr.changeAuthors?.length ? pr.changeAuthors : [pr.changeAuthor]);

/** The providers whose review counts as independent of these authors: none of them wrote any of it. Empty when an author is unknown. */
export function independentProviders(authors: ChangeAuthor[]): ProviderId[] {
  if (authors.includes("unknown")) return [];
  return (["claude", "codex"] as ProviderId[]).filter((p) => !authors.includes(p));
}

/** "Claude", "Claude and Codex", "you and Codex", "an unknown author". */
export function authorsLabel(authors: ChangeAuthor[]): string {
  const names = [...new Set(authors)].map((a) => (a === "user" ? "you" : a === "unknown" ? "an unknown author" : providerLabel(a)));
  return names.length <= 1 ? (names[0] ?? "an unknown author") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The provider that wrote the change a step reviews: the pull request's newest change for a dedicated
 * review task, else the newest code change among the step's inputs. "user" when a person supplied it.
 */
export function writerOf(s: State, t: Task, st: StepDef): ChangeAuthor | undefined {
  if (t.reviewTarget) {
    const pr = s.tasks.find((x) => x.id === t.reviewTarget!.taskId)?.integration?.pr;
    return pr && pr.n === t.reviewTarget.n ? pr.changeAuthor : undefined;
  }
  let best: Artifact | undefined;
  for (const i of consumedInputs(s, t, st)) {
    const art = s.artifacts.find((x) => x.id === i.artifactId);
    if (art?.kind === "code-change" && (!best || art.createdAt > best.createdAt)) best = art;
  }
  return best ? artifactAuthor(s, best) : undefined;
}

/**
 * Everyone a step's review must be independent of. For a dedicated review task that is every author of
 * the pull request (the task's own coder runs and every fix pushed onto it), not only the newest.
 */
export function writersOf(s: State, t: Task, st: StepDef): ChangeAuthor[] {
  if (t.reviewTarget) {
    const pr = s.tasks.find((x) => x.id === t.reviewTarget!.taskId)?.integration?.pr;
    return pr && pr.n === t.reviewTarget.n ? prAuthors(pr) : [];
  }
  const w = writerOf(s, t, st);
  return w ? [w] : [];
}

/**
 * Resolution order: step pin → task role override → independence → project role default → project
 * default. Independence applies to a step marked `independentOf: "writer"` while the project asks for
 * a reviewer from another provider: when the default would be one of the writers' own providers, a
 * provider that wrote none of the change is chosen, and when that one is not enabled, or none exists,
 * the step does not resolve. Nothing is ever substituted, no provider reviews its own work, and a pin
 * or override the user set always wins (the merge gate then reports a review that is not independent).
 */
export function resolveStep(s: State, t: Task, st: Step): Resolution {
  const p = s.project;
  // ORC-013: a Checks step is run by the service, never by a provider; dispatch never asks for it.
  if (st.role === "checks") return { ok: false, reason: "run by the service" };
  let selection: ModelSelection;
  let source: SelectionSource;
  let independence: string | undefined;
  // ORC-021: the security reviewer follows the code reviewer's role default unless it has one of its own.
  const fallback = (): [ModelSelection, SelectionSource] => {
    const d = roleDefaultFor(p, st.role);
    return d ? [d, "project-role"] : [p.defaultSelection, "project-default"];
  };
  if (st.selection) [selection, source] = [st.selection, "step"];
  else if (t.roleOverrides[st.role]) [selection, source] = [t.roleOverrides[st.role]!, "task-role"];
  else {
    [selection, source] = fallback();
    // A person's own commit constrains nobody: any agent is independent of it.
    const writers = (st.independentOf === "writer" && p.prDelivery.reviewer === "other-provider" ? writersOf(s, t, st) : []).filter((w) => w !== "user");
    if (writers.includes("unknown") || writers.includes(selection.provider)) {
      const free = independentProviders(writers);
      if (free.length === 0) {
        const why = writers.includes("unknown") ? "who wrote this change is not on record" : `${authorsLabel(writers)} each wrote part of this change`;
        return { ok: false, reason: `No agent's review would be independent: ${why}, and no provider reviews its own work. Merge it yourself, or let any agent count as the reviewer (Settings → Delivery). Nothing was substituted.` };
      }
      const other = free[0];
      if (!p.enabledProviders.includes(other)) {
        return { ok: false, reason: `Independent review needs ${providerLabel(other)}, which is not enabled. Enable it in Settings, or let any agent count as the reviewer (Settings → Delivery). Nothing was substituted.` };
      }
      [selection, source] = [{ provider: other, model: "auto" }, "independence"];
      independence = `${providerLabel(other)}: other provider than the writer (${authorsLabel(writers)})`;
    }
  }

  if (!p.enabledProviders.includes(selection.provider)) {
    return { ok: false, reason: `${providerLabel(selection.provider)} is not enabled. Enable it in Settings or choose another provider for this step.` };
  }
  const catalog = p.catalog[selection.provider];
  if (selection.model === "auto") {
    if (catalog.length === 0) return { ok: false, reason: `No models available for ${providerLabel(selection.provider)}.` };
    return {
      ok: true,
      selection: { provider: selection.provider, model: catalog[0].id },
      source,
      reason: independence ?? `Auto: ${catalog[0].id}, the first model in the ${providerLabel(selection.provider)} catalog`,
    };
  }
  if (!catalog.some((m) => m.id === selection.model)) {
    return { ok: false, reason: `Model ${selection.model} is not in the ${providerLabel(selection.provider)} catalog.` };
  }
  return { ok: true, selection, source, reason: sourceLabel(source) };
}

export function providerLabel(p: Runner) {
  return p === "claude" ? "Claude" : p === "codex" ? "Codex" : "Service";
}

export function sourceLabel(src: SelectionSource) {
  switch (src) {
    case "service":
      return "Run by the service";
    case "step":
      return "Pinned on this step";
    case "task-role":
      return "Task role override";
    case "independence":
      return "Independent of the writer";
    case "project-role":
      return "Project role default";
    case "project-default":
      return "Project default";
  }
}
