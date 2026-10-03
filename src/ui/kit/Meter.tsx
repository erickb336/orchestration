import type { Tone } from "./Chip";
import { cx } from "./cx";

/** A share from 0 to 1. */
const share = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
/** "20%", to two decimals. */
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

export type MeterProps = {
  /** What is used, as a share of the whole (0 to 1; more is shown full). */
  used: number;
  /** What is expected on top of it, as a share of the whole: a lighter, hatched segment after the used one. */
  more?: number;
  /** The used segment's colour: "work" while within it, "you" when it waits for the person (a budget stop). */
  tone?: Tone;
  /**
   * The bar in words, for those who cannot see it: "$8.10 of $40 spent". Leave it out only where the figure beside the
   * bar says the same in words: the bar is then hidden from assistive technology.
   */
  label?: string;
  className?: string;
};

/**
 * A figure as a bar: what is used of a whole, and what is expected on top of it. It goes with the figure in words and
 * never stands alone. Used for the budgets on Home (ORC-030 a-home-budgets).
 */
export function Meter({ used, more = 0, tone = "work", label, className }: MeterProps) {
  const u = share(used);
  const m = Math.min(share(more), 1 - u);
  return (
    <span className={cx("k-meter", className)} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {u > 0 && <span className={cx("k-meter__used", `k-meter__used--${tone}`)} style={{ width: pct(u) }} />}
      {m > 0 && <span className="k-meter__more" style={{ width: pct(m) }} />}
    </span>
  );
}
