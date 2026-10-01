import type { ReactNode } from "react";
import { SimulatedChip } from "./Chip";
import { cx } from "./cx";

export type RowProps = {
  /** A task id in front of the title, in the mono face. */
  id?: string;
  title: ReactNode;
  /** Makes the title a link. */
  href?: string;
  /** The second line: when, who, what state. */
  meta?: ReactNode;
  /** Buttons on the right; they move under the text when the row is narrow. */
  actions?: ReactNode;
  as?: "div" | "li";
  className?: string;
  children?: ReactNode;
};

/** One item in a list: main text, a meta line, actions on the right. */
export function Row({ id, title, href, meta, actions, as: Tag = "div", className, children }: RowProps) {
  return (
    <Tag className={cx("k-row", className)}>
      <div className="k-row__main">
        <div className="k-row__title">
          {id && <span className="k-row__id">{id}</span>}
          {href ? <a href={href}>{title}</a> : title}
        </div>
        {meta && <div className="k-row__meta">{meta}</div>}
        {children}
      </div>
      {actions && <div className="k-row__actions">{actions}</div>}
    </Tag>
  );
}

/** The list rows sit in. It is a size container: rows stack when the list is narrow, wherever it is. */
export function Rows({ as: Tag = "ul", label, className, children }: { as?: "ul" | "ol" | "div"; label?: string; className?: string; children: ReactNode }) {
  return (
    <Tag className={cx("k-rows", className)} aria-label={label}>
      {children}
    </Tag>
  );
}

export type NeedsYouItemProps = {
  taskId: string;
  title: ReactNode;
  /** Where the task page is. */
  href?: string;
  /** What is needed, as a short phrase ending in a colon: "Decide a finding:", "Choose an approach:", "Ready to merge:". */
  what: ReactNode;
  /** The question or the choices, after `what`. */
  detail?: ReactNode;
  /** The decision can be taken here. */
  actions?: ReactNode;
  /** The thing that waits is simulated (a demo pull request): one chip says so. */
  simulated?: boolean;
  as?: "div" | "li";
  /** Under the meta line: a small form a decision needs first (a reason for an override). */
  children?: ReactNode;
};

/** One thing that needs the person: the task, what is needed, and the actions that settle it, in place. */
export function NeedsYouItem({ taskId, title, href, what, detail, actions, simulated, as = "li", children }: NeedsYouItemProps) {
  return (
    <Row
      as={as}
      id={taskId}
      title={title}
      href={href}
      actions={actions}
      meta={
        <>
          <span className="k-row__what">{what}</span>
          {detail && <span>{detail}</span>}
          {simulated && <SimulatedChip />}
        </>
      }
    >
      {children}
    </Row>
  );
}
