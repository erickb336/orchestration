// Review (ORC-032, screen 3), in Vision once the reading is done: round 0, As it is today (C9). It asks only the
// conflicts and the important guesses, at most 10, conflicts first (Q4); the confirmed rules and the parts are listed,
// not asked (C8), and "Correct" offers its two choices on any of them (C15). Your answers wait here until Send, which
// records them together (answerImport) and opens the baseline. Words: importView.ts.

import { useState } from "react";
import { fmtUsd, importSpend } from "../../domain/spend";
import { importParts, importQuestions, ruleConfidence, type ImportQuestion } from "../../domain/studio/import";
import type { ImportRule, StudioArtifact } from "../../domain/studio/types";
import { Banner, Button, ButtonLink, Card, Chip, Disclosure, Field, Meter, SimulatedChip, Textarea } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import { TerminalWindow, useServiceText } from "../studio/Frames";
import { documentFiles, documentType, kindWord, roundLead, serviceFileUrl, showKind, variantDemo } from "../studio/studioView";
import { VisionCard } from "../studio/VisionCard";
import { ImportBudgetStop } from "./ImportPanel";
import {
  BASELINE_HASH,
  CONFIDENCE_WORDS,
  CORRECTIONS,
  UNANSWERED_TEXT,
  answeredLine,
  effectSentence,
  needLine,
  optionWords,
  partKey,
  partLine,
  previewLines,
  productName,
  reviewCounts,
  ruleKey,
  ruleOf,
  shownAnswer,
  shownEffect,
  sourceRow,
  spendByStep,
  targetOf,
  testsTag,
  type DraftAnswer,
  type ReviewDraft,
} from "./importView";
import "./import.css";

export function ImportReview() {
  const { state, send, disabled } = useStore();
  const [draft, setDraft] = useState<ReviewDraft>({});
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const imp = state.studio.import!;
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
  const titleOf = (key: string) => (key.startsWith("rule:") ? (rules.find((r) => r.id === key.slice(5))?.area ?? key.slice(5)) : (parts.find((p) => p.id === key.slice(5))?.title ?? key.slice(5)));
  const entries = Object.entries(draft).filter(([, a]) => a.option);
  const missingWords = entries.find(([, a]) => (a.option === "neither" || a.option === "correct") && !a.text?.trim());
  const blocker = disabled ? "The service is offline. Your answers stay here until it reconnects." : missingWords ? `Write what is right for ${titleOf(missingWords[0])}.` : !entries.length && !note.trim() ? "Answer a question, correct an item, or write a note first." : undefined;

  const sendAll = async () => {
    if (blocker || sending) return;
    setSending(true);
    const answers = entries.map(([key, a]) => ({ on: targetOf(key), option: a.option!, ...(a.option === "correct" ? { correction: a.correction ?? "change" } : {}), ...(a.text?.trim() ? { text: a.text.trim() } : {}) }));
    const ok = (!answers.length || (await send("answerImport", { answers })).ok) && (!note.trim() || (await send("postMessage", { text: note.trim() })).ok);
    setSending(false);
    if (!ok) return;
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
            <Button variant="primary" disabled={!!blocker} disabledReason={blocker} loading={sending} onClick={() => void sendAll()}>
              {sending ? "Sending…" : "Send to the lead"}
            </Button>
          </div>
          {imp.answers.length > 0 && (
            <Banner tone="done" title={`${imp.answers.length} answer${imp.answers.length === 1 ? " is" : "s are"} recorded.`} actions={<ButtonLink size="small" variant="primary" href={BASELINE_HASH}>Lock in the baseline…</ButtonLink>}>
              The baseline follows your answers. You can change an answer here until you lock it in.
            </Banner>
          )}
        </div>
        <ReviewSide />
      </div>
    </div>
  );
}

/** One question: its sources, its options, and what your answer does. */
function Question({ q, answer, onAnswer }: { q: ImportQuestion; answer: DraftAnswer | undefined; onAnswer: (a: DraftAnswer | undefined) => void }) {
  const { state } = useStore();
  const rule = ruleOf(state, q.ruleId)!;
  const opts = optionWords(state, q.options);
  const effect = shownEffect(state, answer);
  const sentence = effectSentence(state, q.options, answer);
  const conf = CONFIDENCE_WORDS[q.confidence.level];
  const choose = (id: string) => onAnswer(answer?.option === id ? undefined : { option: id, ...(id === "correct" ? { correction: "change" as const } : {}) });
  return (
    <article className={cx("imp-q", effect !== "open" && "imp-q--answered")} aria-labelledby={`imp-q-${rule.id}`}>
      <div className="imp-q__head">
        <Chip tone={conf.tone}>{conf.word}</Chip>
        <h3 id={`imp-q-${rule.id}`} className="no-margin">
          {rule.area}
        </h3>
        <span className="micro muted s-mono">{rule.id}</span>
      </div>
      <p className="no-margin">{rule.text}</p>
      {rule.important && <p className="small muted no-margin">{rule.important}</p>}
      <ul className="imp-src" aria-label="Its sources">
        {rule.sources.map((x, i) => {
          const row = sourceRow(state, rule, x);
          return (
            <li key={i}>
              <span className="imp-src__where">{row.where}</span>
              <span>{row.says}</span>
            </li>
          );
        })}
        {!rule.tests.length && (
          <li>
            <span className="imp-src__where">Tests</span>
            <span>No test covers it.</span>
          </li>
        )}
      </ul>
      {q.kind === "conflict" ? (
        <>
          <p className="imp-ask no-margin">Which is right?</p>
          <div className="imp-opts">
            {opts.map((o) => (
              <button key={o.id} type="button" className="imp-opt" aria-pressed={answer?.option === o.id} onClick={() => choose(o.id)}>
                <b>{o.label}</b>
                <span>{o.detail}</span>
              </button>
            ))}
          </div>
          {answer?.option === "neither" && (
            <Field label="What is right?">
              <Textarea value={answer.text ?? ""} onChange={(e) => onAnswer({ ...answer, text: e.target.value })} />
            </Field>
          )}
        </>
      ) : (
        <>
          <div className="imp-opts imp-opts--inline">
            {opts.map((o) => (
              <button key={o.id} type="button" className="imp-opt" aria-pressed={answer?.option === o.id} onClick={() => choose(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          {answer?.option === "correct" && <Correction name={`k-${rule.id}`} answer={answer} onAnswer={onAnswer} />}
        </>
      )}
      <p className={cx("imp-qstate small no-margin", effect === "change" && "imp-qstate--change")} aria-live="polite">
        {sentence}
      </p>
    </article>
  );
}

/** "Correct": its two choices (C15) and your words. */
function Correction({ name, answer, onAnswer }: { name: string; answer: DraftAnswer; onAnswer: (a: DraftAnswer) => void }) {
  const { state } = useStore();
  return (
    <fieldset className="imp-correct">
      <legend className="sr-only">What is wrong</legend>
      {CORRECTIONS(productName(state)).map((c) => (
        <label key={c.value} className="k-check">
          <input type="radio" className="k-check__box" name={name} value={c.value} checked={(answer.correction ?? "change") === c.value} onChange={() => onAnswer({ ...answer, correction: c.value })} />
          <span className="k-check__text">
            {c.label}
            <span className="k-check__hint">{c.hint}</span>
          </span>
        </label>
      ))}
      <Field label="What is right?">
        <Textarea value={answer.text ?? ""} onChange={(e) => onAnswer({ ...answer, text: e.target.value })} />
      </Field>
    </fieldset>
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
