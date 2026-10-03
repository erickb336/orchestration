// Shaping the vision with the lead before anything is built: the banner on the board and in the shell, the
// "Shape the vision" panel on Home (the vision so far, its documents, the lead's questions, what is clear, the
// lead's draft, the planned tasks and Start building), and the Start building button Settings › Project reuses.
// Every control is a keyed command; a draft never applies by itself.

import { useState, type ReactNode } from "react";
import { diffLines } from "../domain/diff";
import * as M from "../domain/model";
import { openBlueprintItems } from "../domain/studio/blueprint";
import { unfinishedProbes } from "../domain/studio/studio";
import { SHAPING_AREAS, SHAPING_AREA_LABEL, type LeadQuestion, type State, type VisionDraft } from "../domain/types";
import { fmtTime, relTime } from "./common";
import { Banner, Button, ButtonLink, Card, Chip, Field, Input, Row, Rows, SimulatedChip, Textarea, useConfirm, type ButtonVariant } from "./kit";
import { useLeadContext } from "./LeadDrawer";
import { factorySettingsText } from "./settingsText";
import { useStore } from "./store";
import { VisionDocsList } from "./VisionDocs";
import "./vision.css";

const COVERAGE_LABEL = { clear: "clear", partial: "partly clear", open: "open" } as const;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The nine areas a vision needs, each with the state the lead last reported. */
function CoverageChecklist({ state }: { state: State }) {
  const c = M.coverageOf(state);
  return (
    <section>
      <h3>What is clear so far</h3>
      {!c && <p className="small muted">The lead reports this after its first reply.</p>}
      <ul className="checklist v-coverage" aria-label="Coverage of the vision's areas">
        {SHAPING_AREAS.map((a) => {
          const st = c ? c[a] : "open";
          return (
            <li key={a} className={st === "clear" ? "done" : undefined}>
              <span className="check" aria-hidden="true">
                {st === "clear" ? "✓" : st === "partial" ? "◐" : ""}
              </span>
              <span>
                <span className="label">{SHAPING_AREA_LABEL[a]}</span>
                <span className="sr-only">: {COVERAGE_LABEL[st]}</span>
              </span>
              <span className="small muted" aria-hidden="true">
                {COVERAGE_LABEL[st]}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The lead's latest questions, answerable in place: a suggested answer fills the box; Send answers posts one message. */
function QuestionsForm({ questions }: { questions: LeadQuestion[] }) {
  const { send, disabled } = useStore();
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [sending, setSending] = useState(false);
  const text = M.answersMessage(questions, answers);
  const answered = answers.filter((a) => a.trim()).length;
  const set = (i: number, v: string) => setAnswers((xs) => xs.map((x, j) => (j === i ? v : x)));
  return (
    <form
      className="v-questions"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text || sending) return;
        setSending(true);
        const r = await send("postMessage", { text });
        setSending(false);
        if (r.ok) setAnswers(questions.map(() => ""));
      }}
    >
      <h3>The lead asks</h3>
      <ol>
        {questions.map((q, i) => (
          <li key={i}>
            <p className="v-questions__q">
              {q.question} {q.area && <Chip>{SHAPING_AREA_LABEL[q.area]}</Chip>}
            </p>
            {q.why && <p className="small muted">Why: {q.why}</p>}
            {q.options && (
              <div className="k-actions v-questions__options" role="group" aria-label={`Suggested answers to question ${i + 1}`}>
                {q.options.map((o) => (
                  <Button key={o} size="small" disabled={disabled} aria-pressed={answers[i] === o} onClick={() => set(i, o)}>
                    {o}
                  </Button>
                ))}
              </div>
            )}
            <Field label={`Your answer to question ${i + 1}`} labelHidden>
              <Input type="text" value={answers[i]} onChange={(e) => set(i, e.target.value)} placeholder="Your answer (leave empty to skip)" />
            </Field>
          </li>
        ))}
      </ol>
      <div className="k-actions">
        <Button type="submit" variant="primary" disabled={disabled || !text} loading={sending}>
          {sending ? "Sending…" : answered ? `Send ${answered} ${plural(answered, "answer")}` : "Send answers"}
        </Button>
        <span className="small muted">Sent as one message to the lead; unanswered questions are skipped.</span>
      </div>
    </form>
  );
}

/**
 * While shaping, on the board and in the shell (there is no stage chip): why nothing new starts, without calling
 * anything paused. Nothing while building.
 */
export function ShapingBanner() {
  const { state } = useStore();
  if (state.project.stage !== "shaping") return null;
  const running = M.activeAttempts(state).length;
  return (
    <Banner
      tone="info"
      title={`${M.SHAPING_LABEL}.`}
      actions={
        <ButtonLink size="small" href="#/overview">
          Shape the vision
        </ButtonLink>
      }
    >
      {running ? `${running} running ${plural(running, "step")} ${plural(running, "finishes", "finish")} normally; planned` : "Planned"} tasks are held.
    </Banner>
  );
}

/**
 * The draft to show: the open one, or, while its editor is open, the draft the user started editing, even after a
 * newer draft replaced it or it was accepted or dismissed elsewhere, so edits are never dropped silently. Keyed on
 * the draft. Always mounted by its parent: it renders `fallback` when there is nothing to show, so an editing
 * session survives the draft going away.
 */
export function OpenDraft({ fallback = null }: { fallback?: ReactNode }) {
  const { state } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const open = M.openVisionDraft(state);
  const draft = (editingId ? state.visionDrafts.find((d) => d.id === editingId) : undefined) ?? open;
  if (!draft) return <>{fallback}</>;
  return <VisionDraftCard key={draft.id} state={state} draft={draft} onEditing={setEditingId} />;
}

/** Open the conversation and bring one message into view once the drawer has drawn it. */
function showMessage(openLead: () => void, messageId: string) {
  openLead();
  let tries = 20;
  const look = () => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) el.scrollIntoView({ block: "center" });
    else if (--tries > 0) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/**
 * A draft next to the current vision: the diff, and Accept, Edit and accept, and Dismiss. Every accept is
 * compare-and-set on the vision revision the user saw when they started, so a vision that moved meanwhile is never
 * overwritten unseen: the editor keeps its base revision and draft id, and says so when the vision moved or the
 * draft was replaced.
 */
function VisionDraftCard({ state, draft, onEditing }: { state: State; draft: VisionDraft; onEditing?: (draftId: string | null) => void }) {
  const { send, disabled } = useStore();
  const lead = useLeadContext();
  const [busy, setBusy] = useState(false);
  /** The editing session: the vision revision and draft it started from. */
  const [editing, setEditing] = useState<{ draftId: string; baseRev: number } | null>(null);
  const [text, setText] = useState(draft.text);
  const [focus, setFocus] = useState(draft.focus);
  const vision = M.currentVision(state);
  const diff = diffLines([`Focus: ${vision.focus}`, ...vision.text.split("\n")], [`Focus: ${draft.focus}`, ...draft.text.split("\n")]);
  const changed = diff.filter((d) => d.kind !== "same").length;
  const moved = draft.basedOnVisionRev !== vision.rev;
  const gone = draft.status !== "open";
  const stale = !!editing && editing.baseRev !== vision.rev;
  const stopEditing = () => {
    setEditing(null);
    onEditing?.(null);
  };
  const run = async (name: "acceptVisionDraft" | "dismissVisionDraft" | "editVision", args: object) => {
    setBusy(true);
    const r = await send(name, args);
    setBusy(false);
    if (r.ok) stopEditing();
  };
  const off = disabled || busy;
  const goneWhy = draft.status === "superseded" ? "A newer draft from the lead replaced this one" : draft.status === "accepted" ? `This draft was accepted meanwhile (as r${draft.visionRev})` : draft.status === "dismissed" ? "This draft was dismissed meanwhile" : "";
  const messages = draft.messageIds.length;
  return (
    <section className="v-draft" aria-label={`Vision draft ${draft.id}`}>
      <div className="v-draft__head">
        <strong>The lead drafted a vision</strong>
        <span className="small muted">
          {relTime(draft.at)} · from your {messages === 1 ? "message" : `${messages} messages`}
          {messages > 0 && (
            <>
              {" · "}
              <Button size="small" variant="quiet" onClick={() => showMessage(() => lead.openLead(), draft.messageIds[0])}>
                Show in the conversation
              </Button>
            </>
          )}
        </span>
      </div>
      <p className="small muted">
        “{draft.reason}” — It is a suggestion: the vision changes only if you accept it.
        {moved ? ` The vision moved to r${vision.rev} since the lead drafted this (it saw r${draft.basedOnVisionRev}); the comparison below is against r${vision.rev}.` : ""}
      </p>
      {editing ? (
        <form
          className="k-stack k-stack--tight"
          onSubmit={(e) => {
            e.preventDefault();
            if (gone || stale) return;
            void run("acceptVisionDraft", { draftId: editing.draftId, expectedRev: editing.baseRev, text, focus });
          }}
        >
          {gone && (
            <Banner
              tone="fail"
              title={`${goneWhy} while you were editing, so it can no longer be accepted.`}
              actions={
                <>
                  <Button size="small" disabled={off || !text.trim()} onClick={() => void run("editVision", { expectedRev: vision.rev, text, focus, reason: `Edited the lead's draft ${draft.id} after it was ${draft.status}` })}>
                    Save as r{vision.rev + 1} by hand
                  </Button>
                  <Button size="small" variant="quiet" disabled={busy} onClick={stopEditing}>
                    Discard
                  </Button>
                </>
              }
            >
              Your text is kept: save it as your own revision, or discard it.
            </Banner>
          )}
          {!gone && stale && (
            <Banner
              tone="fail"
              title={`The vision changed to r${vision.rev} while you were editing`}
              actions={
                <Button size="small" onClick={() => setEditing({ ...editing, baseRev: vision.rev })}>
                  Accept over r{vision.rev} anyway
                </Button>
              }
            >
              {vision.author}: {vision.reason}. Your text is kept.
            </Banner>
          )}
          <Field label="Vision">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} required rows={8} />
          </Field>
          <Field label="Current focus">
            <Input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
          </Field>
          <div className="k-actions">
            <Button type="submit" variant="primary" disabled={off || !text.trim() || gone || stale}>
              Accept as r{editing.baseRev + 1}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={stopEditing}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="diff" aria-label={`Differences between the vision r${vision.rev} and the draft`}>
            {diff.map((d, i) => (
              <div key={i} className={d.kind}>
                {d.text}
              </div>
            ))}
          </div>
          <div className="k-actions v-draft__actions">
            <Button variant="primary" disabled={off || changed === 0} onClick={() => void run("acceptVisionDraft", { draftId: draft.id, expectedRev: vision.rev })}>
              Accept as r{vision.rev + 1}
            </Button>
            <Button
              disabled={off}
              onClick={() => {
                setText(draft.text);
                setFocus(draft.focus);
                setEditing({ draftId: draft.id, baseRev: vision.rev });
                onEditing?.(draft.id);
              }}
            >
              Edit and accept
            </Button>
            <Button variant="quiet" disabled={off} onClick={() => void run("dismissVisionDraft", { draftId: draft.id })}>
              Dismiss
            </Button>
            {changed === 0 && <span className="small muted">Nothing differs from the current vision.</span>}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Start building, or why it cannot start yet. Open areas are named and confirmed, never a block: only an empty
 * vision blocks. The outcome it names is what Start building does with the involvement setting as it is now,
 * counting only the tasks under the roadmap's own hold (a task you set to wait keeps waiting either way).
 */
export function StartBuildingButton({ variant = "primary" }: { variant?: ButtonVariant }) {
  const { state, send, disabled } = useStore();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const why = M.startFactoryBlocker(state);
  const plan = M.startFactoryPlan(state);
  const roadmap = plan.roadmap.length;
  const held = plan.userHeld.length;
  const open = M.openAreas(state);
  const openItems = openBlueprintItems(state);
  const probes = unfinishedProbes(state);
  // With no coverage reported, every area is still open, and the confirmation says so.
  const stillOpen = [
    !M.coverageOf(state) ? "The lead has not reported which areas are clear yet, so all nine count as open." : open.length ? `Still open: ${open.map((x) => SHAPING_AREA_LABEL[x].toLowerCase()).join(", ")}.` : "",
    openItems.length ? `Open in the blueprint: ${openItems.map((o) => `${o.item.title} (${o.why})`).join("; ")}.` : "",
    probes.length ? `Probes without their evidence yet: ${probes.map((p) => `${p.question} (${p.status})`).join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const outcome = [
    roadmap ? (plan.release ? `With your involvement set to Autopilot now, the ${roadmap} planned ${plural(roadmap, "task starts", "tasks start")} right away.` : `With your involvement setting as it is now, the ${roadmap} planned ${plural(roadmap, "task waits", "tasks wait")} for your go-ahead.`) : "",
    held ? `${held} planned ${plural(held, "task")} you set to wait ${plural(held, "keeps", "keep")} waiting for your go-ahead.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The settings the start sends and records, delivery and who merges included: what the owner agrees to.
  const runs = factorySettingsText(M.currentFactorySettings(state));
  const explanation = [stillOpen, outcome, runs].filter(Boolean).join(" ");
  return (
    <div className="v-start">
      <Button
        variant={variant}
        disabled={disabled || !!why}
        disabledReason={why}
        showReason
        loading={busy}
        onClick={async () => {
          // Your agreement on what you see now: these vision and blueprint revisions, the settings as they stand, and
          // the open items the confirmation lists. A stand-in for the pre-flight screen (ORC-029 pass 6).
          const request = M.startFactoryRequest(state);
          if (request.acceptOpen.length) {
            const ok = await confirm({
              title: "Start building with areas still open?",
              text: `${stillOpen}${outcome ? `\n\n${outcome}` : ""}\n\n${runs} Change these in Settings before you start.\n\nThe lead keeps answering you, and Vision stays open while the factory runs.`,
              primaryLabel: "Start building",
            });
            if (!ok) return;
          }
          setBusy(true);
          await send("startFactory", request);
          setBusy(false);
        }}
      >
        Start building
      </Button>
      {!why && explanation && <p className="small muted">{explanation}</p>}
    </div>
  );
}

/** Writing the vision by hand while shaping: the same command as the Focus card's editor, compare-and-set on the revision. */
function HandEdit() {
  const { state, send, disabled } = useStore();
  const vision = M.currentVision(state);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baseRev, setBaseRev] = useState(vision.rev);
  const [text, setText] = useState(vision.text);
  const [focus, setFocus] = useState(vision.focus);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <div className="k-actions">
        <Button
          size="small"
          disabled={disabled}
          onClick={() => {
            setText(vision.text);
            setFocus(vision.focus);
            setBaseRev(vision.rev);
            setOpen(true);
          }}
        >
          {vision.text.trim() ? "Edit the vision by hand" : "Write the vision by hand"}
        </Button>
      </div>
    );
  }
  const stale = vision.rev !== baseRev;
  return (
    <form
      className="k-stack k-stack--tight"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        const r = await send("editVision", { expectedRev: baseRev, text, focus, reason: reason.trim() || "Written by hand while shaping" });
        setSaving(false);
        if (r.ok) {
          setOpen(false);
          setReason("");
        }
      }}
    >
      {stale && (
        <Banner
          tone="fail"
          title={`The vision changed to r${vision.rev} while you were writing`}
          actions={
            <Button size="small" onClick={() => setBaseRev(vision.rev)}>
              Save over r{vision.rev} anyway
            </Button>
          }
        >
          Your draft is kept.
        </Banner>
      )}
      <Field label="Vision">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} required rows={6} />
      </Field>
      <Field label="Current focus">
        <Input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
      </Field>
      <Field label="Reason for change (recorded)">
        <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="k-actions">
        <Button type="submit" variant="primary" disabled={disabled || stale || !text.trim()} loading={saving}>
          {saving ? "Saving…" : `Save as r${vision.rev + 1}`}
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const DRAFT_FATE: Record<VisionDraft["status"], string> = { open: "is open", accepted: "was accepted", dismissed: "was dismissed", superseded: "was replaced" };

/** Home's shaping panel: what shaping means, the vision so far, the documents, the lead's questions, what is clear, the latest draft, the planned tasks, and Start building. */
export function ShapingPanel() {
  const { state, service } = useStore();
  const lead = useLeadContext();
  const vision = M.currentVision(state);
  const roadmap = M.roadmapTasks(state);
  const plan = M.startFactoryPlan(state);
  const running = M.activeAttempts(state).length;
  const last = state.visionDrafts.length ? state.visionDrafts[state.visionDrafts.length - 1] : undefined;
  const asked = M.latestQuestions(state);
  const simulated = service.runtime !== "real";
  // The draft card stays mounted while its editor is open; this is what shows otherwise.
  const noDraft = (
    <p className="small muted">
      {last
        ? `The latest draft ${DRAFT_FATE[last.status]}${last.status === "accepted" ? ` as r${last.visionRev}` : ""}, ${fmtTime(last.resolvedAt ?? last.at)}. Ask the lead for another when you are ready.`
        : "No draft yet. The lead drafts one when the conversation gives it enough."}
    </p>
  );
  return (
    <Card
      id="shape"
      title="Shape the vision"
      className="v-shape"
      actions={
        <>
          {simulated && <SimulatedChip title="Simulated: the demo's lead builds its questions, the coverage and the draft from your message; no model writes them." />}
          <Button size="small" onClick={() => lead.openLead()}>
            Message the lead
          </Button>
        </>
      }
    >
      <div className="k-stack">
        <p className="v-shape__intro">
          Talk the goal through with the lead. It asks a few targeted questions at a time, suggests what you may not have considered, and keeps a living draft of the vision with its assumptions marked; you accept, edit or
          dismiss each draft. It may also plan a first roadmap. {M.SHAPING_LABEL}.
          {running ? ` ${running} running ${plural(running, "step")} ${plural(running, "finishes", "finish")} normally.` : ""}
        </p>

        <section className="k-stack k-stack--tight">
          <h3>Vision so far</h3>
          {vision.text.trim() ? (
            <>
              <p className="vision-text">{vision.text}</p>
              <p className="small">
                <span className="muted">Current focus:</span> {vision.focus || <span className="muted">none</span>}
              </p>
            </>
          ) : (
            <p className="muted">Not written yet. Tell the lead what you want to build, or write it yourself.</p>
          )}
          <HandEdit />
        </section>

        <VisionDocsList />

        {asked && <QuestionsForm key={asked.message.id} questions={asked.questions} />}

        <CoverageChecklist state={state} />

        <OpenDraft fallback={noDraft} />

        <section>
          <h3>Planned tasks ({roadmap.length})</h3>
          {roadmap.length === 0 ? (
            <p className="small muted">None yet. Tasks the lead proposes while shaping wait here until you start building.</p>
          ) : (
            <Rows label="Planned tasks">
              {roadmap.map((t) => (
                <Row
                  as="li"
                  key={t.id}
                  id={t.id}
                  title={M.currentSpec(t).content.title}
                  href={`#/task/${encodeURIComponent(t.id)}`}
                  meta={
                    <>
                      <Chip>P{t.priority}</Chip>
                      <span>{t.heldForShaping ? `Waits until building, then ${plan.release ? "starts on Autopilot" : "waits for your go-ahead"}` : t.holdBeforeStart ? "Waits for your go-ahead" : "Starts when building starts"}</span>
                    </>
                  }
                />
              ))}
            </Rows>
          )}
        </section>

        <StartBuildingButton />
      </div>
    </Card>
  );
}
