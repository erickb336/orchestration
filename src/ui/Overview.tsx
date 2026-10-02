// Home: the three things you look at daily, then the focus. Needs you first, with the simple decisions taken in
// place; Progress by area beside New results and the lead's latest reply; the Focus card last, with the vision
// text, its revisions and its documents behind "Vision and history". Usage and the service's details live in
// Settings (Diagnostics.tsx); the lead conversation opens from the header.

import { useEffect, useRef, useState } from "react";
import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import { diffLines } from "../domain/diff";
import { useStore } from "./store";
import { ProviderMark, fmtTime, involvementOf, relTime } from "./common";
import { useLeadContext } from "./LeadDrawer";
import { Onboarding } from "./Onboarding";
import { foldSummary, messageStatusText } from "./notes";
import { landedVerdict, latestLeadReply, liveText, needsYouItems, optionsLine, progressByArea, replyExcerpt, type AreaProgress, type NeedsYouEntry } from "./progress";
import { historyRequested } from "./route";
import { OpenDraft, ShapingPanel } from "./Shaping";
import { RevisionDocs, VisionDocsList } from "./VisionDocs";
import { Banner, Button, ButtonLink, Card, Chip, Disclosure, EmptyState, Field, Input, NeedsYouItem, Row, Rows, SimulatedChip, Textarea, useConfirm } from "./kit";
import type { FindingDecision, PrDelivery, SpecOption, State, Task, VisionRevision } from "../domain/types";

/** The one name for each involvement setting, wherever it is shown. */
export const INVOLVEMENT_NAME: Record<ReturnType<typeof involvementOf>, string> = { autopilot: "Autopilot", checkin: "Check-in", manual: "Manual", custom: "Custom" };

