// Durable project store on SQLite (node:sqlite, no native dependency).
//
// The authoritative project state is one document, changed only by pure domain operations
// inside BEGIN IMMEDIATE transactions. Alongside it: an append-only command log with idempotency
// keys, a mirrored event table for querying, and a lease table for the single scheduler.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InvalidCommandError, runCommand } from "../src/domain/commands";
import { internalFlow } from "../src/domain/internalFlows";
import { builtInCatalog, flowRef } from "../src/domain/flows";
import { toDef } from "../src/domain/pipeline";
import { buildSeed } from "../src/domain/seed";
import { emptyBlueprint, emptyStudio } from "../src/domain/studio/types";
import { ControlError, DEFAULT_AUTONOMY, DEFAULT_CHECKS, DEFAULT_PR_DELIVERY, DEFAULT_REVIEW_BOTS, DEFAULT_RUN_LIMITS, NO_BUDGETS, StaleWriteError, type FlowRef, type State, type StepDef } from "../src/domain/types";
import { V13_TEMPLATE_STEPS, V14_TEMPLATES, v14TemplateSteps } from "./legacyTemplates";

export const STATE_FORMAT = 19;

export { V13_TEMPLATE_STEPS };

/** Step lists compared in their normalised form, so key order and absent optionals do not count as edits. */
const sameSteps = (a: StepDef[], b: StepDef[]) => JSON.stringify(a.map(toDef)) === JSON.stringify(b.map(toDef));

/**
 * What a task from before flows ran. Service-owned tasks name their internal flow; every
 * other task is "legacy": the format-14 template its first pipeline revision names, or "custom".
 */
function legacyFlowRef(t: { reviewTarget?: unknown; checkTarget?: unknown; revertOf?: unknown; pipelineHistory?: { reason?: string }[] }): FlowRef {
  const internal = t.reviewTarget ? "delivery-review" : t.checkTarget ? "delivery-checks" : t.revertOf ? "revert" : undefined;
  // No hash: the format-14 internal template may have been edited, and the task's purposes were rewritten by delivery.
  if (internal) {
    const { hash: _hash, ...ref } = flowRef(internalFlow(internal), "migration");
    return ref;
  }
  const reason = t.pipelineHistory?.[0]?.reason ?? "";
  const named = /(?:from|applied) the (.+) template/.exec(reason)?.[1]?.trim();
  const v14 = named ? Object.values(V14_TEMPLATES).find((x) => x.name === named || x.id === named) : undefined;
  return { id: v14?.id ?? "custom", name: v14?.name ?? named ?? "Custom pipeline", source: "legacy", chosenBy: "migration" };
}

