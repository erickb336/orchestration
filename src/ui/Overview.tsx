// Home. While in Vision: one line of the vision (studio/VisionCard.tsx, VisionLine: the text and its history are in
// Vision), then Needs you, with the simple decisions taken in place, and Progress by area beside New results and the
// lead's latest reply. After the start, Home is the factory floor (floor/FactoryFloor.tsx): the vision's line, Needs
// you, then the budgets, one line per area and the PE's calls; New results and the lead's latest reply under it, the
// focus as that reply's first line (ORC-030 a-home-focus). Usage and the service's details live in Settings
// (Diagnostics.tsx); the lead conversation opens from the header.

import { useState } from "react";
import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import { useStore } from "./store";
import { ProviderMark, involvementOf, relTime } from "./common";
import { FactoryFloor } from "./floor/FactoryFloor";
import { useLeadContext } from "./LeadDrawer";
import { Onboarding } from "./Onboarding";
import { foldSummary, messageStatusText } from "./notes";
import { landedVerdict, latestLeadReply, liveText, needsYouItems, optionsLine, progressByArea, replyExcerpt, type AreaProgress, type NeedsYouEntry } from "./progress";
import { VisionLine } from "./studio/VisionCard";
import { Button, ButtonLink, Card, Chip, EmptyState, Field, Input, NeedsYouItem, Row, Rows, SimulatedChip, StatePill, useConfirm } from "./kit";
import { importQuestions, importStatus, itemAnswerEffect } from "../domain/studio/import";
import { nothingToBuild, readingSteps, roundRequest } from "./import/importView";
import type { FindingDecision, PrDelivery, SpecOption, State, Task, VisionRevision } from "../domain/types";

/** The one name for each involvement setting, wherever it is shown. */
export const INVOLVEMENT_NAME: Record<ReturnType<typeof involvementOf>, string> = { autopilot: "Autopilot", checkin: "Check-in", manual: "Manual", custom: "Custom" };

/** The Focus card's one line about where the focus came from: "Set by the lead from your message", "Set by you", … */
export function focusProvenance(v: VisionRevision): string {
  if (v.source?.undoOf) return "Restored by you (the lead's change undone)";
  if (v.source?.draftId) return "From the lead's draft, accepted by you";
  if (v.source?.changeSetId) return v.author === "lead" ? "Set by the lead from your message" : "Set by you, from the lead's suggestion";
  if (v.author === "user") return "Set by you";
  return `Set by the ${v.author}`;
}

export function Overview() {
  const { state } = useStore();
  // While shaping and after the start, the vision is one line here: its text, focus and editor are in Vision.
  const shaping = state.project.stage === "shaping";
  if (!shaping) return <FactoryHome state={state} />;
  return (
    <div className="k-stack home">
      <h1 className="no-margin">Home</h1>
      <Onboarding />
      <VisionLine />
      <ImportHome />
      <div data-tour="needs-you">
        <NeedsYouCard state={state} />
      </div>
      <div className="k-grid-2">
        <div data-tour="progress">
          <ProgressByArea state={state} />
        </div>
        <div className="k-stack">
          <NewResultsCard state={state} />
          <LatestFromLead state={state} />
        </div>
      </div>
    </div>
  );
}

/**
 * Home after the start: the factory floor (ORC-029 pass 6). Needs you first; then the floor (the change orders the lead
 * is answering, the budgets, one line per area, the PE's calls); then what landed and the lead's latest reply with the
 * focus first. The vision is one line at the top; its text and history are in Vision.
 */
function FactoryHome({ state }: { state: State }) {
  return (
    <div className="k-stack home">
      <h1 className="no-margin">Home</h1>
      <Onboarding />
      <VisionLine />
      <div data-tour="needs-you">
        <NeedsYouCard state={state} />
      </div>
      <div data-tour="progress" className="k-stack">
        <FactoryFloor />
      </div>
      <div className="k-grid-2">
        <NewResultsCard state={state} />
        <LatestFromLead state={state} withFocus />
      </div>
    </div>
  );
}