/** Who made a vision revision and from what, in a few words (the history list). */
export function revisionSource(v: VisionRevision): string {
  if (v.source?.undoOf) return `${v.author} · undo of the lead's change`;
  if (v.source?.draftId) return `${v.author} · accepted the lead's draft`;
  if (v.source?.docsAdded) return `${v.author} · attached ${v.source.docsAdded.length} document${v.source.docsAdded.length === 1 ? "" : "s"}${v.source.docsRemoved?.length ? " (replacing earlier copies)" : ""}`;
  if (v.source?.docAdded) return `${v.author} · ${v.source.docRemoved ? "replaced a document" : "attached a document"}`;
  if (v.source?.docRemoved) return `${v.author} · removed a document`;
  if (v.source?.changeSetId) return v.author === "lead" ? "lead · from your message" : `${v.author} · applied the lead's suggestion`;
  return v.author;
}

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
  // While shaping, the shaping panel leads and stands in for the Focus card (it holds the vision and its editor).
  const shaping = state.project.stage === "shaping";
  return (
    <div className="k-stack home">
      <h1 className="no-margin">Home</h1>
      <Onboarding />
      {shaping && <ShapingPanel />}
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
      {!shaping && <FocusCard state={state} />}
    </div>
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
 */
function LatestFromLead({ state }: { state: State }) {
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

// ---------- Focus ----------

/** The focus first; where it came from, with Undo for a lead change; the vision text, its revisions, diff and documents behind "Vision and history". */
function FocusCard({ state }: { state: State }) {
  const { send, disabled } = useStore();
  const vision = M.currentVision(state);
  const change = M.currentFocusChange(state);
  const [busy, setBusy] = useState(false);
  // The Focus banner's History link arrives as `#/overview?history=1` and opens the history.
  const [open, setOpen] = useState(() => typeof location !== "undefined" && historyRequested(location.hash));
  return (
    <Card title="Focus">
      <OpenDraft />
      <p className="focus-line">{vision.focus || <span className="muted">No focus set.</span>}</p>
      <div className="focus-foot small muted">
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
        <span aria-hidden="true">·</span>
        <Disclosure label="Vision and history" count={state.project.visions.length} open={open} onToggle={setOpen}>
          <VisionDetails state={state} scrollToHistory={open && typeof location !== "undefined" && historyRequested(location.hash)} />
        </Disclosure>
      </div>
    </Card>
  );
}

/** Inside "Vision and history": the text with its editor, what changed from the previous revision, every revision, and the documents. */
function VisionDetails({ state, scrollToHistory }: { state: State; scrollToHistory: boolean }) {
  const { send, disabled } = useStore();
  const vision = M.currentVision(state);
  const visions = state.project.visions;
  const prev = visions.length > 1 ? visions[visions.length - 2] : undefined;
  const diff = prev ? diffLines([`Focus: ${prev.focus}`, ...prev.text.split("\n")], [`Focus: ${vision.focus}`, ...vision.text.split("\n")]).filter((d) => d.kind !== "same") : [];
  const historyRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (scrollToHistory) historyRef.current?.scrollIntoView({ block: "start" });
  }, [scrollToHistory]);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // The vision revision the draft started from; saving against it lets the service reject a stale draft.
  const [baseRev, setBaseRev] = useState(vision.rev);
  const staleDraft = editing && !saving && vision.rev !== baseRev;
  const [text, setText] = useState(vision.text);
  const [focus, setFocus] = useState(vision.focus);
  const [reason, setReason] = useState("");

  return (
    <div className="k-stack k-stack--tight vision-details">
      {editing ? (
        <form
          className="k-stack k-stack--tight"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            setSaving(true);
            // A 409 keeps the form open with the draft; the notice explains the conflict.
            const r = await send("editVision", { expectedRev: baseRev, text, focus, reason });
            setSaving(false);
            if (r.ok) {
              setEditing(false);
              setReason("");
            }
          }}
        >
          {staleDraft && (
            <Banner
              tone="fail"
              title={`The vision changed to r${vision.rev} while you were editing`}
              actions={
                <>
                  <Button size="small" onClick={() => setBaseRev(vision.rev)}>
                    Save over r{vision.rev} anyway
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setText(vision.text);
                      setFocus(vision.focus);
                      setBaseRev(vision.rev);
                    }}
                  >
                    Discard draft and load r{vision.rev}
                  </Button>
                </>
              }
            >
              {vision.author}: {vision.reason}. Your draft is kept.
            </Banner>
          )}
          <Field label="Vision">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} />
          </Field>
          <Field label="Current focus">
            <Input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
          </Field>
          <Field label="Reason for change (recorded)">
            <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <div className="k-actions">
            <Button type="submit" variant="primary" disabled={disabled || saving || staleDraft} loading={saving}>
              {saving ? "Saving…" : `Save as r${vision.rev + 1}`}
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="vision-text">{vision.text || <span className="muted">No vision written yet.</span>}</p>
          <div className="k-actions">
            <Button
              size="small"
              onClick={() => {
                setText(vision.text);
                setFocus(vision.focus);
                setBaseRev(vision.rev);
                setEditing(true);
              }}
            >
              Edit vision
            </Button>
          </div>
        </>
      )}
      {prev && diff.length > 0 && (
        <Disclosure label={`What changed from r${prev.rev}: ${vision.reason}`}>
          <div className="diff" aria-label={`Differences between r${prev.rev} and r${vision.rev}`}>
            {diff.map((d, i) => (
              <div key={i} className={d.kind}>
                {d.text}
              </div>
            ))}
          </div>
        </Disclosure>
      )}
      <h3 className="no-margin">Revisions</h3>
      <ul className="events" ref={historyRef} id="vision-history" aria-label="Vision history">
        {[...visions].reverse().map((r) => (
          <li key={r.rev}>
            <span className="mono">r{r.rev}</span>
            <span className="actor">{revisionSource(r)}</span>
            <span>
              {r.reason} <span className="muted">· focus: “{r.focus}” · {fmtTime(r.at)}</span> <RevisionDocs state={state} rev={r} />
            </span>
          </li>
        ))}
      </ul>
      <VisionDocsList />
    </div>
  );
}
