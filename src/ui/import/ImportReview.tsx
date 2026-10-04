// Review (ORC-032, screen 3), in Vision once the reading is done: round 0, As it is today (C9). It asks only the
// conflicts and the important guesses, at most 10, conflicts first (Q4); the confirmed rules and the parts are listed,
// not asked (C8), and "Correct" offers its two choices on any of them (C15). Your answers wait here, kept in this browser across a reload, until Send, which
// records them together (answerImport) and opens the baseline. Words: importView.ts.

import { useEffect, useState } from "react";
import { fmtUsd, importSpend } from "../../domain/spend";
import { importParts, importQuestions, ruleConfidence, ruleTitle } from "../../domain/studio/import";
import type { ImportRule, StudioArtifact } from "../../domain/studio/types";
import { Banner, Button, ButtonLink, Card, Chip, Disclosure, Field, Meter, SimulatedChip, Textarea } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import { TerminalWindow, useServiceText } from "../studio/Frames";
import { documentFiles, documentType, kindWord, roundLead, serviceFileUrl, showKind, variantDemo } from "../studio/studioView";
import { VisionCard } from "../studio/VisionCard";
import { Correction, Question } from "./ImportQuestion";
import { ImportBudgetStop } from "./ImportPanel";
import {
  BASELINE_HASH,
  CONFIDENCE_WORDS,
  UNANSWERED_TEXT,
  answeredLine,
  effectSentence,
  needLine,
  partKey,
  partLine,
  previewLines,
  productName,
  reviewCounts,
  ruleKey,
  shownAnswer,
  shownEffect,
  spendByStep,
  targetOf,
  testsTag,
  type DraftAnswer,
  type ReviewDraft,
} from "./importView";
import "./import.css";

/** Where this browser keeps the review's answers and note until Send (QA3-F2): one key per import. */
const keptKey = (importId: string) => `orchestration.import.${importId}.review`;
type Kept = { draft: ReviewDraft; note: string };
const isAnswer = (a: unknown): a is DraftAnswer => {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return typeof x.option === "string" && (x.correction === undefined || x.correction === "change" || x.correction === "misread") && (x.text === undefined || typeof x.text === "string");
};

/** The answers and the note this browser kept for the import; none when storage is blocked or holds anything else. */
export function loadReviewDraft(importId: string): Kept {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(keptKey(importId)) ?? "null");
    if (!raw || typeof raw !== "object") return { draft: {}, note: "" };
    const { draft, note } = raw as Record<string, unknown>;
    const entries = draft && typeof draft === "object" ? Object.entries(draft) : [];
    if (typeof note !== "string" || !entries.every(([k, a]) => /^(rule|part):./.test(k) && isAnswer(a))) return { draft: {}, note: "" };
    return { draft: Object.fromEntries(entries) as ReviewDraft, note };
  } catch {
    return { draft: {}, note: "" };
  }
}

/** Keep the answers and the note in this browser, or forget them when there are none. A blocked storage keeps nothing. */
export function saveReviewDraft(importId: string, kept: Kept) {
  try {
    if (!Object.keys(kept.draft).length && !kept.note) window.localStorage.removeItem(keptKey(importId));
    else window.localStorage.setItem(keptKey(importId), JSON.stringify(kept));
  } catch {
    /* storage blocked: the answers last for this page only */
  }
}

