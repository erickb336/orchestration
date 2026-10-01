import type { ReactNode } from "react";
import { cx } from "./cx";

export type SideNavItem = { id: string; label: ReactNode; href?: string; count?: number };

export type SideNavProps = {
  items: SideNavItem[];
  current: string;
  /** For items without an href. */
  onSelect?: (id: string) => void;
  /** What the sections are: "Settings sections". */
  label: string;
  className?: string;
};

/** The sections of a page, down the side; a horizontal scroller when there is no side (phones, drawers). */
export function SideNav({ items, current, onSelect, label, className }: SideNavProps) {
  return (
    <nav aria-label={label} className={cx("k-sidenav", className)}>
      {items.map((it) =>
        it.href ? (
          <a key={it.id} className="k-sidenav__link" href={it.href} aria-current={current === it.id ? "page" : undefined}>
            {it.label}
            {it.count !== undefined && <span className="k-count">{it.count}</span>}
          </a>
        ) : (
          <button key={it.id} type="button" className="k-sidenav__link" aria-current={current === it.id ? "true" : undefined} onClick={() => onSelect?.(it.id)}>
            {it.label}
            {it.count !== undefined && <span className="k-count">{it.count}</span>}
          </button>
        ),
      )}
    </nav>
  );
}

/** A SideNav beside its content; one column when narrow. */
export function SideNavLayout({ nav, className, children }: { nav: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cx("k-side", className)}>
      {nav}
      <div className="k-side__main">{children}</div>
    </div>
  );
}
