import type { ReactNode } from "react";
import { cx } from "./cx";

/** Nothing here yet, said plainly: what would appear, and how to make it appear. */
export function EmptyState({ title, action, className, children }: { title: ReactNode; action?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={cx("k-empty", className)}>
      <p className="k-empty__title">{title}</p>
      {children && <p className="k-empty__text">{children}</p>}
      {action && <div className="k-actions">{action}</div>}
    </div>
  );
}