export function ImportReview() {
  const { state, send, disabled } = useStore();
  const imp = state.studio.import!;
  // The answers you have not sent survive a reload (QA3-F2).
  const [restored] = useState(() => loadReviewDraft(imp.id));
  const [draft, setDraft] = useState<ReviewDraft>(restored.draft);
  const [note, setNote] = useState(restored.note);
  const [sending, setSending] = useState(false);
  useEffect(() => saveReviewDraft(imp.id, { draft, note }), [imp.id, draft, note]);
  const name = productName(state);
  const qs = importQuestions(imp).asked;
  const c = reviewCounts(state, draft);
  const need = needLine(c);
  const left = answeredLine(c);
  const rules = imp.reading?.rules ?? [];
  const confirmed = rules.filter((r) => ruleConfidence(imp, r).level === "confirmed");
  const parts = importParts(state);
  const simulated = state.studio.runs.some((r) => r.importStep && r.simulated);

  const set = (key: string, a: DraftAnswer | undefined) =>
    setDraft((all) => {
      const next = { ...all };
      if (a) next[key] = a;
      else delete next[key];
      return next;
    });
  const titleOf = (key: string) => {
    const rule = key.startsWith("rule:") ? rules.find((r) => r.id === key.slice(5)) : undefined;
    return rule ? ruleTitle(rule) : (parts.find((p) => p.id === key.slice(5))?.title ?? key.slice(5));
  };
  const entries = Object.entries(draft).filter(([, a]) => a.option);
  const missingWords = entries.find(([, a]) => (a.option === "neither" || a.option === "correct") && !a.text?.trim());
  // With no answer, Send sends the review with every question open (UX-3).
  const blocker = disabled ? "The service is offline. Your answers stay here until it reconnects." : missingWords ? `Write what is right for ${titleOf(missingWords[0])}.` : undefined;

  const sendAll = async () => {
    if (blocker || sending) return;
    setSending(true);
    const answers = entries.map(([key, a]) => ({ on: targetOf(key), option: a.option!, ...(a.option === "correct" ? { correction: a.correction ?? "change" } : {}), ...(a.text?.trim() ? { text: a.text.trim() } : {}) }));
    const ok = (await send("answerImport", { answers })).ok && (!note.trim() || (await send("postMessage", { text: note.trim() })).ok);
    setSending(false);
    if (!ok) return;
    saveReviewDraft(imp.id, { draft: {}, note: "" });
    setDraft({});
    setNote("");
    location.hash = BASELINE_HASH;
  };

  const conflicts = qs.filter((q) => q.kind === "conflict");
  const guesses = qs.filter((q) => q.kind === "guess");
  return (
    <div className="k-stack imp-page">
      <header className="st-head">
        <h1 className="no-margin">Vision</h1>
        <p className="small muted no-margin">
          Round 0 · <b>As it is today</b> · from the import of {name} at commit {imp.commit.slice(0, 7)} {simulated && <SimulatedChip />}
        </p>
      </header>
      <ImportBudgetStop />
      <VisionCard />
      <div className="imp-cols">
        <div className="k-stack">
          <Card className="imp-sum">
            <p className="imp-sum__line no-margin">
              <span className="imp-need">{need.need}</span>
              {need.rest}
            </p>
            <div className="imp-answered">
              <Meter used={c.questions ? c.answered / c.questions : 1} tone="done" className="imp-answered__bar" />
              <span className="small">
                {c.answered} of {c.questions} answered
              </span>
            </div>
            <ul className="imp-legend-list small muted">
              {(["conflict", "inferred", "confirmed"] as const).map((k) => (
                <li key={k}>
                  <Chip tone={CONFIDENCE_WORDS[k].tone}>{CONFIDENCE_WORDS[k].word}</Chip> {CONFIDENCE_WORDS[k].means}
                </li>
              ))}
            </ul>
            {c.notAsked > 0 && (
              <p className="small muted no-margin">
                {c.notAsked} more {c.notAsked === 1 ? "rule is" : "rules are"} not asked: a review asks at most 10 questions. They go into the baseline as the code has them, marked "not confirmed", and stay open in Vision.
              </p>
            )}
          </Card>

          {conflicts.length > 0 && (
            <section className="k-stack k-stack--tight" aria-labelledby="imp-conflicts">
              <h2 id="imp-conflicts" className="imp-grp">
                Conflicts <span className="k-count">{conflicts.length}</span>
              </h2>
              <p className="small muted no-margin">Two sources disagree, or a test fails. Which is right?</p>
              {conflicts.map((q) => (
                <Question key={q.ruleId} q={q} answer={shownAnswer(state, draft, ruleKey(q.ruleId))} onAnswer={(a) => set(ruleKey(q.ruleId), a)} />
              ))}
            </section>
          )}

          {guesses.length > 0 && (
            <section className="k-stack k-stack--tight" aria-labelledby="imp-guesses">
              <h2 id="imp-guesses" className="imp-grp">
                Inferred, important <span className="k-count">{guesses.length}</span>
              </h2>
              <p className="small muted no-margin">The reader read these from the code. No test proves them, and each changes what {name} does. Is each right?</p>
              {guesses.map((q) => (
                <Question key={q.ruleId} q={q} answer={shownAnswer(state, draft, ruleKey(q.ruleId))} onAnswer={(a) => set(ruleKey(q.ruleId), a)} />
              ))}
            </section>
          )}

          <section className="k-stack k-stack--tight" aria-labelledby="imp-listed">
            <h2 id="imp-listed" className="imp-grp">
              Listed, not asked
            </h2>
            <p className="small muted no-margin">The parts, and the rules whose tests all pass. Correct any that is wrong.</p>
            <ul className="imp-parts" aria-label="The parts">
              {parts.map((a) => (
                <li key={a.id}>
                  <PartTile part={a} answer={shownAnswer(state, draft, partKey(a.id))} onAnswer={(x) => set(partKey(a.id), x)} />
                </li>
              ))}
            </ul>
            {confirmed.length > 0 && (
              <Disclosure label={`${confirmed.length} confirmed rules, each with its passing tests`} defaultOpen className="imp-rules-d">
                <ol className="imp-rules" aria-label="Confirmed rules">
                  {confirmed.map((r) => (
                    <li key={r.id}>
                      <ConfirmedRule rule={r} answer={shownAnswer(state, draft, ruleKey(r.id))} onAnswer={(x) => set(ruleKey(r.id), x)} />
                    </li>
                  ))}
                </ol>
              </Disclosure>
            )}
          </section>

          <Card>
            <Field label="A note to the lead (optional)">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: the README is old; trust the code." />
            </Field>
            <p className="small muted no-margin">{c.answered < c.questions ? UNANSWERED_TEXT : "Your answers go into the baseline. Next, you lock it in."}</p>
          </Card>
          <div className="imp-sendbar">
            <span className="small">
              <b>{left.bold}</b> {left.rest && <span className="muted">{left.rest}</span>}
            </span>
            <Button variant="primary" disabled={!!blocker} disabledReason={blocker} showReason loading={sending} onClick={() => void sendAll()}>
              {sending ? "Sending…" : "Send to the lead"}
            </Button>
          </div>
          {imp.sentAt && (
            <Banner tone="done" title={imp.answers.length ? `${imp.answers.length} answer${imp.answers.length === 1 ? " is" : "s are"} recorded.` : "You sent the review with every question open."} actions={<ButtonLink size="small" variant="primary" href={BASELINE_HASH}>Lock in the baseline…</ButtonLink>}>
              The baseline follows your answers. You can change an answer here until you lock it in.
            </Banner>
          )}
        </div>
        <ReviewSide />
      </div>
    </div>
  );
}