/** In-place upgrades of the state document, keyed by the format they upgrade from. */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  3: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.runLimits ??= { ...DEFAULT_RUN_LIMITS };
    doc.version = 4;
    return doc;
  },
  4: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.workerEnvironment ??= { claude: "isolated", codex: "isolated" };
    project.workerConnections ??= { claude: [], codex: [] };
    doc.version = 5;
    return doc;
  },
  5: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.sample ??= project.name === "Example Notes (sample)" || project.repoPath === "~/code/example-notes";
    project.id ??= project.sample ? "sample" : `p-${Date.now().toString(36)}`;
    doc.version = 6;
    return doc;
  },
  6: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.autonomy ??= { ...DEFAULT_AUTONOMY };
    doc.conversation ??= [];
    doc.leadRuns ??= [];
    doc.version = 7;
    return doc;
  },
  7: (doc) => {
    const a = (doc.project as Record<string, unknown>).autonomy as Record<string, unknown>;
    a.autoRetry ??= 0;
    a.autoDeliver ??= { enabled: false, branch: "main" };
    doc.version = 8;
    return doc;
  },
  8: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const n = Number(project.workerLimit ?? 3);
    project.providerLimits ??= { claude: n, codex: n };
    doc.version = 9;
    return doc;
  },
  // Format 10 adds pull-request delivery settings, off. Nothing observed and no review-later items are
  // created: earlier deliveries are never backfilled.
  9: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.prDelivery ??= structuredClone(DEFAULT_PR_DELIVERY);
    doc.version = 10;
    return doc;
  },
  // Format 11 adds steering by conversation. Priorities the user set with the Set control are pinned
  // from their events (before format 11 only the user could reprioritize). Priorities chosen in the New
  // task form cannot be told apart from its default, so they are not pinned. Existing lead runs get no
  // visionRev: one that completes after the upgrade has its steering refused.
  10: (doc) => {
    const project = doc.project as Record<string, unknown>;
    doc.steering ??= [];
    project.steeringMode ??= "apply";
    const re = /^Priority P\d+ → P\d+$/;
    const tasks = (doc.tasks ?? []) as { id: string; userSet?: { priority?: string; run?: string } }[];
    for (const e of (doc.events ?? []) as { actor: string; kind: string; taskId?: string; message: string; at: string }[]) {
      if (e.actor !== "user" || e.kind !== "control" || !e.taskId || !re.test(e.message)) continue;
      const t = tasks.find((x) => x.id === e.taskId);
      if (t) (t.userSet ??= {}).priority = e.at;
    }
    doc.version = 11;
    return doc;
  },
  // Format 12 adds the shaping stage. Every existing project keeps working as before (building); no drafts yet.
  11: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.stage ??= "building";
    doc.visionDrafts ??= [];
    doc.version = 12;
    return doc;
  },
  // Format 13 adds vision documents. No project has any yet; existing revisions record none (`docIds`
  // absent). A project of the user's own with an empty vision cannot be building; it shapes first. The
  // roadmap's hold while shaping becomes its own flag; the user's hold before start then follows the
  // involvement setting, as a lead proposal's would.
  12: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.visionDocs ??= [];
    const visions = (project.visions ?? []) as { text?: unknown }[];
    const text = String(visions[visions.length - 1]?.text ?? "");
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    if (!project.sample && !text.trim() && project.stage !== "shaping") {
      // A stage change is state the user can see: it is recorded, and shaping starts now.
      project.stage = "shaping";
      project.shapingSince = now;
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "config", message: "Moved from building to shaping when the state format was upgraded: the project has no vision yet. Write or accept one, then start building." });
    }
    if (project.stage === "shaping") {
      project.shapingSince ??= now;
      const a = (project.autonomy ?? {}) as { enabled?: boolean; holdLeadProposals?: boolean };
      // A hold the user set on the task themselves stays the user's hold. The last
      // hold event decides: "enabled" by the user means theirs; released or removed means the roadmap's.
      const userHeld = new Set<string>();
      for (const e of events) {
        if (e.actor !== "user" || e.kind !== "control" || !e.taskId) continue;
        if (e.message === "Hold before start enabled") userHeld.add(e.taskId);
        else if (e.message === "Hold before start removed" || e.message.startsWith("Hold-before-start released")) userHeld.delete(e.taskId);
      }
      for (const t of (doc.tasks ?? []) as { id: string; fromShaping?: boolean; holdBeforeStart?: boolean; heldForShaping?: boolean; lifecycle?: string }[]) {
        if (!t.fromShaping || !t.holdBeforeStart || (t.lifecycle !== "proposed" && t.lifecycle !== "ready")) continue;
        if (userHeld.has(t.id)) continue;
        t.heldForShaping = true;
        t.holdBeforeStart = !a.enabled || !!a.holdLeadProposals;
      }
    }
    doc.version = 13;
    return doc;
  },
  // Format 14 adds quality gates. Defaults are added: checks off, findings routed to the lead on projects that
  // plan on their own (so Autopilot keeps running) and to the user otherwise, conventions on, the
  // pull-request triage settings. Nothing is backfilled: no artifact gains findings or coverage, no
  // decision is created, and running tasks keep their steps. Built-in templates the user never
  // edited gain the Checks steps; edited ones are left alone, with an event.
  13: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const autonomy = (project.autonomy ?? {}) as { enabled?: boolean };
    project.checks ??= structuredClone(DEFAULT_CHECKS);
    project.triage ??= { askUserBy: autonomy.enabled ? "lead" : "user" };
    project.conventions ??= { include: true };
    const prDelivery = (project.prDelivery ??= structuredClone(DEFAULT_PR_DELIVERY)) as Record<string, unknown>;
    prDelivery.rerunBudget ??= 1;
    prDelivery.reviewBotApps ??= [...DEFAULT_REVIEW_BOTS];
    prDelivery.noCi ??= false;
    for (const t of (doc.tasks ?? []) as { integration?: { pr?: { counters?: Record<string, number> } } }[]) {
      const c = t.integration?.pr?.counters;
      if (!c) continue;
      c.reruns ??= 0;
      c.checks ??= 0;
    }
    doc.decisions ??= [];
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    const note = (message: string) => {
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "config", message });
    };
    // This reads the frozen format-14 templates, so the upgrade keeps working now that the live
    // code has flows instead of templates.
    for (const t of (project.templates ?? []) as { id: string; builtIn?: boolean; rev: number; steps: StepDef[]; description?: string }[]) {
      const legacy = V13_TEMPLATE_STEPS[t.id];
      if (!t.builtIn || !legacy) continue;
      if (sameSteps(t.steps, legacy)) {
        t.steps = v14TemplateSteps(t.id);
        // The description follows the steps, so the template does not show as "edited".
        const builtIn = V14_TEMPLATES[t.id];
        if (builtIn) t.description = builtIn.description;
        t.rev += 1;
        note(`Template ${t.id} gained the Checks steps (run by the service; skipped while checks are off) when the state format was upgraded`);
      } else note(`Template ${t.id} was edited, so it did not gain the Checks steps; the built-in flows have them`);
    }
    doc.version = 14;
    return doc;
  },
  // Format 15 retires templates: pipelines come from the catalog. Custom templates and edited built-ins
  // are retired (an edited or custom template is simply gone, and an event says so; it is not exported as
  // a file); unedited built-ins are dropped, since the catalog provides them. Tasks are not touched: no
  // step, revision, history, pin or state changes, and a run active across the upgrade finishes normally.
  // Each task records what it ran as a legacy or internal reference, under the format-15 names; the
  // 15 → 16 upgrade renames them.
  14: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    const note = (message: string) => {
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "config", message });
    };
    for (const t of (project.templates ?? []) as { id: string; name: string; description: string; steps: StepDef[] }[]) {
      const b = V14_TEMPLATES[t.id];
      const unedited = b && sameSteps(t.steps, b.steps) && t.name === b.name && t.description === b.description;
      if (unedited) continue; // the built-in flows provide it; the service's own pipelines stay in code
      note(`Template "${t.name}" was retired: pipelines now come from the built-in flows. Tasks that ran it keep their steps.`);
    }
    delete project.templates;
    project.defaultPatternId ??= "change";
    for (const t of (doc.tasks ?? []) as Record<string, unknown>[]) {
      t.pattern ??= legacyFlowRef(t as Parameters<typeof legacyFlowRef>[0]);
      t.patternSince ??= 0;
    }
    doc.version = 15;
    return doc;
  },
  // Format 16: "pattern" becomes "flow". Persisted fields are renamed (task.pattern → task.flow,
  // task.patternSince → task.flowSince, pipelineHistory[].pattern → .flow, project.defaultPatternId →
  // project.defaultFlowId, state.patterns → state.flows); task.outcome and retiredTemplates are dropped;
  // a reference keeps only id, name, source, hash and chosenBy (the extends chain and the experiment flag
  // are gone). Tasks that ran a removed catalog entry keep their steps and their recorded id and name;
  // nothing about any pipeline changes. A default that named a removed entry or a personal file becomes "change".
  15: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const ref = (p: unknown): FlowRef | undefined => {
      if (!p || typeof p !== "object") return undefined;
      const { id, name, source, hash, chosenBy } = p as FlowRef;
      return { id, name, source, ...(hash !== undefined ? { hash } : {}), chosenBy };
    };
    const stored = typeof project.defaultPatternId === "string" ? project.defaultPatternId : "change";
    // Personal flow files are gone too, so any id that is not one of the six becomes "change".
    project.defaultFlowId = builtInCatalog().some((f) => f.id === stored) ? stored : "change";
    delete project.defaultPatternId;
    for (const t of (doc.tasks ?? []) as Record<string, unknown>[]) {
      const flow = ref(t.pattern);
      if (flow) t.flow = flow;
      delete t.pattern;
      t.flowSince = typeof t.patternSince === "number" ? t.patternSince : 0;
      delete t.patternSince;
      delete t.outcome;
      for (const h of (t.pipelineHistory ?? []) as Record<string, unknown>[]) {
        const applied = ref(h.pattern);
        if (applied) h.flow = applied;
        delete h.pattern;
      }
    }
    doc.flows = builtInCatalog(); // the server replaces it at start
    delete doc.patterns;
    delete doc.retiredTemplates;
    doc.version = 16;
    return doc;
  },
  // Format 17 adds notes to running stages. Older databases have none; nothing else moves (a steering row's kind
  // gains "note", which no stored row has yet).
  16: (doc) => {
    doc.notes ??= [];
    doc.version = 17;
    return doc;
  },
  // Format 18: parallel copies, best-of choices and gate steps are gone. Their fields are dropped from every
  // task, step and pipeline revision; a task that had any of them gets one event saying what changed. Copies
  // stay as the ordinary steps they already were (same ids and purposes), so a finished task's record still
  // reads. An open task whose copies were best-of candidates is held with the reason: every finished copy's
  // output now goes forward, and a person should look at the pipeline before it continues. A task already
  // held keeps its hold and reason.
  17: (doc) => {
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    const note = (taskId: string, message: string) => {
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "pipeline", taskId, message });
    };
    type OldStep = { id: string; gate?: boolean; parallel?: { mode?: string }; copyOf?: string };
    type OldTask = { id: string; lifecycle: string; hold?: boolean; holdReason?: string; steps: OldStep[]; pipelineHistory?: { steps?: OldStep[] }[]; bestOf?: Record<string, string>; bestOfByUser?: unknown };
    const strip = (s: OldStep) => {
      delete s.gate;
      delete s.parallel;
      delete s.copyOf;
    };
    const ordinary = (ids: string[]) => (ids.length === 1 ? `${ids[0]} is now an ordinary step` : `${ids.join(", ")} are now ordinary steps`);
    const pauses = (ids: string[]) => (ids.length === 1 ? `${ids[0]} is no longer a pause for you` : `${ids.join(", ")} are no longer pauses for you`);
    const expands = (ids: string[]) => (ids.length === 1 ? `${ids[0]} no longer expands into parallel agents` : `${ids.join(", ")} no longer expand into parallel agents`);
    for (const t of (doc.tasks ?? []) as OldTask[]) {
      const copies = t.steps.filter((s) => s.copyOf && s.copyOf !== s.id).map((s) => s.id);
      const bestOfGroups = t.steps.filter((s) => s.parallel?.mode === "best-of" && t.steps.some((c) => c.copyOf === s.id && c.id !== s.id)).map((s) => s.id);
      const unexpanded = t.steps.filter((s) => s.parallel && !s.copyOf).map((s) => s.id);
      const gates = t.steps.filter((s) => s.gate).map((s) => s.id);
      const choice = Object.entries(t.bestOf ?? {}).map(([group, chosen]) => `${chosen} for ${group}`);
      const had = copies.length || bestOfGroups.length || unexpanded.length || gates.length || choice.length || t.bestOfByUser !== undefined;
      t.steps.forEach(strip);
      for (const h of t.pipelineHistory ?? []) (h.steps ?? []).forEach(strip);
      delete t.bestOf;
      delete t.bestOfByUser;
      if (!had) continue;
      const parts = [
        copies.length ? `${ordinary(copies)} (every finished copy's output goes forward)` : "",
        choice.length ? `the recorded choice (${choice.join(", ")}) is dropped` : "",
        unexpanded.length ? expands(unexpanded) : "",
        gates.length ? pauses(gates) : "",
      ].filter(Boolean);
      note(t.id, `Parallel copies, best-of choices and gate steps were removed from Orchestrator when the state format was upgraded: ${parts.join("; ")}.`);
      const open = t.lifecycle !== "done" && t.lifecycle !== "cancelled";
      if (open && bestOfGroups.length && !t.hold) {
        t.hold = true;
        t.holdReason = `Parallel copies were removed in this version: ${ordinary(copies)} and every finished copy's output goes forward. Check the pipeline, then resume.`;
      }
    }
    doc.version = 18;
    return doc;
  },
  // Format 19 (ORC-029): Vision and the factory. Every project keeps its stage; one already building needs no
  // start record (it started before the owner's Start the factory existed). Existing projects were designed for
  // the desktop. The owner's budgets are added, not set: nothing stops until the owner sets one. Change orders go
  // to the lead, the default of a new project. The studio and the blueprint start empty.
  18: (doc) => {
    normalize19(doc);
    doc.version = 19;
    return doc;
  },
};

