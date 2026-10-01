import { useId, type ReactNode } from "react";
import { cx } from "./cx";

export type CardProps = {
  title?: ReactNode;
  /** The heading level of the title. Default h2. */
  as?: "h2" | "h3" | "h4";
  /** How many things are inside ("Needs you 3"). */
  count?: number;
  /** "you" colours the count: these things wait for the person. */
  countTone?: "neutral" | "you";
  /** Buttons at the head's right. */
  actions?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
};

/** A card: a title with an optional count and actions, then a body. One card per thing. */
export function Card({ title, as: Heading = "h2", count, countTone = "neutral", actions, id, className, children }: CardProps) {
  const autoId = useId();
  const titleId = `${id ?? autoId}-title`;
  return (
    <section className={cx("k-card", className)} id={id} aria-labelledby={title ? titleId : undefined}>
      {(title || actions) && (
        <div className="k-card__head">
          {title && (
            <Heading className="k-card__title" id={titleId}>
              {title}
              {count !== undefined && <span className={cx("k-count", countTone === "you" && "k-count--you")}>{count}</span>}
            </Heading>
          )}
          {actions && <div className="k-card__actions k-actions">{actions}</div>}
        </div>
      )}
      <div className="k-card__body">{children}</div>
    </section>
  );
}