// ---------- the import (ORC-032) ----------

/**
 * The import on Home: while it reads, its steps; while the review waits, that it needs you; after the baseline, the
 * factory has nothing to build until you change the design ("2 changes to design" when you asked for some, with Ask
 * the lead for a round).
 */
export function ImportHome() {
  const { state, send, disabled } = useStore();
  const [asked, setAsked] = useState(false);
  const status = importStatus(state);
  if (!status) return null;
  const vision = (
    <ButtonLink size="small" href="#/vision" variant={status === "review" ? "primary" : "secondary"}>
      {status === "review" ? "Answer in Vision" : "Open Vision"}
    </ButtonLink>
  );
  if (status === "reading" || status === "stopped") {
    const steps = readingSteps(state);
    const done = steps.filter((s) => s.mark === "done" || s.mark === "skipped");
    return (
      <Card title="The import" actions={<StatePill tone={status === "stopped" ? "fail" : "work"} pulse={status === "reading"}>{status === "stopped" ? "stopped" : "importing"}</StatePill>}>
        <p className="no-margin">{status === "stopped" ? `It stopped: ${state.studio.import!.stopped!.reason}` : `${done.length} of ${steps.length} steps done${done.length ? `: ${done.map((s) => s.name).join(", ")}` : ""}.`}</p>
        <div className="k-actions">{vision}</div>
      </Card>
    );
  }
  if (status === "review") {
    const imp = state.studio.import!;
    const open = importQuestions(imp).asked.filter((q) => itemAnswerEffect(imp, { rule: q.ruleId }) === "open").length;
    return (
      <Card title="The import" actions={<StatePill tone="you">needs you</StatePill>}>
        <p className="no-margin">{open ? `Round 0, As it is today, asks you ${open} question${open === 1 ? "" : "s"}. Answer in Vision, then lock in the baseline.` : "Every question is answered. Lock in the baseline in Vision."}</p>
        <div className="k-actions">{vision}</div>
      </Card>
    );
  }
  if (state.project.stage !== "shaping") return null;
  const n = nothingToBuild(state);
  return (
    <Card
      title="The factory"
      actions={
        <ButtonLink size="small" href="#/tasks">
          All tasks
        </ButtonLink>
      }
    >
      <p className="no-margin">
        <b>{n.bold}</b>
        {n.rest}
      </p>
      <div className="k-actions">
        {vision}
        {n.changes > 0 && (
          <Button
            size="small"
            variant="primary"
            disabled={disabled || asked}
            onClick={async () => {
              if ((await send("postMessage", { text: roundRequest(state) })).ok) setAsked(true);
            }}
          >
            Ask the lead for a round
          </Button>
        )}
        {asked && <span className="small muted">Sent. The lead answers in the conversation.</span>}
      </div>
    </Card>
  );
}

// ---------- Needs you ----------

const taskHref = (t: Task) => `#/task/${encodeURIComponent(t.id)}`;
const titleOf = (t: Task) => M.currentSpec(t).content.title;

/** Everything that waits for you, one row each; the simple decisions are settled here with the task page's own commands. */
function NeedsYouCard({ state }: { state: State }) {
  const items = needsYouItems(state, Date.now());
  const leadDecisions = F.agentDecisions(state);
  return (
    <Card title="Needs you" count={items.length} countTone="you">
      {items.length === 0 ? (
        <EmptyState title="Nothing needs you.">Agents keep working within your settings.</EmptyState>
      ) : (
        <Rows label="Things that need you">
          {items.map((it) => (
            <NeedsYouRow key={it.key} item={it} />
          ))}
        </Rows>
      )}
      {leadDecisions.length > 0 && (
        <p className="muted small needs-foot">
          {F.agentsDecidingLabel(leadDecisions)}. You can take any of them over from the task page.
        </p>
      )}
    </Card>
  );
}

