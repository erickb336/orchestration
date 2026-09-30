// ORC-012: shaping the vision with the lead first. The stage chip, the Board banner, the vision draft
// (a suggestion with Accept, Edit and accept, and Dismiss), the Overview's "Shape the vision" panel,
// and the stage control in Settings. Every control is a keyed command; a draft never applies by itself.

import { useState } from "react";
import { diffLines } from "../domain/diff";
import * as M from "../domain/model";
import { SHAPING_AREAS, SHAPING_AREA_LABEL, type LeadQuestion, type State, type VisionDraft } from "../domain/types";
import { useStore } from "./store";
import { fmtTime, relTime } from "./common";
import { VisionDocsList } from "./VisionDocs";

const COVERAGE_LABEL = { clear: "clear", partial: "partly clear", open: "open" } as const;

/** The nine areas a vision needs, each with the state the lead last reported. */
function CoverageChecklist({ state }: { state: State }) {
  const c = M.coverageOf(state);
  return (
    <>
      <h3>What is clear so far</h3>
      {!c && <p className="muted" style={{ fontSize: "0.85rem" }}>The lead reports this after its first reply.</p>}
      <ul className="checklist" aria-label="Coverage of the vision's areas" style={{ marginTop: "0.2rem" }}>
        {SHAPING_AREAS.map((a) => {
          const st = c ? c[a] : "open";
          return (
            <li key={a} className={st === "clear" ? "done" : undefined} style={{ padding: "0.25rem 0" }}>
              <span className="check" aria-hidden="true">
                {st === "clear" ? "✓" : st === "partial" ? "◐" : ""}
              </span>
              <span>
                <span className="label">{SHAPING_AREA_LABEL[a]}</span>
                <span className="sr-only">: {COVERAGE_LABEL[st]}</span>
              </span>
              <span className="muted" style={{ fontSize: "0.82rem" }} aria-hidden="true">
                {COVERAGE_LABEL[st]}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The lead's latest questions, answerable inline: option chips fill the box; Send answers posts one message. */
function QuestionsForm({ questions }: { questions: LeadQuestion[] }) {
  const { send, disabled } = useStore();
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [sending, setSending] = useState(false);
  const text = M.answersMessage(questions, answers);
  const answered = answers.filter((a) => a.trim()).length;
  const set = (i: number, v: string) => setAnswers((xs) => xs.map((x, j) => (j === i ? v : x)));
  return (
    <form
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
      <ol style={{ paddingLeft: "1.2rem", margin: "0 0 0.5rem" }}>
        {questions.map((q, i) => (
          <li key={i} style={{ marginBottom: "0.6rem" }}>
            <div>
              {q.question}
              {q.area && <span className="chip" style={{ marginLeft: "0.35rem" }}>{SHAPING_AREA_LABEL[q.area]}</span>}
            </div>
            {q.why && (
              <div className="muted" style={{ fontSize: "0.82rem" }}>
                Why: {q.why}
              </div>
            )}
            {q.options && (
              <div className="row" style={{ gap: "0.3rem", margin: "0.25rem 0" }} role="group" aria-label={`Suggested answers to question ${i + 1}`}>
                {q.options.map((o) => (
                  <button key={o} type="button" className="small" disabled={disabled} aria-pressed={answers[i] === o} onClick={() => set(i, o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <label>
              <span className="sr-only">Your answer to question {i + 1}</span>
              <input type="text" value={answers[i]} onChange={(e) => set(i, e.target.value)} placeholder="Your answer (leave empty to skip)" style={{ width: "100%" }} />
            </label>
          </li>
        ))}
      </ol>
      <div className="row">
        <button type="submit" className="primary" disabled={disabled || sending || !text}>
          {sending ? "Sending…" : answered ? `Send ${answered} answer${answered === 1 ? "" : "s"}` : "Send answers"}
        </button>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          Sent as one message to the lead; unanswered questions are skipped.
        </span>
      </div>
    </form>
  );
}

/** The stage in the header: "Shaping" says what waits; "Building" is the usual state. */
export function StageChip() {
  const { state } = useStore();
  const shaping = state.project.stage === "shaping";
  return (
    <a href={shaping ? "#/overview" : "#/settings"} className={`chip${shaping ? " strong" : ""}`} style={{ textDecoration: "none" }} title={shaping ? `${M.SHAPING_LABEL}. Running work finishes.` : "Building: work runs as usual. Change the stage in Settings."}>
      {shaping ? "Shaping" : "Building"}
    </a>
  );
}

/** On the board while shaping: why nothing new starts, without calling anything paused. */
export function ShapingBanner() {
  const { state } = useStore();
  if (state.project.stage !== "shaping") return null;
  const running = M.activeAttempts(state).length;
  return (
    <div className="banner neutral" role="note">
      <strong>{M.SHAPING_LABEL}.</strong> {running ? `${running} running step${running === 1 ? "" : "s"} finish${running === 1 ? "es" : ""} normally; ` : ""}
      Planned tasks are held. <a href="#/overview">Shape the vision</a>
    </div>
  );
}

/**
 * The draft to show: the open one, or, while its editor is open, the draft the user started editing even
 * after a newer draft replaced it, was accepted or dismissed elsewhere (review 4; ORC-014 review 13), so
 * edits are never dropped silently. Keyed on the draft. Always mounted by its parent: it renders
 * `fallback` when there is nothing to show, so an editing session survives the draft going away.
 */
export function OpenDraft({ fallback = null }: { fallback?: React.ReactNode }) {
  const { state } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const open = M.openVisionDraft(state);
  const draft = (editingId ? state.visionDrafts.find((d) => d.id === editingId) : undefined) ?? open;
  if (!draft) return <>{fallback}</>;
  return <VisionDraftCard key={draft.id} state={state} draft={draft} onEditing={setEditingId} />;
}

/**
 * A draft next to the current vision: the diff, and Accept, Edit and accept, and Dismiss. Every accept is
 * compare-and-set on the vision revision the user saw when they started (review 4): the editor keeps its
 * base revision and draft id, and says so when the vision moved or the draft was replaced meanwhile.
 */
export function VisionDraftCard({ state, draft, onEditing }: { state: State; draft: VisionDraft; onEditing?: (draftId: string | null) => void }) {
  const { send, disabled } = useStore();
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
  return (
    <div className="banner review" role="region" aria-label={`Vision draft ${draft.id}`} style={{ marginBottom: "0.8rem" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>The lead drafted a vision</strong>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          {relTime(draft.at)} · from your message{draft.messageIds.length === 1 ? "" : "s"}{" "}
          {draft.messageIds.map((id) => (
            <button key={id} className="link" style={{ fontSize: "0.82rem" }} onClick={() => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "center" })}>
              {id}
            </button>
          ))}
        </span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.5rem" }}>
        “{draft.reason}” — It is a suggestion: the vision changes only if you accept it.
        {moved ? ` The vision moved to r${vision.rev} since the lead drafted this (it saw r${draft.basedOnVisionRev}); the comparison below is against r${vision.rev}.` : ""}
      </p>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (gone || stale) return;
            void run("acceptVisionDraft", { draftId: editing.draftId, expectedRev: editing.baseRev, text, focus });
          }}
        >
          {gone && (
            <div className="banner danger" role="alert">
              {goneWhy} while you were editing, so it can no longer be accepted. Your text is kept: save it as your own revision, or discard it.{" "}
              <button type="button" className="small" disabled={off || !text.trim()} onClick={() => void run("editVision", { expectedRev: vision.rev, text, focus, reason: `Edited the lead's draft ${draft.id} after it was ${draft.status}` })}>
                Save as r{vision.rev + 1} by hand
              </button>{" "}
              <button type="button" className="small" disabled={busy} onClick={stopEditing}>
                Discard
              </button>
            </div>
          )}
          {!gone && stale && (
            <div className="banner danger" role="alert">
              The vision changed to r{vision.rev} ({vision.author}: {vision.reason}) while you were editing. Your text is kept.{" "}
              <button type="button" className="small" onClick={() => setEditing({ ...editing, baseRev: vision.rev })}>
                Accept over r{vision.rev} anyway
              </button>
            </div>
          )}
          <label className="field">
            <span>Vision</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} required style={{ minHeight: "9rem" }} />
          </label>
          <label className="field">
            <span>Current focus</span>
            <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={off || !text.trim() || gone || stale}>
              Accept as r{editing.baseRev + 1}
            </button>
            <button type="button" disabled={busy} onClick={stopEditing}>
              Cancel
            </button>
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
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <button className="primary" disabled={off || changed === 0} onClick={() => void run("acceptVisionDraft", { draftId: draft.id, expectedRev: vision.rev })}>
              Accept as r{vision.rev + 1}
            </button>
            <button
              disabled={off}
              onClick={() => {
                setText(draft.text);
                setFocus(draft.focus);
                setEditing({ draftId: draft.id, baseRev: vision.rev });
                onEditing?.(draft.id);
              }}
            >
              Edit and accept
            </button>
            <button disabled={off} onClick={() => void run("dismissVisionDraft", { draftId: draft.id })}>
              Dismiss
            </button>
            {changed === 0 && <span className="muted" style={{ fontSize: "0.82rem" }}>Nothing differs from the current vision.</span>}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Start building, or why it cannot start yet. Open areas are named and confirmed, never a block: only an
 * empty vision blocks. ORC-014 review 11: the outcome named is what Start building does with the
 * involvement setting as it is now, counting only the tasks under the roadmap's own hold.
 */
export function StartBuildingButton({ className = "primary" }: { className?: string }) {
  const { state, send, disabled } = useStore();
  const [busy, setBusy] = useState(false);
  const why = M.startBuildingBlocker(state);
  const plan = M.startBuildingPlan(state);
  const roadmap = plan.roadmap.length;
  const held = plan.userHeld.length;
  const open = M.openAreas(state);
  // Review 8: no coverage reported means every area is still open, and the confirmation says so.
  const stillOpen = !M.coverageOf(state) ? "The lead has not reported which areas are clear yet, so all nine count as open." : open.length ? `Still open: ${open.map((x) => SHAPING_AREA_LABEL[x].toLowerCase()).join(", ")}.` : "";
  const outcome = [
    roadmap ? (plan.release ? `With your involvement set to Autopilot now, the ${roadmap} planned task${roadmap === 1 ? " starts" : "s start"} right away.` : `With your involvement setting as it is now, the ${roadmap} planned task${roadmap === 1 ? "" : "s"} wait${roadmap === 1 ? "s" : ""} for you to release ${roadmap === 1 ? "it" : "them"}.`) : "",
    held ? `${held} planned task${held === 1 ? "" : "s"} you held keep${held === 1 ? "s" : ""} waiting for your release.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="row" style={{ gap: "0.5rem" }}>
      <button
        className={className}
        disabled={disabled || busy || !!why}
        title={why}
        onClick={async () => {
          if (open.length && !confirm(`${stillOpen}${outcome ? `\n\n${outcome}` : ""}\n\nStart building anyway? The lead keeps answering you, and you can come back to shaping at any time.`)) return;
          setBusy(true);
          await send("startBuilding");
          setBusy(false);
        }}
      >
        Start building
      </button>
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        {why ?? [stillOpen, outcome].filter(Boolean).join(" ")}
      </span>
    </span>
  );
}

/** Writing the vision by hand while shaping (the same command as the Vision card's editor; compare-and-set on the revision). */
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
      <button
        className="small"
        disabled={disabled}
        onClick={() => {
          setText(vision.text);
          setFocus(vision.focus);
          setBaseRev(vision.rev);
          setOpen(true);
        }}
      >
        {vision.text.trim() ? "Edit the vision by hand" : "Write the vision by hand"}
      </button>
    );
  }
  const stale = vision.rev !== baseRev;
  return (
    <form
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
        <div className="banner danger" role="alert">
          The vision changed to r{vision.rev} while you were writing. Your draft is kept.{" "}
          <button type="button" className="small" onClick={() => setBaseRev(vision.rev)}>
            Save over r{vision.rev} anyway
          </button>
        </div>
      )}
      <label className="field">
        <span>Vision</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} required style={{ minHeight: "7rem" }} />
      </label>
      <label className="field">
        <span>Current focus</span>
        <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
      </label>
      <label className="field">
        <span>Reason for change (recorded)</span>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={disabled || saving || stale || !text.trim()}>
          Save as r{vision.rev + 1}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The Overview's shaping panel: what shaping means, the vision so far, the latest draft, the roadmap, and Start building. */
export function ShapingPanel() {
  const { state, service } = useStore();
  const vision = M.currentVision(state);
  const roadmap = M.roadmapTasks(state);
  const plan = M.startBuildingPlan(state);
  const running = M.activeAttempts(state).length;
  const last = state.visionDrafts.length ? state.visionDrafts[state.visionDrafts.length - 1] : undefined;
  const asked = M.latestQuestions(state);
  const simulated = service.runtime !== "real";
  // ORC-014 review 13: the draft card stays mounted while its editor is open; this is what shows otherwise.
  const noDraft = last ? (
    <p className="muted" style={{ fontSize: "0.85rem" }}>
      Latest draft {last.id}: {last.status === "accepted" ? `accepted as r${last.visionRev}` : last.status === "dismissed" ? "dismissed" : last.status} · {fmtTime(last.resolvedAt ?? last.at)}. Ask the lead for another when you are ready.
    </p>
  ) : (
    <p className="muted" style={{ fontSize: "0.85rem" }}>No draft yet. The lead drafts one when the conversation gives it enough.</p>
  );
  return (
    <section className="card" aria-labelledby="shape-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="shape-h" style={{ margin: 0 }}>
          Shape the vision
        </h2>
        <span className="chip strong">Shaping</span>
      </div>
      <p style={{ margin: "0.5rem 0" }}>
        Talk the goal through with the lead. It asks a few targeted questions at a time, suggests what you may not have considered, and keeps a living draft of the vision with its assumptions marked; you accept, edit or
        dismiss each draft. It may also plan a first roadmap. {M.SHAPING_LABEL}.
        {running ? ` ${running} running step${running === 1 ? "" : "s"} finish${running === 1 ? "es" : ""} normally.` : ""}
        {simulated ? " In the sample project the lead's questions, coverage and draft are simulated: built from your message, not written by a model." : ""}
      </p>
      <p style={{ margin: "0 0 0.8rem" }}>
        <a href="#lead-inline" onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById("lead-inline");
          el?.scrollIntoView({ block: "start" });
          el?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        }}>
          Message the lead
        </a>
      </p>

      <h3>Vision so far (r{vision.rev})</h3>
      {vision.text.trim() ? (
        <>
          <p style={{ whiteSpace: "pre-wrap" }}>{vision.text}</p>
          <p>
            <span className="muted">Current focus:</span> {vision.focus || <span className="muted">(none)</span>}
          </p>
        </>
      ) : (
        <p className="muted">Not written yet. Tell the lead what you want to build, or write it yourself.</p>
      )}
      <div style={{ marginBottom: "0.8rem" }}>
        <HandEdit />
      </div>

      <div style={{ marginBottom: "0.8rem" }}>
        <VisionDocsList compact />
      </div>

      {asked && (
        <div key={asked.message.id} style={{ marginBottom: "0.8rem" }}>
          <QuestionsForm questions={asked.questions} />
        </div>
      )}

      <CoverageChecklist state={state} />

      <OpenDraft fallback={noDraft} />

      <h3>Planned tasks ({roadmap.length})</h3>
      {roadmap.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>None yet. Tasks the lead proposes while shaping are held here until you start building.</p>
      ) : (
        <ul className="plain" style={{ marginBottom: "0.6rem" }}>
          {roadmap.map((t) => (
            <li key={t.id}>
              <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title} <span className="chip">P{t.priority}</span>{" "}
              <span className="chip">{t.heldForShaping ? `held until building, then ${plan.release ? "starts on Autopilot" : "waits for your release"}` : t.holdBeforeStart ? "held by you; waits for your release" : "starts when building starts"}</span>
            </li>
          ))}
        </ul>
      )}
      <StartBuildingButton />
    </section>
  );
}

/** Settings → Project: the current stage and the way to the other one. */
export function StageControl() {
  const { state, send, disabled } = useStore();
  const [busy, setBusy] = useState(false);
  const shaping = state.project.stage === "shaping";
  const running = M.activeAttempts(state).length;
  return (
    <div className="field">
      <span>Stage</span>
      <div className="row" style={{ gap: "0.5rem" }}>
        <span className="chip strong">{shaping ? "Shaping" : "Building"}</span>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {shaping ? `${M.SHAPING_LABEL}; the lead answers your messages and drafts the vision.` : "Work runs as usual. Back to shaping stops nothing that is running; nothing new starts."}
        </span>
      </div>
      <div className="row" style={{ marginTop: "0.4rem" }}>
        {shaping ? (
          <StartBuildingButton className="" />
        ) : (
          <button
            disabled={disabled || busy}
            onClick={async () => {
              setBusy(true);
              await send("startShaping");
              setBusy(false);
            }}
          >
            Back to shaping
          </button>
        )}
        {!shaping && running > 0 && <span className="muted" style={{ fontSize: "0.85rem" }}>{running} running step(s) would finish normally.</span>}
      </div>
    </div>
  );
}
