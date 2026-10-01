import type { ReactNode } from "react";
import { cx } from "./cx";

/** The four state hues, and neutral for everything else. Colour is used for meaning only. */
export type Tone = "neutral" | "work" | "you" | "done" | "fail";

/** A small label: an area, a flow, a count, a provider. Never the main state of a thing (that is StatePill). */
export function Chip({ tone = "neutral", strong, title, className, children }: { tone?: Tone; strong?: boolean; title?: string; className?: string; children: ReactNode }) {
  return (
    <span className={cx("k-chip", tone !== "neutral" && `k-chip--${tone}`, strong && "k-chip--strong", className)} title={title}>
      {children}
    </span>
  );
}

export const SIMULATED_TITLE = "Simulated: no agents ran and nothing left this computer.";

/**
 * The one way the demo says "simulated" (rule 5): a dashed chip, once per thing that could pass for real.
 * `title` can say what exactly was simulated ("Simulated pull request: nothing was sent to GitHub.").
 */
export function SimulatedChip({ title = SIMULATED_TITLE, className }: { title?: string; className?: string }) {
  return (
    <span className={cx("k-chip", "k-chip--sim", className)} title={title}>
      simulated
    </span>
  );
}