function NeedsYouRow({ item }: { item: NeedsYouEntry }) {
  switch (item.kind) {
    case "merge":
      return <MergeRow task={item.task} pr={item.pr} verdict={item.verdict} simulated={item.simulated} />;
    case "choose":
      return <ChooseRow task={item.task} options={item.options} recommendedId={item.recommendedId} specRev={item.specRev} />;
    case "finding":
      return <FindingRow task={item.task} decision={item.decision} />;
    case "start":
      return <StartRow task={item.task} />;
    case "helpers":
      return <HelpersRow item={item} />;
    default:
      return (
        <NeedsYouItem
          taskId={item.task?.id ?? ""}
          title={item.task ? titleOf(item.task) : item.what}
          href={item.task ? taskHref(item.task) : undefined}
          what={item.task ? `${item.what[0].toUpperCase()}${item.what.slice(1)}:` : "Needs you:"}
          detail={item.detail}
          actions={
            <ButtonLink size="small" href={item.href}>
              {item.action}
            </ButtonLink>
          }
        />
      );
  }
}

/** A pull request ready for you: the verdict line, Merge (confirmed, naming the commit) and Keep for me. The same commands as the task page. */
function MergeRow({ task, pr, verdict, simulated }: { task: Task; pr: PrDelivery; verdict: { label: string; ok: boolean }[]; simulated: boolean }) {
  const { send, disabled } = useStore();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const h12 = pr.headSha.slice(0, 12);
  const run = async (name: "requestPrMerge" | "holdPr", args: object) => {
    setBusy(true);
    await send(name, args);
    setBusy(false);
  };
  return (
    <NeedsYouItem
      taskId={task.id}
      title={titleOf(task)}
      href={taskHref(task)}
      what="Ready to merge:"
      detail={
        <>
          {verdict.map((v) => (
            <Chip key={v.label} tone={v.ok ? "done" : "you"}>
              {v.label} {v.ok ? "✓" : "…"}
            </Chip>
          ))}
        </>
      }
      simulated={simulated}
      actions={
        <>
          <Button
            size="small"
            variant="primary"
            disabled={disabled || busy}
            title={`Merges exactly ${h12}, and only once GitHub's required checks and rules pass for it`}
            onClick={async () => {
              const ok = await confirm({ title: `Merge PR #${pr.number} into ${pr.base}?`, text: `Merges exactly ${h12}, and only once GitHub's required checks and rules pass for that commit.`, primaryLabel: "Merge" });
              if (ok) await run("requestPrMerge", { taskId: task.id, headSha: pr.headSha });
            }}
          >
            Merge
          </Button>
          <Button size="small" disabled={disabled || busy} title="Nothing is pushed, merged or commented on this pull request until you let it continue" onClick={() => void run("holdPr", { taskId: task.id })}>
            Keep for me
          </Button>
        </>
      }
    />
  );
}

/**
 * A held task with exactly two approaches. Choosing the selected one is your go-ahead (the task starts with it);
 * choosing the other selects it first: the lead's recommendation needs no reason, an override asks for one, as on
 * the task page. The row then asks for your go-ahead.
 */