/** A Correct link that opens the two choices on a listed rule or part. */
function CorrectToggle({ id, answer, onAnswer }: { id: string; answer: DraftAnswer | undefined; onAnswer: (a: DraftAnswer | undefined) => void }) {
  const { state } = useStore();
  const open = answer?.option === "correct";
  const effect = shownEffect(state, answer);
  return (
    <div className="k-stack k-stack--tight">
      <button type="button" className="imp-link" aria-expanded={open} onClick={() => onAnswer(open ? undefined : { option: "correct", correction: "change" })}>
        {open ? "Close" : "Correct"}
      </button>
      {open && <Correction name={`k-${id}`} answer={answer!} onAnswer={onAnswer} />}
      {open && <p className={cx("imp-qstate small no-margin", effect === "change" && "imp-qstate--change")}>{effectSentence(state, [], answer)}</p>}
    </div>
  );
}

function PartTile({ part: a, answer, onAnswer }: { part: StudioArtifact; answer: DraftAnswer | undefined; onAnswer: (a: DraftAnswer | undefined) => void }) {
  const { state } = useStore();
  return (
    <div className="imp-tile">
      <div className="imp-between">
        <h4 className="no-margin">{a.title}</h4>
        <span className="micro muted">{kindWord(a.kind)}</span>
      </div>
      <PartPreview part={a} />
      <p className="small no-margin">{partLine(state, a)}</p>
      <CorrectToggle id={partKey(a.id)} answer={answer} onAnswer={onAnswer} />
    </div>
  );
}

