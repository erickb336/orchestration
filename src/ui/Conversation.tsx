import { useLayoutEffect, useRef, useState } from "react";
import * as M from "../domain/model";
import type { LeadRun, Message, State } from "../domain/types";
import { useStore } from "./store";
import { fmtTime, relTime, selectionText } from "./common";

const MAX_LENGTH = 8000;

function runLabel(r: LeadRun) {
  return selectionText({ provider: r.provider, model: r.actualModel ?? r.model });
}

/** The lead conversation: messages, what the lead is doing now, and a composer. */
export function Conversation() {
  const { state, service, send, disabled } = useStore();
  const simulated = service.runtime === "fake";
  const messages = state.conversation;
  const listRef = useRef<HTMLOListElement>(null);
  // Follow new messages only while the reader is at the bottom; scrolling up to read history is not interrupted.
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <section className="card" aria-labelledby="lead-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="lead-h" style={{ margin: 0 }}>
          Lead
        </h2>
        <span className="row" style={{ gap: "0.35rem" }}>
          <span className="chip strong">{selectionText(state.project.leadSelection)}</span>
          {simulated && <span className="chip">simulated replies</span>}
        </span>
      </div>
      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.3rem 0 0.6rem" }}>
        {simulated
          ? "Fake runtime: lead replies and proposals are simulated, not written by a model."
          : "Replies come from a real lead run. The lead can reply and propose new tasks; it never edits existing tasks."}
      </p>

      {messages.length === 0 ? (
        <p className="muted convo-empty">No messages yet. Ask the lead a question or give it direction; it answers in its next run.</p>
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
            <MessageItem key={m.id} state={state} message={m} simulated={simulated} />
          ))}
        </ol>
      )}

      <LeadStatus state={state} />
      <Composer
        disabled={disabled}
        onSend={async (text) => {
          stick.current = true;
          return (await send("postMessage", { text })).ok;
        }}
      />
    </section>
  );
}

function MessageItem({ state, message: m, simulated }: { state: State; message: Message; simulated: boolean }) {
  const run = m.leadRunId ? state.leadRuns.find((r) => r.id === m.leadRunId) : undefined;
  const who = m.author === "user" ? "You" : m.author === "lead" ? (simulated ? "Lead (simulated)" : "Lead") : "System";
  return (
    <li className={`msg ${m.author}`}>
      <div className="msg-head">
        <strong>{who}</strong>
        {m.author === "lead" && run && <span className="muted">{runLabel(run)}</span>}
        <time dateTime={m.at} title={fmtTime(m.at)} className="muted">
          {relTime(m.at)}
        </time>
      </div>
      <div className="msg-text">{m.text}</div>
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
          Not created:
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

function LeadStatus({ state }: { state: State }) {
  const run = M.activeLeadRun(state);
  const pending = M.pendingMessages(state).length;
  const last = state.leadRuns.length ? state.leadRuns[state.leadRuns.length - 1] : undefined;
  let text: string | null = null;
  let live = false;
  if (run) {
    live = true;
    text = run.outcome === "stopping" ? `Stopping the lead run (${runLabel(run)})…` : `Lead is working (${runLabel(run)})…${run.activity ? ` ${run.activity}` : ""}`;
  } else if (last && (last.outcome === "failed" || last.outcome === "lost")) {
    text = `The last lead run ${last.outcome === "lost" ? "was lost" : "failed"}${last.note ? `: ${last.note}` : "."}${pending ? ` ${pending} message${pending === 1 ? "" : "s"} still waiting.` : ""}`;
  } else if (pending) {
    const n = `${pending} message${pending === 1 ? "" : "s"}`;
    text = state.project.hold ? `Project paused — the lead answers ${n} after you resume.` : `Waiting to answer ${n}.`;
  }
  return (
    <div className="convo-status" role="status">
      {text && (
        <>
          {live && <span className={`dot ${run?.outcome === "stopping" ? "paused" : "running"}`} aria-hidden="true" />}
          <span>{text}</span>
        </>
      )}
    </div>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
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
      <label htmlFor="lead-message" className="sr-only">
        Message to the lead
      </label>
      <textarea
        id="lead-message"
        value={text}
        placeholder="Ask the lead or give direction…"
        aria-describedby="lead-message-hint"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span id="lead-message-hint" className="muted" style={{ fontSize: "0.8rem" }}>
          {tooLong ? `Messages are limited to ${MAX_LENGTH} characters.` : disabled ? "Offline: messages cannot be sent." : "⌘/Ctrl + Enter to send"}
        </span>
        <button type="submit" className="primary" disabled={blocked}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