function ChooseRow({ task, options, recommendedId, specRev }: { task: Task; options: SpecOption[]; recommendedId: string; specRev: number }) {
  const { send, disabled } = useStore();
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedId = M.currentSpec(task).content.selectedOptionId;
  const choose = async (id: string, why: string) => {
    setBusy(true);
    const content = M.currentSpec(task).content;
    const r =
      id === selectedId
        ? await send("startHeldTask", { taskId: task.id })
        : id === recommendedId
          ? await send("editSpec", { taskId: task.id, expectedRev: specRev, content: { ...structuredClone(content), selectedOptionId: id }, reason: `User restored recommended option ${id}` })
          : await send("overrideSelection", { taskId: task.id, expectedRev: specRev, optionId: id, reason: why });
    setBusy(false);
    if (r.ok) {
      setChoosing(null);
      setReason("");
    }
  };
  return (
    <NeedsYouItem
      taskId={task.id}
      title={titleOf(task)}
      href={taskHref(task)}
      what="Choose an approach:"
      detail={optionsLine(options)}
      actions={
        <>
          {options.map((o) => (
            <Button
              key={o.id}
              size="small"
              variant={o.id === selectedId ? "primary" : "secondary"}
              disabled={disabled || busy}
              aria-pressed={choosing === o.id ? true : undefined}
              title={o.id === selectedId ? `Start with ${o.id}, ${o.name}${o.id === recommendedId ? " (the lead's recommendation)" : ""}` : o.id === recommendedId ? `Select ${o.id}, the lead's recommendation; the task then waits for your go-ahead` : `Select ${o.id} over the lead's recommendation; it asks why first`}
              onClick={() => {
                if (o.id === selectedId || o.id === recommendedId) void choose(o.id, "");
                else setChoosing(o.id);
              }}
            >
              Choose {o.id}
            </Button>
          ))}
        </>
      }
    >
      {choosing && (
        <form
          className="needs-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void choose(choosing, reason.trim());
          }}
        >
          <Field label={`Why ${choosing} over the lead's recommendation? (kept in the decision record)`} width="medium">
            <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
          </Field>
          <div className="k-actions">
            <Button type="submit" size="small" variant="primary" disabled={disabled || busy || !reason.trim()}>
              Select {choosing}
            </Button>
            <Button size="small" variant="quiet" onClick={() => setChoosing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </NeedsYouItem>
  );
}

/** A finding routed to you: Fix, Accept as is, or ask the lead about it. The same commands as the task page's decision controls. */
function FindingRow({ task, decision: d }: { task: Task; decision: FindingDecision }) {
  const { send, disabled } = useStore();
  const lead = useLeadContext();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "fix" | "accept") => {
    setBusy(true);
    await send("decideFinding", { decisionId: d.id, decision, ...(decision === "fix" && d.suggestion ? { note: d.suggestion.why } : {}) });
    setBusy(false);
  };
  return (
    <NeedsYouItem
      taskId={task.id}
      title={titleOf(task)}
      href={taskHref(task)}
      what="Decide a finding:"
      detail={
        <>
          {d.finding.title}
          {d.suggestion && <span className="muted"> · the lead suggests: fix — {d.suggestion.why}</span>}
        </>
      }
      actions={
        <>
          <Button size="small" variant={d.suggestion ? "primary" : "secondary"} disabled={disabled || busy} title="The next repair fixes it" onClick={() => void decide("fix")}>
            Fix
          </Button>
          <Button size="small" disabled={disabled || busy} title="Leave it as it is; later repairs and reviews treat it as settled" onClick={() => void decide("accept")}>
            Accept as is
          </Button>
          <Button size="small" variant="quiet" onClick={() => lead.openLead({ taskId: task.id })} title="Your message carries this task as context">
            Message the lead
          </Button>
        </>
      }
    />
  );
}

/** A task that waits for your go-ahead: Start, as on the task page. */
function StartRow({ task }: { task: Task }) {
  const { send, disabled } = useStore();
  return (
    <NeedsYouItem
      taskId={task.id}
      title={titleOf(task)}
      href={taskHref(task)}
      what="Give the go-ahead:"
      detail="it starts as soon as an agent is free"
      actions={
        <Button size="small" variant="primary" disabled={disabled} onClick={() => void send("startHeldTask", { taskId: task.id })}>
          Start
        </Button>
      }
    />
  );
}

