import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { LeadRun, Message, State } from "../domain/types";
import { useStore } from "./store";
import { PREF_LEAD_SEEN, fmtTime, relTime, selectionText, writePref } from "./common";
import { useLeadContext } from "./LeadDrawer";
import { SteeringChanges } from "./SteeringChanges";

const MAX_LENGTH = 8000;

function runLabel(r: LeadRun) {
  return selectionText({ provider: r.provider, model: r.actualModel ?? r.model });
}

/** How far the lead may go, as shown on the composer. */
const MODE_SHORT = { apply: "applies changes; undo any of them", "apply-own": "applies changes to its own proposals, suggests for yours", suggest: "only suggests changes" } as const;

/**
 * The lead conversation: messages, where each of yours stands, what the lead changed (with Undo),
 * and a composer. One instance lives on the Overview; the Lead drawer shows another on every other page.
 */
export function Conversation({ variant = "inline", onClose, focusOnMount }: { variant?: "inline" | "drawer"; onClose?: () => void; focusOnMount?: boolean }) {
  const { state, service, send, disabled } = useStore();
  const lead = useLeadContext();
  const simulated = service.runtime === "fake";
  const messages = state.conversation;
  const listRef = useRef<HTMLOListElement>(null);
  // Follow new messages only while the reader is at the bottom; scrolling up to read history is not interrupted.
  const stick = useRef(true);
  const headingId = useId();
  const contextTask = lead.context.taskId ? state.tasks.find((t) => t.id === lead.context.taskId) : undefined;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  // Whatever is on screen counts as seen (the Lead button's badge counts newer replies).
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.author === "lead");
    if (last) writePref(PREF_LEAD_SEEN, last.at);
  }, [messages]);

  return (
    <section className={variant === "drawer" ? "lead-panel" : "card"} aria-labelledby={headingId} id={variant === "inline" ? "lead-inline" : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id={headingId} style={{ margin: 0 }}>
          Lead
        </h2>
        <span className="row" style={{ gap: "0.35rem" }}>
          <span className="chip strong">{selectionText(state.project.leadSelection)}</span>
          {onClose && (
            <button className="small" onClick={onClose} aria-label="Close the lead panel">
              Close
            </button>
          )}
        </span>
      </div>
      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.3rem 0 0.6rem" }}>
        {simulated
          ? "The lead's replies and changes are simulated, not written by a model."
          : "When you message the lead, it can change the focus, reorder and defer work, drop its own unstarted proposals, and send a note to a running coder or designer. Every change is listed, with Undo for all but notes. It never pauses or stops running work."}
      </p>

      {messages.length === 0 ? (
        <p className="muted convo-empty">No messages yet. Message the lead; it answers in its next run.</p>
      ) : (
        <ol
          ref={listRef}
          className="convo"
          aria-label="Conversation with the lead"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {messages.map((m) => (
            <MessageItem key={m.id} state={state} message={m} simulated={simulated} blocked={service.leadBlocked} />
          ))}
        </ol>
      )}

      <LeadStatus state={state} blocked={service.leadBlocked} />
      {contextTask && (
        <div className="row" style={{ marginBottom: "0.3rem" }}>
          <span className="chip strong">
            About {contextTask.id} {M.currentSpec(contextTask).content.title.slice(0, 40)}
            <button className="link" style={{ marginLeft: "0.35rem" }} onClick={lead.clearContext} aria-label={`Stop referring to ${contextTask.id}`}>
              ×
            </button>
          </span>
        </div>
      )}
      <Composer
        disabled={disabled}
        placeholder={lead.context.placeholder}
        focusOnMount={focusOnMount}
        mode={MODE_SHORT[state.project.steeringMode]}
        onSend={async (text) => {
          stick.current = true;
          const r = await send("postMessage", contextTask ? { text, taskId: contextTask.id } : { text });
          if (r.ok) lead.clearContext();
          return r.ok;
        }}
      />
    </section>
  );
}

