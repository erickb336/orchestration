import type { ReactNode } from "react";
import { cx } from "./cx";

export type StepMark = "done" | "running" | "you" | "waiting" | "skipped" | "fail";

/** The mark before a step. The state beside it is always in words, so the mark is decoration. */
export const STEP_MARK: Record<StepMark, string> = { done: "✓", running: "●", you: "!", waiting: "○", skipped: "–", fail: "✕" };
/** The mark's meaning, for screen readers. */
export const STEP_WORD: Record<StepMark, string> = { done: "done", running: "running", you: "needs you", waiting: "waiting", skipped: "skipped", fail: "failed" };

export type StepItem = {
  id: string;
  /** "Design", "Implement", "Code review". */
  name: ReactNode;
  /** Who does it: "Claude", "Codex", "the service". */
  who?: ReactNode;
  /** The state in words: "done", "no findings", "1 finding needs you", "waits for your decision", "not started". */
  state: ReactNode;
  mark: StepMark;
  /** A control for this step: "Send a note" while it runs. */
  action?: ReactNode;
};

/** A task's steps, top to bottom: mark, name, who and state in words, and an optional action. */
export function StepList({ steps, label, className }: { steps: StepItem[]; label?: string; className?: string }) {
  return (
    <ol className={cx("k-steps", className)} aria-label={label}>
      {steps.map((s) => (
        <li key={s.id} className={`k-step k-step--${s.mark}`}>
          <span className="k-step__mark" aria-hidden="true">
            {STEP_MARK[s.mark]}
          </span>
          <span className="k-step__name">
            <span className="sr-only">{STEP_WORD[s.mark]}: </span>
            {s.name}
          </span>
          <span className="k-step__state">
            {s.who !== undefined && <>{s.who} · </>}
            {s.state}
          </span>
          {s.action && <span className="k-step__action">{s.action}</span>}
        </li>
      ))}
    </ol>
  );
}
