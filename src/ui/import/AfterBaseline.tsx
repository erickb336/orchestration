// After the baseline (ORC-032, screen 5), in Vision and on Home: the changes to design the owner asked for in the
// review, beside Ask the lead for a round (UX-5), and the import's questions that stay open, to answer in Vision
// (CR-9). Words: importView.ts.

import { useState } from "react";
import { importQuestions } from "../../domain/studio/import";
import { Button, Card } from "../kit";
import { useStore } from "../store";
import { Question } from "./ImportQuestion";
import { changeLine, changesWaitLine, openChanges, openQuestions, roundRequest, ruleKey, targetOf, type DraftAnswer, type ReviewDraft } from "./importView";
import "./import.css";

/** Ask the lead for a round: one message with the changes to design, in your words. */
export function AskForRound({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const { state, send, disabled } = useStore();
  const [asked, setAsked] = useState(false);
  return (
    <>
      <Button
        size="small"
        variant={variant}
        disabled={disabled || asked}
        disabledReason={disabled ? "The service is offline." : undefined}
        onClick={async () => {
          if ((await send("postMessage", { text: roundRequest(state) })).ok) setAsked(true);
        }}
      >
        Ask the lead for a round
      </Button>
      {asked && <span className="small muted">Sent. The lead answers in the conversation.</span>}
    </>
  );
}

/** The changes to design that wait, listed beside Ask the lead for a round; nothing when none waits. */
export function ChangesToDesign() {
  const { state } = useStore();
  const changes = openChanges(state);
  if (!changes.length) return null;
  return (
    <div className="k-stack k-stack--tight imp-changes">
      <p className="small no-margin">{changesWaitLine(changes.length)}</p>
      <ul className="imp-changes__list small" aria-label="Changes to design">
        {changes.map((c) => (
          <li key={JSON.stringify(c.on)}>{changeLine(state, c)}</li>
        ))}
      </ul>
      <div className="k-actions">
        <AskForRound />
      </div>
    </div>
  );
}

/** The import's questions that no answer settled: each with its options, and Send your answers (answerImport). */
export function ImportOpenQuestions() {
  const { state, send, disabled } = useStore();
  const [draft, setDraft] = useState<ReviewDraft>({});
  const [sending, setSending] = useState(false);
  const imp = state.studio.import;
  if (!imp?.lockedInAt) return null;
  const open = openQuestions(state);
  if (!open.length) return null;
  const asked = importQuestions(imp).asked;
  const entries = Object.entries(draft).filter(([, a]) => a.option);
  const missing = entries.find(([, a]) => (a.option === "neither" || a.option === "correct") && !a.text?.trim());
  const blocker = disabled ? "The service is offline." : !entries.length ? "Answer a question first." : missing ? "Write what is right first." : undefined;
  const set = (key: string, a: DraftAnswer | undefined) =>
    setDraft((all) => {
      const next = { ...all };
      if (a) next[key] = a;
      else delete next[key];
      return next;
    });
  const sendAll = async () => {
    if (blocker || sending) return;
    setSending(true);
    const answers = entries.map(([key, a]) => ({ on: targetOf(key), option: a.option!, ...(a.option === "correct" ? { correction: a.correction ?? "change" } : {}), ...(a.text?.trim() ? { text: a.text.trim() } : {}) }));
    if ((await send("answerImport", { answers })).ok) setDraft({});
    setSending(false);
  };
  return (
    <Card title="The import's open questions" count={open.length} countTone="you">
      <p className="small muted no-margin">The baseline holds each as the code has it, "not confirmed". An answer unlike the code becomes a change to design.</p>
      {open.map((rule) => {
        const q = asked.find((x) => x.ruleId === rule.id)!;
        return <Question key={rule.id} q={q} answer={draft[ruleKey(rule.id)]} onAnswer={(a) => set(ruleKey(rule.id), a)} />;
      })}
      <div className="k-actions">
        <Button variant="primary" size="small" disabled={!!blocker} disabledReason={blocker} showReason={!!blocker} loading={sending} onClick={() => void sendAll()}>
          {sending ? "Sending…" : "Send your answers"}
        </Button>
      </div>
    </Card>
  );
}
