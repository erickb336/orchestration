// ORC-017 §3.3: progress by area, derived from task state only. Nothing here is stored. Also the one
// place that says what a task is waiting on the user for (§3.2 "Needs you" badge, §3.4 list), so the
// board, the Overview and the progress rows agree.

import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { FindingDecision, Landed, Message, PrDelivery, Runner, SpecOption, State, SteeringChangeSet, Step, Task } from "../domain/types";

/** The group for tasks whose spec names no area. */
export const OTHER_AREA = "Other";

export type Bucket = "done" | "work" | "you" | "rest";

export interface NeedsYou {
  /** What waits, in a few words: "merge PR", "choose an option", "decide a finding". */
  what: string;
  /** The one control that opens the right place. */
  action: string;
  href: string;
}

/** The spec's area, trimmed; empty means "Other". */
export function areaOf(task: Task): string {
  return M.currentSpec(task).content.area.trim() || OTHER_AREA;
}

/** Tasks the service made for pull-request delivery are not the product's work: the domain's definition, so the board and the domain agree. */
export const serviceOwned = M.serviceOwned;

const taskHref = (t: Task) => `#/task/${encodeURIComponent(t.id)}`;

/**
 * What a task waits on the user for, or nothing. Reuses the derivations the Review page and the task page
 * use; the most pressing item wins when several apply.
 */
export function needsYouOf(state: State, task: Task, nowMs = Date.now()): NeedsYou | undefined {
  const href = taskHref(task);
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const i = task.integration;
  const pr = i?.pr;
  if (pr && i?.status === "integrated" && (pr.phase === "built" || pr.phase === "open")) {
    if (pr.attention && !D.openRepair(state, pr)) return { what: PR_PROBLEM, action: "Open", href };
    if (D.prReady(state, task, nowMs)) return { what: "merge PR", action: "Merge", href: "#/results" };
  }
  if (i?.landed?.status === "unreviewed" && i.landed.flags.length) return { what: "look at flagged work", action: "Open", href: "#/results" };
  if (task.controlFailure) return { what: "retry the stop", action: "Open", href };
  if (task.steps.some((st) => st.role === "checks" && st.state === "blocked" && st.blockedReason?.startsWith("Checks failed"))) return { what: "decide on failing checks", action: "Decide", href };
  if (F.openDecisions(state, "user").some((d) => d.taskId === task.id)) return { what: "decide a finding", action: "Decide", href };
  if (open && task.hold && task.holdReason) return { what: "review the step", action: "Open", href };
  if (open && task.holdBeforeStart && task.lifecycle !== "active" && !task.heldForShaping && !task.hold && !M.deferredBy(state, task)) {
    return { what: M.currentSpec(task).content.options.length > 1 ? "choose an option" : "give the go-ahead", action: "Open", href };
  }
  return undefined;
}

/** The "what" of a pull request that stopped on a problem; the Overview shows the problem's message under it. */
export const PR_PROBLEM = "decide on the pull request";

export interface LiveAgent {
  taskId: string;
  title: string;
  provider: Runner;
  /** "implementing", "reviewing", "designing", "verifying", "planning", "running checks", "stopping". */
  verb: string;
  stepId: string;
  purpose: string;
}

function verbOf(step: Step, stopping: boolean): string {
  if (stopping) return "stopping";
  switch (step.role) {
    case "coder":
      return "implementing";
    case "designer":
      return "designing";
    case "code_reviewer":
    case "security_reviewer":
    case "ux_reviewer":
      return "reviewing";
    case "checks":
      return "running checks";
    case "lead":
      return step.outputs.some((o) => o.kind === "breakdown") ? "planning" : "verifying";
    default:
      return "working on";
  }
}

