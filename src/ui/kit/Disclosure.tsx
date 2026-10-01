import type { ReactNode, SyntheticEvent } from "react";
import { cx } from "./cx";

export type DisclosureProps = {
  /** What is inside, as a noun: "Details", "Spec and options", "Why it's ready". */
  label: ReactNode;
  /** How many things are inside. */
  count?: number;
  /** Controlled open state; or `defaultOpen` for an uncontrolled one. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  /** Sits in running text ("… 3 files. Show changes"). */
  inline?: boolean;
  className?: string;
  children: ReactNode;
};

/** Details behind a summary (the rest is a click away). Native details/summary, so it is keyboard-operable as is. */
export function Disclosure({ label, count, open, defaultOpen, onToggle, inline, className, children }: DisclosureProps) {
  return (
    <details className={cx("k-disc", inline && "k-disc--inline", className)} open={open ?? defaultOpen} onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => onToggle?.(e.currentTarget.open)}>
      <summary className="k-disc__summary">
        {label}
        {count !== undefined && <span className="k-count">{count}</span>}
      </summary>
      <div className="k-disc__body">{children}</div>
    </details>
  );
}
