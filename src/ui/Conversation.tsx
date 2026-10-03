import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { Message, State } from "../domain/types";
import { useStore } from "./store";
import { PREF_LEAD_SEEN, fmtTime, relTime, selectionText, writePref } from "./common";
import { Button, Chip, SimulatedChip } from "./kit";
import { useLeadContext } from "./LeadDrawer";
import { leadBlockedLink, leadDecisionText, messageStatusText } from "./notes";
import { Fold, SteeringChanges } from "./SteeringChanges";

const MAX_LENGTH = 8000;

/**
 * The lead conversation, as the lead drawer shows it on every page (the one place it is drawn). It reads like a
 * chat. One quiet line says who the lead is (and "simulated" once, in the demo); each message is who, when and the
 * text; what a reply changed folds into one line under it; the composer last.
 */
export function Conversation({ onClose, focusOnMount }: { onClose: () => void; focusOnMount?: boolean }) {
  const { state, service, send, disabled } = useStore();
  const lead = useLeadContext();
  const simulated = service.runtime === "fake";
  const messages = state.conversation;
  const listRef = useRef<HTMLOListElement>(null);
  // Follow new messages only while the reader is at the bottom; scrolling up to read history is not interrupted.
  const stick = useRef(true);
  const headingId = useId();
  const contextTask = lead.context.taskId ? state.tasks.find((t) => t.id === lead.context.taskId) : undefined;
  const leadModel = selectionText(state.project.leadSelection);

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
    <section className="lead-panel" aria-labelledby={headingId}>
      <div className="lead-head">
        <h2 id={headingId} className="lead-title">
          Lead
        </h2>
        <span className="lead-who small muted">{leadModel}</span>
        {simulated && <SimulatedChip title="Simulated: the demo's lead writes these replies and changes from the board; no model runs and no agent reads its notes." />}
        <Button size="small" variant="quiet" className="lead-close" onClick={onClose} aria-label="Close the lead panel">
          Close
        </Button>
      </div>

      {messages.length === 0 ? (
        <div className="convo-empty muted">
          <p>No messages yet. Ask the lead what is going on, or tell it what to focus on; it answers in its next run.</p>
          <p className="small">It can change the focus and priorities, defer work and pass a note to a running agent. Every change is listed under its reply, with Undo for all but notes.</p>
        </div>
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
            <MessageItem key={m.id} state={state} message={m} leadModel={leadModel} blocked={service.leadBlocked} />
          ))}
        </ol>
      )}

      <LeadStatus state={state} />
      {contextTask && (
        <div className="lead-context">
          <Chip strong title={M.currentSpec(contextTask).content.title}>
            About {contextTask.id} {M.currentSpec(contextTask).content.title.slice(0, 40)}
          </Chip>
          <Button size="small" variant="quiet" onClick={lead.clearContext} aria-label={`Stop referring to ${contextTask.id}`}>
            ×
          </Button>
        </div>
      )}
      <Composer
        disabled={disabled}
        placeholder={lead.context.placeholder}
        focusOnMount={focusOnMount}
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