/** Every agent (or service run) working on a task right now; two runs of one provider doing the same thing on one task are listed once. */
export function liveAgents(state: State, task: Task): LiveAgent[] {
  const title = M.currentSpec(task).content.title;
  const seen = new Set<string>();
  return M.activeAttempts(state, task.id).flatMap((a) => {
    const st = task.steps.find((x) => x.id === a.stepId);
    if (!st) return [];
    const verb = verbOf(st, a.outcome === "stopping");
    const key = `${a.snapshot.provider}|${verb}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ taskId: task.id, title, provider: a.snapshot.provider, verb, stepId: st.id, purpose: st.purpose }];
  });
}

/** "Codex · implementing" (the task title follows it in the row). */
export function liveText(a: LiveAgent): string {
  return `${M.providerLabel(a.provider)} · ${a.verb}`;
}

export interface AreaProgress {
  area: string;
  /** Tasks in the area that were not cancelled. */
  total: number;
  /** Tasks whose pipeline finished. */
  done: number;
  /** Tasks with an agent or service run active ("in progress"; the header's count is agents only). */
  working: number;
  /** Tasks that wait on the user. */
  needsYou: number;
  /** Each task in one bucket, for the bar: needs you, then agents working, then done, then the rest. */
  buckets: Record<Bucket, number>;
  /** The bar's segments in task order (priority, then id). */
  segments: Bucket[];
  live: LiveAgent[];
  /** The newest `updatedAt` among the area's tasks. */
  lastActivity: string;
  /** The tasks in the "rest" bucket by what they are doing, for the label. */
  restKinds: Record<RestKind, number>;
  /** The counts in words, for the bar's aria-label. */
  label: string;
}

export type RestKind = "paused" | "deferred" | "waiting" | "notStarted";

/** Why a task in the "rest" bucket is not moving: paused by you, deferred, waiting (started, nothing running), or not started. */
function restKindOf(state: State, task: Task): RestKind {
  if (M.column(state, task) === "paused") return "paused";
  if (M.deferredBy(state, task)) return "deferred";
  if (task.lifecycle === "active") return "waiting";
  return "notStarted";
}

function bucketOf(state: State, task: Task, nowMs: number): Bucket {
  if (needsYouOf(state, task, nowMs)) return "you";
  if (M.activeAttempts(state, task.id).length) return "work";
  if (task.lifecycle === "done") return "done";
  return "rest";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function labelOf(p: Omit<AreaProgress, "label">): string {
  const parts = [`${p.area}: ${p.done} of ${plural(p.total, "task")} done`];
  if (p.working) parts.push(`${p.working} in progress`);
  if (p.needsYou) parts.push(`${p.needsYou} need${p.needsYou === 1 ? "s" : ""} you`);
  const k = p.restKinds;
  if (k.paused) parts.push(`${k.paused} paused`);
  if (k.deferred) parts.push(`${k.deferred} deferred`);
  if (k.waiting) parts.push(`${k.waiting} waiting`);
  if (k.notStarted) parts.push(`${k.notStarted} not started`);
  return parts.join(", ");
}

/**
 * One entry per area, in display order: areas with agents working or something that needs you first,
 * then by the most recent activity, then by name. Cancelled tasks and the service's own delivery tasks
 * are left out; tasks with no area are grouped as "Other".
 */
export function progressByArea(state: State, nowMs = Date.now()): AreaProgress[] {
  const groups = new Map<string, Task[]>();
  const tasks = state.tasks.filter((t) => t.lifecycle !== "cancelled" && !serviceOwned(t)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const t of tasks) {
    const area = areaOf(t);
    const list = groups.get(area);
    if (list) list.push(t);
    else groups.set(area, [t]);
  }
  const out: AreaProgress[] = [];
  for (const [area, list] of groups) {
    const buckets: Record<Bucket, number> = { done: 0, work: 0, you: 0, rest: 0 };
    const restKinds: Record<RestKind, number> = { paused: 0, deferred: 0, waiting: 0, notStarted: 0 };
    const segments: Bucket[] = [];
    let done = 0;
    let working = 0;
    let needsYou = 0;
    let lastActivity = "";
    const live: LiveAgent[] = [];
    for (const t of list) {
      const b = bucketOf(state, t, nowMs);
      buckets[b]++;
      segments.push(b);
      if (b === "rest") restKinds[restKindOf(state, t)]++;
      if (t.lifecycle === "done") done++;
      const agents = liveAgents(state, t);
      if (agents.length) working++;
      live.push(...agents);
      if (needsYouOf(state, t, nowMs)) needsYou++;
      if (t.updatedAt > lastActivity) lastActivity = t.updatedAt;
    }
    const p = { area, total: list.length, done, working, needsYou, buckets, segments, live, lastActivity, restKinds };
    out.push({ ...p, label: labelOf(p) });
  }
  return out.sort((a, b) => {
    const ka = a.working || a.needsYou ? 0 : 1;
    const kb = b.working || b.needsYou ? 0 : 1;
    if (ka !== kb) return ka - kb;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    return a.area.localeCompare(b.area);
  });
}

/** How many agents work right now, for the header: agent runs only (the service's check runs are not agents). */
export function agentsWorking(state: State): number {
  // Agents only: the service's own check runs are not agents and have their own limit.
  return M.activeAgentAttempts(state).filter((a) => a.outcome === "running").length;
}

/** ORC-025: agent runs that were asked to stop and have not acknowledged yet. They are still busy, so the header never says Idle over them. */
export function agentsStopping(state: State): number {
  return M.activeAgentAttempts(state).filter((a) => a.outcome === "stopping").length;
}

/** The header's live text: "3 agents working", "3 agents working, 1 stopping", "2 agents stopping", or "Idle" only when no agent run is active. */
export function liveIndicatorText(working: number, stopping: number, shaping = false): string {
  const agents = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
  if (!working && !stopping) return "Idle";
  const text = working ? `${agents(working)} working${stopping ? `, ${stopping} stopping` : ""}` : `${agents(stopping)} stopping`;
  return shaping && working ? `${text} (finishing; shaping)` : text;
}

// ---------- ORC-025 pass 2: the badges (N7) ----------

/**
 * The pull requests that wait for you, as the Results page lists them under "Needs you": ready for your merge, or
 * stopped on a problem nobody is fixing. The Results badge counts these and nothing else.
 */
export function prsNeedingYou(state: State, nowMs = Date.now()): Task[] {
  return D.trackedPrTasks(state).filter((t) => {
    const pr = t.integration!.pr!;
    return (!!pr.attention && !D.openRepair(state, pr)) || D.prReady(state, t, nowMs);
  });
}

/** Lead replies newer than the last one this browser showed (`seenAt`, from PREF_LEAD_SEEN). The Lead badge counts these only. */
export function unreadLeadReplies(state: State, seenAt: string | null): number {
  return state.conversation.filter((m) => m.author === "lead" && (!seenAt || m.at > seenAt)).length;
}

// ---------- ORC-025 pass 2: "Latest from the lead" (N3) ----------

export interface LatestReply {
  message: Message;
  set?: SteeringChangeSet;
  applied: number;
  suggested: number;
  /** "2 changes, 1 suggestion" or "No changes". */
  summary: string;
}

/** "2 changes, 1 suggestion"; "No changes" when a reply changed nothing. */
export function changeSummary(applied: number, suggested: number): string {
  const parts: string[] = [];
  if (applied) parts.push(`${applied} change${applied === 1 ? "" : "s"}`);
  if (suggested) parts.push(`${suggested} suggestion${suggested === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "No changes";
}

/** The lead's newest reply and what it changed, or nothing when the lead has not replied yet. */
export function latestLeadReply(state: State): LatestReply | undefined {
  for (let i = state.conversation.length - 1; i >= 0; i--) {
    const message = state.conversation[i];
    if (message.author !== "lead") continue;
    const set = message.changeSetId ? state.steering.find((cs) => cs.id === message.changeSetId) : undefined;
    const applied = set?.changes.filter((c) => c.status === "applied").length ?? 0;
    const suggested = set?.changes.filter((c) => c.status === "suggested").length ?? 0;
    return { message, set, applied, suggested, summary: changeSummary(applied, suggested) };
  }
  return undefined;
}

/** The first lines of a reply: the first paragraph, cut at a word boundary with an ellipsis when it runs past `max` characters. */
export function replyExcerpt(text: string, max = 240): string {
  const first = text.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, "")}…`;
}

// ---------- ORC-025 pass 2: decisions taken in place on Home (H3) ----------

/** One mark of the verdict line: "Code ✓", "Security ✓", "Checks ✓". */
export interface VerdictMark {
  label: "Code" | "Security" | "Checks";
  ok: boolean;
}

/**
 * The verdict line of a pull request, from the same merge gate the task page shows. A clean "review" item means
 * both a code review and a security review saw the final change (delivery.ts: a clean pipeline review needs
 * the security review too, and the dedicated review flow carries both). "Checks" covers GitHub's required checks
 * and, when the project runs its own, the service's checks.
 */
export function mergeVerdict(state: State, task: Task, nowMs: number): VerdictMark[] {
  const items = D.prGate(state, task, nowMs, { byUser: true }).items;
  const ok = (id: D.GateItem["id"]) => items.find((i) => i.id === id)?.ok ?? false;
  const service = items.find((i) => i.id === "service-checks");
  return [
    { label: "Code", ok: ok("review") },
    { label: "Security", ok: ok("review") },
    { label: "Checks", ok: ok("checks") && (!service || service.ok) },
  ];
}

/** What a landed item passed, for its row: "Code ✓ Security ✓" from its review evidence, "Checks ✓" when every required check on the merged head succeeded. */
export function landedVerdict(landed: Landed): string[] {
  const out: string[] = [];
  if (landed.review?.ok) out.push("Code ✓", "Security ✓");
  const required = landed.checks?.filter((c) => c.required) ?? [];
  if (required.length && required.every((c) => c.conclusion === "SUCCESS")) out.push("Checks ✓");
  return out;
}

/**
 * One thing that needs you on Home. The simple decisions are taken in place with the same commands the task page
 * uses: "merge" (Merge / Keep for me), "choose" (exactly two options), "finding" (Fix / Accept as is / Message the
 * lead), "start" (your go-ahead). Everything else is "open": one link to the place where it is decided.
 */
export type NeedsYouEntry =
  | { kind: "merge"; key: string; task: Task; pr: PrDelivery; verdict: VerdictMark[]; simulated: boolean }
  | { kind: "choose"; key: string; task: Task; options: SpecOption[]; recommendedId: string; specRev: number }
  | { kind: "finding"; key: string; task: Task; decision: FindingDecision }
  | { kind: "start"; key: string; task: Task }
  | { kind: "open"; key: string; task?: Task; what: string; detail?: string; action: string; href: string };

/** Whether Merge can be offered in place: the same conditions as the task page's Merge button, on a pull request that is ready. */
function mergeInPlace(state: State, task: Task, pr: PrDelivery, nowMs: number): boolean {
  return D.prReady(state, task, nowMs) && state.project.prDelivery.enabled && !mergeAsked(pr);
}

/** You already asked for the merge of this head: the service merges it; nothing is left for you to decide. */
const mergeAsked = (pr: PrDelivery) => pr.mergeRequested?.headSha === pr.headSha;

/** Everything that waits for you, in the order the Needs-you card shows it: project-wide problems first, then tasks by priority. */
export function needsYouItems(state: State, nowMs = Date.now()): NeedsYouEntry[] {
  const items: NeedsYouEntry[] = [];
  const gh = state.project.github;
  if (gh?.problem && (state.project.prDelivery.enabled || D.openPrTasks(state).length > 0)) {
    items.push({ kind: "open", key: "gh", what: "GitHub delivery is stopped", detail: gh.problem.message, action: "Settings", href: "#/settings" });
  }
  if (gh?.autoMergePaused) {
    items.push({ kind: "open", key: "auto", what: "automatic merging is paused", detail: `${gh.autoMergePaused.reason}. ${gh.autoMergePaused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again."}`, action: "Open", href: "#/results" });
  }
  for (const task of [...state.tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    const n = needsYouOf(state, task, nowMs);
    if (!n) continue;
    const pr = task.integration?.pr;
    const open = (): NeedsYouEntry => ({ kind: "open", key: task.id, task, what: n.what, detail: n.what === PR_PROBLEM ? pr?.attention?.message : undefined, action: n.action, href: n.href });
    if (n.what === "merge PR" && pr && mergeAsked(pr)) continue;
    if (n.what === "merge PR" && pr && mergeInPlace(state, task, pr, nowMs)) {
      items.push({ kind: "merge", key: task.id, task, pr, verdict: mergeVerdict(state, task, nowMs), simulated: !!pr.simulated });
    } else if (n.what === "choose an option") {
      const spec = M.currentSpec(task);
      if (spec.content.options.length === 2) items.push({ kind: "choose", key: task.id, task, options: spec.content.options, recommendedId: spec.content.recommendedOptionId, specRev: spec.rev });
      else items.push(open());
    } else if (n.what === "decide a finding") {
      // One row per decision, so each is decided once; a decision on failing final checks has its own controls on the task page.
      const mine = F.openDecisions(state, "user").filter((d) => d.taskId === task.id && d.kind === "finding");
      if (mine.length) for (const decision of mine) items.push({ kind: "finding", key: decision.id, task, decision });
      else items.push(open());
    } else if (n.what === "give the go-ahead") {
      items.push({ kind: "start", key: task.id, task });
    } else items.push(open());
  }
  return items;
}

/** The two options as one line: "A, Guest link · B, One-time code". */
export function optionsLine(options: SpecOption[]): string {
  return options.map((o) => `${o.id}, ${o.name}`).join(" · ");
}