/** What a part's tile shows of it (UX-8): its recording's first lines, its pseudo-code or data, or its words. */
function PartPreview({ part: a }: { part: StudioArtifact }) {
  if (a.kind === "dictionary") {
    return (
      <ul className="imp-words" aria-label={`The words of ${a.title}`}>
        {(a.dictionary ?? []).map((w) => (
          <li key={w.term}>{w.term}</li>
        ))}
      </ul>
    );
  }
  const v = a.variants[0]?.id;
  if (showKind(a) === "terminal") {
    const demo = variantDemo(a, v);
    return demo.status === "recorded" && demo.transcript ? <MiniFile artifact={a} path={demo.transcript} kind="transcript" /> : null;
  }
  if (showKind(a) === "document") {
    const path = documentFiles(a, v).find((p) => documentType(p) !== "mermaid");
    return path ? <MiniFile artifact={a} path={path} kind="document" /> : null;
  }
  return null;
}

/** A few lines of one of the part's files (previewLines), read through the app's own service. */
function MiniFile({ artifact: a, path, kind }: { artifact: StudioArtifact; path: string; kind: "transcript" | "document" }) {
  const loaded = useServiceText(serviceFileUrl(a, path));
  const body = (
    <pre className="imp-mini" aria-label={kind === "transcript" ? `The first lines of the recording of ${a.title}` : `The start of ${a.title}`}>
      {loaded.status === "ok" ? previewLines(kind, loaded.text).join("\n") : loaded.status === "loading" ? "…" : `It cannot be read: ${loaded.message}.`}
    </pre>
  );
  return kind === "transcript" ? <TerminalWindow title={`${a.title} — recording`}>{body}</TerminalWindow> : body;
}

function ConfirmedRule({ rule, answer, onAnswer }: { rule: ImportRule; answer: DraftAnswer | undefined; onAnswer: (a: DraftAnswer | undefined) => void }) {
  const { state } = useStore();
  return (
    <div className="imp-rule">
      <span className="imp-rule__id">{rule.id}</span>
      <span className="imp-rule__text">
        <span>{rule.text}</span>
        <span className="micro muted s-mono imp-wrap">{testsTag(state, rule)}</span>
        <CorrectToggle id={ruleKey(rule.id)} answer={answer} onAnswer={onAnswer} />
      </span>
      <Chip tone="done">confirmed</Chip>
    </div>
  );
}

/** Beside the review: the lead's message for round 0, and what the import cost so far, by step. */
function ReviewSide() {
  const { state } = useStore();
  const imp = state.studio.import!;
  const lead = roundLead(state.studio.rounds.find((r) => r.n === 0));
  const sp = importSpend(state);
  const by = new Map(spendByStep(state).map((x) => [x.step, x.usd]));
  const rows: [string, number | undefined][] = [
    ["The tests and the recording · the service", 0],
    ["The rules · the reader", by.get("rules")],
    ["The parts · the designer", by.get("parts")],
    ["The words · the designer", by.get("words")],
    ["Fixes · the designer", by.get("fix")],
    ["The lead", by.get("lead")],
  ];
  return (
    <aside className="k-stack imp-side" aria-label="The lead and the import's spend">
      <Card title="The lead" as="h3">
        {lead ? (
          <p className="small no-margin imp-pre">{lead.message}</p>
        ) : (
          <p className="small muted no-margin">The lead writes the round's message and a draft of the vision. It answers your note in the conversation.</p>
        )}
      </Card>
      <Card title="The import's spend" as="h3">
        <p className="small no-margin">
          {fmtUsd(sp.usd)} of the {fmtUsd(imp.budgetUsd)} budget. The estimate was {fmtUsd(imp.estimate.usd[0])}–{fmtUsd(imp.estimate.usd[1])}.
        </p>
        <ul className="imp-spend small">
          {rows
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <span className="num">{fmtUsd(v!)}</span>
              </li>
            ))}
          <li className="imp-spend__total">
            <span>The import</span>
            <span className="num">{fmtUsd(sp.usd)}</span>
          </li>
        </ul>
        {sp.unknown.length > 0 && <p className="micro muted no-margin">{sp.unknown.length} runs recorded no cost, so the spend can be higher.</p>}
      </Card>
    </aside>
  );
}