/**
 * Format 19's fields, added where a document lacks them. Format 19 is unreleased, and early builds of ORC-029 passes
 * 2 to 4 wrote it before all of its fields existed, so this runs on every load of a format-19 database as well as in
 * the 18 → 19 upgrade. Idempotent. A change order without a handler takes the project's setting. The blueprint's draft
 * (pass 5) starts as a copy of the version in force, so the revisions stay in force and the draft holds no change.
 * Start records are history and are never rewritten: an early start's settings carry `merge` where later ones carry
 * `delivery`.
 */
function normalize19(doc: Record<string, unknown>): Record<string, unknown> {
  const project = doc.project as Record<string, unknown>;
  project.devices ??= ["desktop"];
  // The product's domains (pass 4) came after the first format-19 builds: not chosen yet, so the lead asks.
  project.domains ??= [];
  project.factoryStarts ??= [];
  project.changeOrders ??= "lead";
  // PE review of new work (pass 5) came after the first format-19 builds. A project stored before it is off until the
  // owner turns it on, so loading a database never starts a paid PE run by itself. A new project starts with it on.
  project.peReviewsNewWork ??= false;
  project.budgets ??= { ...NO_BUDGETS };
  // Housekeeping of the owner's apps (2026-10-03) came after the first format-19 builds: on, as the owner asked.
  project.housekeepOwnerApps ??= true;
  doc.studio ??= emptyStudio();
  // Studio runs (pass 3a) came after the first format-19 builds: none were recorded before them.
  (doc.studio as { runs?: unknown[] }).runs ??= [];
  doc.blueprint ??= emptyBlueprint();
  const blueprint = doc.blueprint as { revisions?: { items: unknown[] }[]; draft?: unknown; changeOrders?: Record<string, unknown>[] };
  // The draft (pass 5): the revisions stay in force, and the draft starts as a copy of the version in force, so it
  // holds no change. Its revision starts at 0.
  blueprint.draft ??= { rev: 0, items: structuredClone(blueprint.revisions?.at(-1)?.items ?? []) };
  for (const co of (blueprint.changeOrders ??= [])) {
    co.handler ??= project.changeOrders;
    // Change orders from before pass 5 listed the tasks it touched, which the lead was to update, and dropped nothing.
    if (co.tasks === undefined) co.tasks = ((co.affectedTasks ?? []) as string[]).map((taskId) => ({ taskId, handling: "update-spec" }));
    delete co.affectedTasks;
    co.droppedItems ??= [];
    co.newWork ??= [];
    // Early pass 5 builds put one PE review on a change order's updates; the PE now reviews the work each update makes.
    delete co.peReview;
    for (const line of (co.lines ?? []) as Record<string, unknown>[]) normalizeLine(doc, co, line);
  }
  endPass3Reviews(doc.studio as { artifacts: Record<string, unknown>[]; verdicts: Record<string, unknown>[] });
  return doc;
}

