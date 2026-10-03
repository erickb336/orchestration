// Shaping the vision with the lead before anything is built: the banner on the board and in the shell, and the parts
// of the vision card at the top of Vision (studio/VisionCard.tsx): the lead's questions, what is clear, and the
// lead's draft of the vision. Every control is a keyed command; a draft never applies by itself.

import { useState, type ReactNode } from "react";
import { diffLines } from "../domain/diff";
import * as M from "../domain/model";
import { SHAPING_AREAS, SHAPING_AREA_LABEL, type LeadQuestion, type State, type VisionDraft } from "../domain/types";
import { relTime } from "./common";
import { Banner, Button, ButtonLink, Chip, Field, Input, Textarea } from "./kit";
import { useLeadContext } from "./LeadDrawer";
import { useStore } from "./store";
import "./vision.css";

const COVERAGE_LABEL = { clear: "clear", partial: "partly clear", open: "open" } as const;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** "4 of 9 clear", or undefined before the lead reported which areas are clear. */
export function coverageCount(s: State): string | undefined {
  const c = M.coverageOf(s);
  return c ? `${SHAPING_AREAS.filter((a) => c[a] === "clear").length} of ${SHAPING_AREAS.length} clear` : undefined;
}

/** The nine areas a vision needs, each with the state the lead last reported. */
export function CoverageChecklist({ state }: { state: State }) {
  const c = M.coverageOf(state);
  return (
    <section aria-label="What is clear so far">
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
export function QuestionsForm({ questions }: { questions: LeadQuestion[] }) {
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
 * In Vision (the "shaping" stage), on the board and in the shell (there is no stage chip): why nothing new starts,
 * without calling anything paused. Nothing once the factory runs.
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
        <ButtonLink size="small" href="#/vision">
          Work on the vision
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