/** Helper agents that started where none is allowed (ORC-031): Open the run, or Mark as seen here. */
function HelpersRow({ item }: { item: Extract<NeedsYouEntry, { kind: "helpers" }> }) {
  const { send, disabled } = useStore();
  return (
    <NeedsYouItem
      taskId={item.task?.id ?? ""}
      title={item.task ? titleOf(item.task) : item.what}
      href={item.task ? taskHref(item.task) : undefined}
      what={item.task ? `${item.what}:` : "Needs you:"}
      detail={item.detail}
      actions={
        <>
          <ButtonLink size="small" href={item.href}>
            {item.action}
          </ButtonLink>
          <Button size="small" disabled={disabled} title="It leaves Needs you; the record stays on the run" onClick={() => void send("markSubagentsSeen", { runId: item.runId })}>
            Mark as seen
          </Button>
        </>
      }
    />
  );
}

// ---------- Progress by area ----------

/**
 * One row per area. Name and "done of total"; a bar with one segment per task (done, agents working, needs you,
 * the rest); the live line. Each row is a button that opens the board filtered to the area.
 */
function ProgressByArea({ state }: { state: State }) {
  const rows = progressByArea(state);
  return (
    <Card title="Progress by area">
      {rows.length === 0 ? (
        <EmptyState title="No tasks yet.">Areas appear here as tasks are created.</EmptyState>
      ) : (
        <ul className="areas">
          {rows.map((r) => (
            <li key={r.area}>
              <AreaRow row={r} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AreaRow({ row: r }: { row: AreaProgress }) {
  const open = () => (location.hash = `#/tasks?area=${encodeURIComponent(r.area)}`);
  const widths = { done: r.buckets.done, work: r.buckets.work, you: r.buckets.you, rest: r.buckets.rest };
  const shown = r.live.slice(0, 2);
  const more = r.live.length - shown.length;
  return (
    <button type="button" className="area-row" onClick={open} title={`Open the board filtered to ${r.area}`}>
      <span>
        <span className="area-name">{r.area}</span>
        <span className="area-count">
          {r.done} of {r.total} done
        </span>
      </span>
      <span className="area-bar" role="img" aria-label={r.label}>
        {(["done", "work", "you", "rest"] as const).map((b) => (widths[b] > 0 ? <span key={b} className={b} style={{ width: `${(widths[b] / r.total) * 100}%` }} /> : null))}
      </span>
      <span className="area-live">
        {shown.length === 0 && <span>Idle</span>}
        {shown.map((a, i) => (
          <span key={`${a.taskId}-${a.stepId}-${i}`} className="agent">
            <ProviderMark provider={a.provider} />
            <span className="verb">{liveText(a)}</span> <i title={a.title}>{a.title}</i>
          </span>
        ))}
        {more > 0 && <span>+{more} more</span>}
        {r.needsYou > 0 && (
          <span className="needs">
            {r.needsYou} need{r.needsYou === 1 ? "s" : ""} you
          </span>
        )}
      </span>
    </button>
  );
}

// ---------- New results ----------

/** Work that landed and you have not marked as seen: the newest four, with what each passed. Mark as seen and Send back live under Results. */
function NewResultsCard({ state }: { state: State }) {
  const landed = D.landedTasks(state);
  const fresh = landed.filter((t) => t.integration!.landed!.status === "unreviewed");
  const shown = fresh.slice(0, 4);
  return (
    <Card title="New results" count={fresh.length} actions={<ButtonLink size="small" href="#/results">All results</ButtonLink>}>
      {fresh.length === 0 ? (
        <EmptyState title="No new results.">{landed.length ? "You have seen everything that landed." : "Finished work appears here once it lands."}</EmptyState>
      ) : (
        <Rows label="New results">
          {shown.map((t) => {
            const l = t.integration!.landed!;
            const passed = landedVerdict(l);
            return (
              <Row
                as="li"
                key={t.id}
                id={t.id}
                title={titleOf(t)}
                href={taskHref(t)}
                meta={
                  <>
                    <span>Landed {relTime(l.at)}</span>
                    {passed.length > 0 && <span>· {passed.join(" ")}</span>}
                    {l.flags.length > 0 && (
                      <Chip tone="fail" title="Marked under Results">
                        {l.flags.length} flag{l.flags.length === 1 ? "" : "s"}
                      </Chip>
                    )}
                    {l.simulated && <SimulatedChip title="Simulated merge: nothing was sent to GitHub." />}
                  </>
                }
                actions={
                  <ButtonLink size="small" href="#/results">
                    Open
                  </ButtonLink>
                }
              />
            );
          })}
          {fresh.length > shown.length && (
            <li className="small muted k-row">
              {fresh.length - shown.length} more under Results.
            </li>
          )}
        </Rows>
      )}
    </Card>
  );
}

// ---------- Latest from the lead ----------

/**
 * The lead's newest reply, its first lines and what it changed, in the conversation's words: the fold line under a
 * reply ("2 changes, 1 note") and where your newest message stands. The conversation itself opens from the header.
 * After the start the focus is its first line (`withFocus`); before it, the focus is with the vision, in Vision.
 */
function LatestFromLead({ state, withFocus = false }: { state: State; withFocus?: boolean }) {
  const { service } = useStore();
  const lead = useLeadContext();
  const latest = latestLeadReply(state);
  const pending = M.pendingMessages(state);
  const waiting = pending.length ? M.messageStatus(state, pending[pending.length - 1], { blocked: service.leadBlocked, nowMs: Date.now() }) : undefined;
  return (
    <Card
      title="Latest from the lead"
      actions={
        <Button size="small" onClick={() => lead.openLead()}>
          Open the conversation
        </Button>
      }
    >
      {withFocus && <FocusLine state={state} />}
      {!latest ? (
        <EmptyState title="No reply from the lead yet.">Message the lead; it answers in its next run.</EmptyState>
      ) : (
        <>
          <p className="lead-excerpt">{replyExcerpt(latest.message.text)}</p>
          <p className="small muted lead-meta">
            <span>
              {relTime(latest.message.at)} · {latest.set ? foldSummary(latest.set) : "No changes"}
            </span>
            {service.runtime === "fake" && <SimulatedChip title="Simulated reply: written by the demo's lead, not by a model." />}
          </p>
        </>
      )}
      {waiting && waiting.kind !== "answered" && (
        <p className="small muted no-margin" role="status">
          {pending.length > 1 ? `${pending.length} messages waiting: ` : ""}
          {messageStatusText(state, waiting)}
        </p>
      )}
    </Card>
  );
}

// ---------- the focus, first in Latest from the lead ----------

/**
 * The focus as the first line of "Latest from the lead" (ORC-030 a-home-focus): the lead sets it, so it sits with the
 * lead's reply. Who set it and when, and Undo for the lead's change. Nothing when no focus is set.
 */
function FocusLine({ state }: { state: State }) {
  const { send, disabled } = useStore();
  const vision = M.currentVision(state);
  const change = M.currentFocusChange(state);
  const [busy, setBusy] = useState(false);
  if (!vision.focus) return null;
  return (
    <div className="lead-focus">
      <p className="lead-focus__line">
        <span className="muted">Focus:</span> {vision.focus}
      </p>
      <p className="focus-foot small muted">
        <span>
          {focusProvenance(vision)}, {relTime(vision.at)}
        </span>
        {change && (
          <>
            <span aria-hidden="true">·</span>
            <Button
              size="small"
              variant="quiet"
              disabled={disabled || busy}
              title="Put the focus back as it was before the lead's change"
              onClick={async () => {
                setBusy(true);
                await send("undoSteering", { changeSetId: change.set.id, changeId: change.change.id });
                setBusy(false);
              }}
            >
              Undo
            </Button>
          </>
        )}
      </p>
    </div>
  );
}
