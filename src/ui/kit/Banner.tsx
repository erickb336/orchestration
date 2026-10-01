import type { ReactNode } from "react";
import { cx } from "./cx";

export type BannerTone = "you" | "info" | "fail" | "done";

/**
 * A message that spans the content: something needs you (amber), something to know (neutral), something failed (red),
 * something finished (green). A failure is announced at once (role alert); the rest politely (role status).
 */
export function Banner({ tone = "info", title, actions, role, className, children }: { tone?: BannerTone; title?: ReactNode; actions?: ReactNode; role?: "status" | "alert" | "none"; className?: string; children?: ReactNode }) {
  const r = role ?? (tone === "fail" ? "alert" : "status");
  return (
    <div className={cx("k-banner", `k-banner--${tone}`, className)} role={r === "none" ? undefined : r}>
      <div className="k-banner__main">
        {title && <p className="k-banner__title">{title}</p>}
        {children && <div className="k-banner__text">{children}</div>}
      </div>
      {actions && <div className="k-banner__actions k-actions">{actions}</div>}
    </div>
  );
}