function MessageItem({ state, message: m, simulated, blocked }: { state: State; message: Message; simulated: boolean; blocked?: string }) {
  const { send, disabled } = useStore();
  const run = m.leadRunId ? state.leadRuns.find((r) => r.id === m.leadRunId) : undefined;
  const who = m.author === "user" ? "You" : m.author === "lead" ? "Lead" : "System";
  const status = m.author === "user" ? M.messageStatus(state, m, { blocked, nowMs: Date.now() }) : undefined;
  const set = m.changeSetId ? state.steering.find((cs) => cs.id === m.changeSetId) : undefined;
  const draft = m.visionDraftId ? state.visionDrafts.find((d) => d.id === m.visionDraftId) : undefined;
  const about = m.taskId ? state.tasks.find((t) => t.id === m.taskId) : undefined;
  return (
    <li className={`msg ${m.author}`} id={`msg-${m.id}`}>
      <div className="msg-head">
        <strong>{who}</strong>
        {m.author === "lead" && simulated && <span className="chip">simulated</span>}
        {m.author === "lead" && run && <span className="muted">{runLabel(run)}</span>}
        {about && (
          <a href={`#/task/${encodeURIComponent(about.id)}`} className="chip" title={M.currentSpec(about).content.title}>
            About {about.id}
          </a>
        )}
        <time dateTime={m.at} title={fmtTime(m.at)} className="muted">
          {relTime(m.at)}
        </time>
      </div>
      <div className="msg-text">{m.text}</div>
      {status && status.kind !== "answered" && (
        <div className="msg-status muted" role="status">
          <span className={status.kind === "working" || status.kind === "stopping-planning" || status.kind === "restarting" ? "dot running" : undefined} aria-hidden="true" />
          <span style={status.kind === "blocked" || status.text.includes("Control failure") ? { color: "var(--s-blocked)" } : undefined}>{status.text}</span>
          {status.kind === "queued-behind-reply" && (
            <button className="small" disabled={disabled} onClick={() => void send("stopLeadReply")} title="Stop the reply being written so one run answers everything you sent">
              Answer together now
            </button>
          )}
        </div>
      )}
      {set && <SteeringChanges set={set} />}
      {m.author === "lead" && m.leadRunId && <LeadDecisions state={state} leadRunId={m.leadRunId} snapshot={m.leadDecisions} />}
      {draft && (
        <div className="msg-extra" role="note">
          <span className="chip strong">Vision draft {draft.id}</span>{" "}
          <span className="muted">
            {draft.status === "open"
              ? "needs you on the Overview: accept, edit or dismiss it; the vision changes only if you accept"
              : draft.status === "accepted"
                ? `accepted by you as r${draft.visionRev}`
                : draft.status === "dismissed"
                  ? "dismissed by you; the vision is unchanged"
                  : "replaced by a newer draft"}
          </span>
        </div>
      )}
      {!!m.questions?.length && (
        <div className="msg-extra">
          <span className="muted">Questions:</span>
          <ol style={{ margin: "0.15rem 0 0", paddingLeft: "1.2rem" }}>
            {m.questions.map((q, i) => (
              <li key={i}>
                {q.question}
                {q.why && <span className="muted"> — {q.why}</span>}
                {q.options && <span className="muted"> ({q.options.join(" · ")})</span>}
              </li>
            ))}
          </ol>
          {state.project.stage === "shaping" && M.latestQuestions(state)?.message.id === m.id && <div className="muted" style={{ fontSize: "0.82rem" }}>Answer them inline in “Shape the vision”, or reply here.</div>}
        </div>
      )}
      {!!m.proposedTaskIds?.length && (
        <div className="msg-extra">
          <span className="muted">Proposed:</span>
          <ul className="plain">
            {m.proposedTaskIds.map((id) => {
              const t = state.tasks.find((x) => x.id === id);
              return (
                <li key={id}>
                  <a href={`#/task/${encodeURIComponent(id)}`}>{id}</a> {t ? M.currentSpec(t).content.title : <span className="muted">(no longer on the board)</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {!!m.rejected?.length && (
        <div className="msg-extra muted">
          Not applied:
          <ul className="plain">
            {m.rejected.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** ORC-013: the service's record of what a lead reply decided, suggested or handed over (never the lead's prose), with a way to change it. */
function LeadDecisions({ state, leadRunId, snapshot }: { state: State; leadRunId: string; snapshot?: NonNullable<Message["leadDecisions"]> }) {
  // Review 1 (14): the reply shows what the run decided then; a message from before the snapshot existed reads the live records.
  const rows = snapshot ?? F.leadRunDecisions(state, leadRunId).map(({ decision: d, what }) => ({ id: d.id, taskId: d.taskId, what, status: d.status, ...(d.why || d.suggestion?.why ? { why: d.why ?? d.suggestion?.why } : {}) }));
  if (!rows.length) return null;
  return (
    <div className="msg-extra">
      <span className="muted">Decisions on findings:</span>
      <ul className="plain">
        {rows.map((d) => {
          const now = state.decisions.find((x) => x.id === d.id);
          return (
            <li key={d.id}>
              {d.what === "decided" ? `Decided ${d.id}: ${d.status}` : d.what === "suggested" ? `Suggested fix on ${d.id}: yours to decide` : `Handed ${d.id} over to you`}
              {d.why ? ` — ${d.why}` : ""} <span className="muted">({d.taskId})</span>
              {now && now.status !== d.status && now.status !== "open" ? <span className="muted"> · now: {now.status}</span> : ""}{" "}
              <a href={`#/task/${encodeURIComponent(d.taskId)}`} title="Open the task to change this decision">
                Change
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What the lead is doing now, in the words of the newest waiting message (never "working" while a message is queued). */
function LeadStatus({ state, blocked }: { state: State; blocked?: string }) {
  const run = M.activeLeadRun(state);
  const pending = M.pendingMessages(state);
  const last = state.leadRuns.length ? state.leadRuns[state.leadRuns.length - 1] : undefined;
  let text: string | null = null;
  let live = false;
  let danger = false;
  if (pending.length) {
    const st = M.messageStatus(state, pending[pending.length - 1], { blocked, nowMs: Date.now() });
    text = pending.length > 1 ? `${pending.length} messages waiting. ${st.text}` : st.text;
    live = st.kind === "stopping-planning" || st.kind === "restarting";
    danger = st.kind === "blocked" || st.text.includes("Control failure");
  } else if (run) {
    live = true;
    text =
      run.outcome === "stopping"
        ? `Stopping the lead run (${runLabel(run)})…${run.note?.startsWith("Control failure") ? ` ${run.note}` : ""}`
        : `Lead is working (${runLabel(run)})…${run.activity ? ` ${run.activity}` : ""}`;
    danger = !!run.note?.startsWith("Control failure");
  } else if (last && (last.outcome === "failed" || last.outcome === "lost")) {
    text = `The last lead run ${last.outcome === "lost" ? "was lost" : "failed"}${last.note ? `: ${last.note}` : "."}`;
  }
  return (
    <div className="convo-status" role="status">
      {text && (
        <>
          {live && <span className={`dot ${run?.outcome === "stopping" ? "paused" : "running"}`} aria-hidden="true" />}
          <span style={danger ? { color: "var(--s-blocked)" } : undefined}>{text}</span>
          {danger && blocked && <a href="#/settings">Settings</a>}
        </>
      )}
    </div>
  );
}

function Composer({ disabled, placeholder, focusOnMount, mode, onSend }: { disabled: boolean; placeholder?: string; focusOnMount?: boolean; mode: string; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  const tooLong = text.trim().length > MAX_LENGTH;
  const blocked = disabled || sending || !text.trim() || tooLong;
  const submit = async () => {
    if (blocked) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    // Keep the draft when the service did not accept it; the notice explains why.
    if (ok) setText("");
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Message to the lead
      </label>
      <textarea
        id={id}
        ref={ref}
        value={text}
        placeholder={placeholder ?? "Message the lead…"}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span id={`${id}-hint`} className="muted" style={{ fontSize: "0.8rem" }}>
          {tooLong ? `Messages are limited to ${MAX_LENGTH} characters.` : disabled ? "Offline: messages cannot be sent." : "⌘/Ctrl + Enter to send"}
          {" · "}The lead {mode} (<a href="#/settings">Settings</a>)
        </span>
        <button type="submit" className="primary" disabled={blocked}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
