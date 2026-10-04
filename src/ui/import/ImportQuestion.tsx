// One question of the import's review (ORC-032): its sources, its options and what your answer does, with "Correct"
// and its two choices (C15). The review asks it (ImportReview.tsx); after the baseline, Vision asks the ones still open
// (AfterBaseline.tsx). Words: importView.ts.

import type { ImportQuestion } from "../../domain/studio/import";
import { Field, Textarea, Chip } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import { CONFIDENCE_WORDS, CORRECTIONS, effectSentence, optionWords, productName, ruleOf, shownEffect, sourceRow, type DraftAnswer } from "./importView";

/** One question: its sources, its options, and what your answer does. In the review, and in Vision after the baseline. */
export function Question({ q, answer, onAnswer }: { q: ImportQuestion; answer: DraftAnswer | undefined; onAnswer: (a: DraftAnswer | undefined) => void }) {
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
          {q.title}
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
export function Correction({ name, answer, onAnswer }: { name: string; answer: DraftAnswer; onAnswer: (a: DraftAnswer) => void }) {
  const { state } = useStore();
  return (
    <fieldset className="imp-correct">
      <legend className="sr-only">What is wrong</legend>
      {CORRECTIONS(productName(state), !!state.studio.import?.lockedInAt).map((c) => (
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
