import type { ReactNode } from "react";
import type { Tone } from "./Chip";
import { cx } from "./cx";

/**
 * The state of a thing, in words, with a dot in the state's colour. The dot pulses only while agents work
 * (`pulse` with tone "work"); a pause shows a two-bar mark instead of the dot. Colour never stands alone.
 * With `href` it is a link to the place whose state it says (the header's Vision and Factory).
 */
export function StatePill({ tone, pulse, paused, title, href, className, children }: { tone: Tone; pulse?: boolean; paused?: boolean; title?: string; href?: string; className?: string; children: ReactNode }) {
  const cls = cx("k-pill", `k-pill--${tone}`, paused && "k-pill--paused", pulse && tone === "work" && "k-pill--pulse", href && "k-pill--link", className);
  const body = (
    <>
      {paused ? (
        <svg className="k-pill__pause" viewBox="0 0 8 9" aria-hidden="true" focusable="false">
          <rect x="0.5" y="0.5" width="2.4" height="8" rx="0.6" fill="currentColor" />
          <rect x="5.1" y="0.5" width="2.4" height="8" rx="0.6" fill="currentColor" />
        </svg>
      ) : (
        <span className="k-pill__dot" aria-hidden="true" />
      )}
      {href ? <span className="k-pill__text">{children}</span> : children}
    </>
  );
  return href ? (
    <a className={cls} href={href} title={title}>
      {body}
    </a>
  ) : (
    <span className={cls} title={title}>
      {body}
    </span>
  );
}