const LINE_STATUSES = ["applied", "suggested", "dismissed", "undone"];

/**
 * A change order's line keeps where it stands (pass 5 review, finding 7). A line an early pass 5 build stored has no
 * status: it takes its steering row's while the row's set is in the log (a status a line cannot have reads "refused"),
 * and with the set gone, a line that still carries the lead's proposal never applied, one without it did. An applied
 * spec update gains the spec revisions the lead wrote for it (finding 6): the update, from its row or the spec record,
 * then each revision for the PE right after it. Idempotent: a line with a status is left as it is.
 */
function normalizeLine(doc: Record<string, unknown>, co: Record<string, unknown>, line: Record<string, unknown>) {
  if (line.status !== undefined) return;
  const changeId = line.changeId as string;
  const set = ((doc.steering ?? []) as { id: string; at: string; changes: Record<string, unknown>[] }[]).find((x) => x.id === changeId.slice(0, changeId.lastIndexOf(".")));
  const row = set?.changes.find((c) => c.id === changeId);
  if (row) {
    line.status = LINE_STATUSES.includes(row.status as string) ? row.status : "refused";
    if (row.appliedBy) line.appliedBy = row.appliedBy;
    const at = row.resolvedAt ?? (row.status === "applied" || row.status === "undone" ? set!.at : undefined);
    if (at) line.resolvedAt = at;
  } else line.status = line.proposal ? "suggested" : "applied";
  const before = line.before as { specRev: number } | undefined;
  if (line.kind !== "update-spec" || !before) return;
  const specs = ((doc.tasks ?? []) as { id: string; specs: { rev: number; author: string; reason: string }[] }[]).find((t) => t.id === line.taskId)?.specs ?? [];
  const first = typeof row?.after === "number" ? row.after : specs.find((x) => x.rev > before.specRev && x.author === "lead" && x.reason.startsWith(`Change order r${co.rev as number}`))?.rev;
  if (first === undefined) return;
  const revs = [first];
  for (const x of [...specs].sort((a, b) => a.rev - b.rev)) {
    if (x.rev <= first) continue;
    if (x.rev !== revs.at(-1)! + 1 || x.author !== "lead" || !x.reason.startsWith("Revised for the PE")) break;
    revs.push(x.rev);
  }
  line.specRevs = revs;
}