function MessageItem({ state, message: m, leadModel, blocked }: { state: State; message: Message; leadModel: string; blocked?: string }) {
  const run = m.leadRunId ? state.leadRuns.find((r) => r.id === m.leadRunId) : undefined;
  // The model is said once, at the top; a reply written by another model than today's lead says which.
  const runModel = run ? selectionText({ provider: run.provider, model: run.actualModel ?? run.model }) : undefined;
  const who = m.author === "user" ? "You" : m.author === "lead" ? "Lead" : "System";
  const status = m.author === "user" ? M.messageStatus(state, m, { blocked, nowMs: Date.now() }) : undefined;
  const set = m.changeSetId ? state.steering.find((cs) => cs.id === m.changeSetId) : undefined;
  const draft = m.visionDraftId ? state.visionDrafts.find((d) => d.id === m.visionDraftId) : undefined;
  const about = m.taskId ? state.tasks.find((t) => t.id === m.taskId) : undefined;
  const live = status && (status.kind === "working" || status.kind === "stopping-planning" || status.kind === "restarting");
  const danger = status && (status.kind === "blocked" || status.text.includes("Control failure"));
  return (
    <li className={`msg ${m.author}`} id={`msg-${m.id}`}>
      <div className="msg-head">
        <strong>{who}</strong>
        {m.author === "lead" && runModel && runModel !== leadModel && <span className="muted">{runModel}</span>}
        {about && (
          <a href={`#/task/${encodeURIComponent(about.id)}`} className="msg-about" title={M.currentSpec(about).content.title}>
            About {about.id}
          </a>
        )}
        <time dateTime={m.at} title={fmtTime(m.at)} className="muted">
          {relTime(m.at)}
        </time>
      </div>
      <div className="msg-text">{m.text}</div>
      {status && status.kind !== "answered" && (
        <div className={`msg-status${danger ? " danger" : ""}`} role="status">
          {live && <span className="dot running" aria-hidden="true" />}
          <span>{messageStatusText(state, status)}</span>
          {status.kind === "blocked" && blocked && <a href={leadBlockedLink(state, blocked).href}>{leadBlockedLink(state, blocked).label}</a>}
        </div>
      )}
      {!!m.questions?.length && (
        <div className="msg-extra">
          <ol className="msg-questions">
            {m.questions.map((q, i) => (
              <li key={i}>
                {q.question}
                {q.why && <span className="muted"> — {q.why}</span>}
                {q.options && <span className="muted"> ({q.options.join(" · ")})</span>}
              </li>
            ))}
          </ol>
          {state.project.stage === "shaping" && M.latestQuestions(state)?.message.id === m.id && <p className="muted small no-margin">Answer them inline in “The vision” on Home, or reply here.</p>}
        </div>
      )}
      {draft && (
        <p className="msg-extra muted no-margin" role="note">
          {draft.status === "open" ? (
            <>
              This reply drafted the vision. It needs you on <a href="#/overview">Home</a>: accept, edit or dismiss it; the vision changes only if you accept.
            </>
          ) : draft.status === "accepted" ? (
            `You accepted this vision draft (vision revision ${draft.visionRev}).`
          ) : draft.status === "dismissed" ? (
            "You dismissed this vision draft; the vision is unchanged."
          ) : (
            "A newer vision draft replaced this one."
          )}
        </p>
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
          Not added to the board:
          <ul className="plain">
            {m.rejected.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {set && <SteeringChanges set={set} />}
      {m.author === "lead" && m.leadRunId && <LeadDecisions state={state} leadRunId={m.leadRunId} snapshot={m.leadDecisions} />}
    </li>
  );
}

/** The service's record of what a lead reply decided, suggested or handed over (never the lead's prose), folded like its changes. */
function LeadDecisions({ state, leadRunId, snapshot }: { state: State; leadRunId: string; snapshot?: NonNullable<Message["leadDecisions"]> }) {
  // The reply shows what the run decided then, not what the decisions became; a message from before replies kept that
  // snapshot reads the live records.
  const rows = snapshot ?? F.leadRunDecisions(state, leadRunId).map(({ decision: d, what }) => ({ id: d.id, taskId: d.taskId, what, status: d.status, ...(d.why || d.suggestion?.why ? { why: d.why ?? d.suggestion?.why } : {}) }));
  if (!rows.length) return null;
  return (
    <Fold summary={`${rows.length} decision${rows.length === 1 ? "" : "s"} on findings`}>
      <ul className="changes-list">
        {rows.map((d) => (
          <li key={d.id} className="change">
            {leadDecisionText(d, state.decisions.find((x) => x.id === d.id))}{" "}
            <a href={`#/task/${encodeURIComponent(d.taskId)}`} title="Open the task to change this decision">
              Change
            </a>
          </li>
        ))}
      </ul>
    </Fold>
  );
}

/**
 * What the lead is doing when no message of yours waits (each waiting message says where it stands under it):
 * a planning or decisions run, a stop in progress, or a run that failed.
 */
function LeadStatus({ state }: { state: State }) {
  if (M.pendingMessages(state).length) return null;
  const run = M.activeLeadRun(state);
  const last = state.leadRuns.length ? state.leadRuns[state.leadRuns.length - 1] : undefined;
  let text: string | null = null;
  let live = false;
  let danger = false;
  if (run) {
    live = true;
    const failure = run.note?.startsWith("Control failure") ? ` ${run.note}` : "";
    text = run.outcome === "stopping" ? `The lead's run is stopping…${failure}` : `The lead is working…${run.activity ? ` ${run.activity}` : ""}`;
    danger = !!failure;
  } else if (last && (last.outcome === "failed" || last.outcome === "lost")) {
    text = `The last lead run ${last.outcome === "lost" ? "was lost" : "failed"}${last.note ? `: ${last.note}` : "."}`;
    danger = true;
  }
  if (!text) return null;
  return (
    <div className={`convo-status${danger ? " danger" : ""}`} role="status">
      {live && <span className={`dot ${run?.outcome === "stopping" ? "paused" : "running"}`} aria-hidden="true" />}
      <span>{text}</span>
    </div>
  );
}

function Composer({ disabled, placeholder, focusOnMount, onSend }: { disabled: boolean; placeholder?: string; focusOnMount?: boolean; onSend: (text: string) => Promise<boolean> }) {
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
      <div className="composer-foot">
        <span id={`${id}-hint`} className={`small ${tooLong ? "composer-error" : "muted"}`}>
          {tooLong ? `Messages are limited to ${MAX_LENGTH} characters.` : disabled ? "Offline: messages cannot be sent." : <span className="keys-hint">⌘/Ctrl + Enter to send</span>}
        </span>
        <Button type="submit" variant="primary" disabled={blocked} loading={sending}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