/**
 * Pass 3's PE passes carry `lastPass`: under the rule of the time, the pass ended review of its version (one pass, no
 * revision), and the owner was shown the version. Pass 4's loop has no such field, so a version whose last pass asked
 * for a change or objected would read "revising" again: hidden from the owner, its overrules ignored, and a paid
 * designer run asked for (review finding 3). The end is recorded on the version (`reviewEnd: earlier-rule`), then the
 * field goes. Idempotent: a document without `lastPass` is left as it is.
 */
function endPass3Reviews(studio: { artifacts: Record<string, unknown>[]; verdicts: Record<string, unknown>[] }) {
  for (const v of studio.verdicts.filter((x) => x.lastPass)) {
    const mine = studio.verdicts.filter((x) => x.artifactId === v.artifactId && x.version === v.version);
    const last = Math.max(...mine.map((x) => x.pass as number));
    const asked = mine.some((x) => x.pass === last && x.verdict !== "feasible");
    const a = studio.artifacts.find((x) => x.id === v.artifactId && x.version === v.version);
    if (a && asked && v.pass === last) a.reviewEnd ??= { reason: "earlier-rule", at: v.at };
  }
  for (const v of studio.verdicts) delete v.lastPass;
}
const SCHEMA_VERSION = 1;

type FailureKind = "stale" | "control" | "invalid" | "internal";

export class CommandFailure extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "CommandFailure";
    this.kind = kind;
  }
}

function classify(e: unknown): CommandFailure {
  if (e instanceof CommandFailure) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof StaleWriteError) return new CommandFailure("stale", message);
  if (e instanceof ControlError) return new CommandFailure("control", message);
  if (e instanceof InvalidCommandError) return new CommandFailure("invalid", message);
  return new CommandFailure("internal", message);
}

/**
 * The owner-only start, enforced where state is written (ORC-029): the project moves from shaping to building
 * only through the owner's `startFactory` command, and only when it recorded exactly one more start. Any other
 * write that would move it (another command, the scheduler, a runtime report) is refused before anything is
 * stored, whatever domain code produced it. Replacing everything with the sample project (`resetSampleData`,
 * fake runtime only; the sample never reaches a real agent) is a new project, not a start.
 * Returns why a write is refused, or undefined.
 */
function stageRefusal(prev: State, next: State, command: string | undefined): string | undefined {
  if (prev.project.stage !== "shaping" || next.project.stage !== "building") return undefined;
  const recorded = next.project.factoryStarts.length - prev.project.factoryStarts.length;
  if (command === "startFactory" && recorded === 1) return undefined;
  if (command === "resetSampleData" && next.project.sample) return undefined;
  const by = command === "startFactory" ? `the startFactory command recorded ${recorded} starts, not 1` : `${command ? `the ${command} command` : "an internal update"} tried to`;
  return `Refused: only the owner's Start the factory moves the project from Vision to the factory; ${by}. Nothing was written.`;
}

/**
 * The owner-only Lock in, enforced where state is written (ORC-029 pass 5): what is in force (the blueprint's
 * revisions) changes only by the owner's `lockIn` command, which adds exactly one revision, or by `startFactory` (the
 * first Lock in), which adds at most one. No write may change or remove a revision in force. Any other write that
 * would (another command, the scheduler, a runtime report, a lead run's result) is refused before anything is stored.
 * Replacing everything with the sample project (`resetSampleData`) or with a new project (`initProject`) starts a new
 * blueprint, not a Lock in. Returns why a write is refused, or undefined.
 */
function blueprintRefusal(prev: State, next: State, command: string | undefined): string | undefined {
  const before = prev.blueprint.revisions;
  const after = next.blueprint.revisions;
  if (after === before) return undefined;
  if (command === "resetSampleData" && next.project.sample) return undefined;
  if (command === "initProject" && after.length === 0) return undefined;
  const kept = after.length >= before.length && before.every((r, i) => JSON.stringify(r) === JSON.stringify(after[i]));
  const added = after.length - before.length;
  if (kept && added === 0) return undefined;
  if (kept && command === "lockIn" && added === 1) return undefined;
  if (kept && command === "startFactory" && added <= 1) return undefined;
  const what = !kept ? "changed or removed a revision in force" : `${command === "lockIn" || command === "startFactory" ? `made ${added} revisions` : "made a revision"}`;
  return `Refused: only the owner's Lock in puts the blueprint into force; ${command ? `the ${command} command` : "an internal update"} ${what}. Nothing was written.`;
}

export class LeaseLostError extends Error {
  constructor(name: string) {
    super(`Lease ${name} is no longer held by this instance`);
    this.name = "LeaseLostError";
  }
}

export interface CommandResult {
  version: number;
  result?: unknown;
  /** True when this idempotency key was already applied and the stored outcome was returned. */
  replayed: boolean;
}

export class Store {
  readonly path: string;
  private db: DatabaseSync;
  private listeners = new Set<() => void>();

  constructor(path: string, seed: () => State = () => buildSeed(Date.now(), { inFlightRuns: false })) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.ensureState(seed);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        format INTEGER NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        name TEXT NOT NULL,
        args TEXT NOT NULL,
        at TEXT NOT NULL,
        version INTEGER NOT NULL,
        result TEXT,
        error_kind TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, at);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING").run(String(SCHEMA_VERSION));
  }

  private ensureState(seed: () => State) {
    this.tx(() => {
      // Read inside the transaction so two instances starting together cannot both seed.
      const row = this.db.prepare("SELECT format, version, json FROM state WHERE id = 1").get() as { format: number; version: number; json: string } | undefined;
      if (row && row.format === STATE_FORMAT) {
        // A document an early build of format 19 wrote gains the fields it lacks; nothing is written when none is missing.
        const json = JSON.stringify(normalize19(JSON.parse(row.json) as Record<string, unknown>));
        if (json !== row.json) this.db.prepare("UPDATE state SET version = ?, json = ?, updated_at = ? WHERE id = 1").run(row.version + 1, json, new Date().toISOString());
        return;
      }
      if (row && MIGRATIONS[row.format]) {
        // Upgrade in place, one format at a time, keeping a copy of the original.
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`backup_format_${row.format}_v${row.version}`, row.json);
        let format = row.format;
        let doc = JSON.parse(row.json) as Record<string, unknown>;
        while (format < STATE_FORMAT && MIGRATIONS[format]) {
          doc = MIGRATIONS[format](doc);
          format += 1;
        }
        if (format === STATE_FORMAT) {
          this.db.prepare("UPDATE state SET version = ?, format = ?, json = ?, updated_at = ? WHERE id = 1").run(row.version + 1, STATE_FORMAT, JSON.stringify(doc), new Date().toISOString());
          // An event a migration records is mirrored like any other.
          this.mirrorEvents((JSON.parse(row.json) as { events?: State["events"] }).events ?? [], doc as unknown as State);
          return;
        }
      }
      if (row && row.format > STATE_FORMAT) {
        throw new Error(
          `The database at ${this.path} uses state format ${row.format}, which is newer than this version of Orchestrator supports (${STATE_FORMAT}). ` +
            "Update Orchestrator, or set ORCHESTRATION_DB to use a different database.",
        );
      }
      if (row) {
        // Prototype data from an older format: keep a copy, then start from the sample project.
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`backup_format_${row.format}_v${row.version}`, row.json);
      }
      const s = seed();
      this.db
        .prepare("INSERT OR REPLACE INTO state (id, version, format, json, updated_at) VALUES (1, ?, ?, ?, ?)")
        .run((row?.version ?? 0) + 1, STATE_FORMAT, JSON.stringify(s), new Date().toISOString());
      this.mirrorEvents([], s);
    });
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private load(): { version: number; state: State; json: string } {
    const row = this.db.prepare("SELECT version, json FROM state WHERE id = 1").get() as { version: number; json: string };
    return { version: row.version, state: JSON.parse(row.json) as State, json: row.json };
  }

  /**
   * Refuse, and log, a write that would start the factory other than by the owner's command (`stageRefusal`), or
   * change what is in force other than by the owner's Lock in (`blueprintRefusal`).
   */
  private guardStage(prev: State, next: State, command: string | undefined) {
    const refusal = stageRefusal(prev, next, command) ?? blueprintRefusal(prev, next, command);
    if (!refusal) return;
    console.error(`[orchestrator] ${refusal}`);
    throw new ControlError(refusal);
  }

  private persist(prevVersion: number, prev: State, next: State, now: string): number {
    const version = prevVersion + 1;
    const r = this.db.prepare("UPDATE state SET version = ?, json = ?, updated_at = ? WHERE id = 1 AND version = ?").run(version, JSON.stringify(next), now, prevVersion);
    if (r.changes !== 1) throw new Error("State version changed inside a transaction");
    this.mirrorEvents(prev.events, next);
    return version;
  }

  private mirrorEvents(prevEvents: State["events"], next: State) {
    const known = new Set(prevEvents.map((e) => e.id));
    const insert = this.db.prepare("INSERT OR REPLACE INTO events (id, at, actor, kind, task_id, message) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of next.events) if (!known.has(e.id)) insert.run(e.id, e.at, e.actor, e.kind, e.taskId ?? null, e.message);
  }

  read(): { version: number; state: State } {
    const { version, state } = this.load();
    return { version, state };
  }

  /** The command already recorded under an idempotency key, if any (its args as sent), so a retry is not re-validated as a new request. */
  recorded(idempotencyKey: string): { name: string; args: unknown } | undefined {
    const row = this.db.prepare("SELECT name, args FROM commands WHERE idempotency_key = ?").get(idempotencyKey) as { name: string; args: string } | undefined;
    return row ? { name: row.name, args: JSON.parse(row.args) as unknown } : undefined;
  }

  /**
   * Apply a named client command. A repeated idempotency key returns the recorded outcome
   * (success or failure) without applying the command again.
   */
  command(name: string, args: unknown, idempotencyKey: string, now: string): CommandResult {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new CommandFailure("invalid", "idempotencyKey is required");
    let failure: CommandFailure | undefined;
    const out = this.tx((): CommandResult => {
      const prior = this.db.prepare("SELECT name, args, version, result, error_kind, error FROM commands WHERE idempotency_key = ?").get(idempotencyKey) as
        | { name: string; args: string; version: number; result: string | null; error_kind: FailureKind | null; error: string | null }
        | undefined;
      if (prior) {
        if (prior.name !== name || prior.args !== JSON.stringify(args ?? {})) {
          failure = new CommandFailure("invalid", "This idempotency key was already used for a different command.");
          return { version: prior.version, replayed: true };
        }
        if (prior.error_kind) failure = new CommandFailure(prior.error_kind, prior.error ?? "Command failed");
        return { version: prior.version, result: prior.result ? JSON.parse(prior.result) : undefined, replayed: true };
      }
      const cur = this.load();
      const record = this.db.prepare("INSERT INTO commands (idempotency_key, name, args, at, version, result, error_kind, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      let outcome: ReturnType<typeof runCommand>;
      try {
        outcome = runCommand(cur.state, name, args, now);
        this.guardStage(cur.state, outcome.state, name);
      } catch (e) {
        failure = classify(e);
        // Record the rejection so a retry with the same key reports the same outcome.
        record.run(idempotencyKey, name, JSON.stringify(args ?? {}), now, cur.version, null, failure.kind, failure.message);
        return { version: cur.version, replayed: false };
      }
      // Errors from here on are storage failures: they roll the whole transaction back.
      const version = this.persist(cur.version, cur.state, outcome.state, now);
      record.run(idempotencyKey, name, JSON.stringify(args ?? {}), now, version, outcome.result === undefined ? null : JSON.stringify(outcome.result), null, null);
      return { version, result: outcome.result, replayed: false };
    });
    if (failure) throw failure;
    if (!out.replayed) this.emit();
    return out;
  }

  /**
   * Apply an internal operation (scheduler, runtime reports). Writes only when the state changed.
   * With `lease`, the write happens only if that holder still holds the unexpired lease, checked
   * inside the same transaction; otherwise LeaseLostError is thrown and nothing is written.
   */
  update(fn: (s: State) => State, now: string, lease?: { name: string; holder: string; nowMs: number }): { version: number; changed: boolean } {
    const out = this.tx(() => {
      if (lease) {
        const row = this.db.prepare("SELECT holder, expires_at FROM leases WHERE name = ?").get(lease.name) as { holder: string; expires_at: number } | undefined;
        if (!row || row.holder !== lease.holder || row.expires_at <= lease.nowMs) throw new LeaseLostError(lease.name);
      }
      const cur = this.load();
      const next = fn(cur.state);
      this.guardStage(cur.state, next, undefined);
      const json = JSON.stringify(next);
      if (json === cur.json) return { version: cur.version, changed: false };
      return { version: this.persist(cur.version, cur.state, next, now), changed: true };
    });
    if (out.changed) this.emit();
    return out;
  }

  /** Acquire or renew a named lease. Returns true if `holder` holds it after the call. */
  acquireLease(name: string, holder: string, ttlMs: number, nowMs: number): boolean {
    return this.tx(() => {
      const row = this.db.prepare("SELECT holder, expires_at FROM leases WHERE name = ?").get(name) as { holder: string; expires_at: number } | undefined;
      if (row && row.holder !== holder && row.expires_at > nowMs) return false;
      this.db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at").run(name, holder, nowMs + ttlMs);
      return true;
    });
  }

  releaseLease(name: string, holder: string) {
    this.db.prepare("DELETE FROM leases WHERE name = ? AND holder = ?").run(name, holder);
  }

  commandCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number }).n;
  }

  eventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners of a change that is not a state write (for example scheduler role or sim settings). */
  emit() {
    for (const l of this.listeners) l();
  }

  close() {
    this.db.close();
  }
}
