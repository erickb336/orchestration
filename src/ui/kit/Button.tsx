import { useId, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "small" | "normal";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "title" | "children"> & {
  /** primary: the one main action on a screen. secondary (default): everything else. quiet: borderless. danger: destructive. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /**
   * Why it is disabled, in words. Shown as the title (tooltip) and, with `showReason`, as a line under the button.
   * A button with a reason stays in the tab order (aria-disabled) so keyboard and screen-reader users can read it.
   */
  disabledReason?: string;
  showReason?: boolean;
  /** Working: a spinner, aria-busy, and clicks are ignored. The label should say what is happening ("Pausing…"). */
  loading?: boolean;
  title?: string;
  children: ReactNode;
};

export function Button({ variant = "secondary", size = "normal", disabled, disabledReason, showReason, loading, title, className, onClick, children, type = "button", ...rest }: ButtonProps) {
  const reasonId = useId();
  const off = !!disabled || !!loading;
  const reason = disabled ? disabledReason : undefined;
  // With a reason or while loading, the button stays focusable: the tooltip and the live label must stay reachable.
  const soft = off && (!!reason || !!loading);
  const describedBy = [rest["aria-describedby"], showReason && reason ? reasonId : undefined].filter(Boolean).join(" ") || undefined;
  const button = (
    <button
      {...rest}
      type={type}
      className={cx("k-btn", variant !== "secondary" && `k-btn--${variant}`, size === "small" && "k-btn--small", loading && "k-btn--loading", className)}
      disabled={off && !soft}
      aria-disabled={soft ? true : undefined}
      aria-busy={loading ? true : undefined}
      aria-describedby={describedBy}
      title={reason ?? title}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (off) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {loading && <span className="k-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
  if (!(showReason && reason)) return button;
  return (
    <span className="k-btn-wrap">
      {button}
      <span className="k-btn-reason" id={reasonId}>
        {reason}
      </span>
    </span>
  );
}

export type ButtonLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> & { variant?: ButtonVariant; size?: ButtonSize; children: ReactNode };

/** A link that looks like a button, for actions that go somewhere ("Open", "Results"). */
export function ButtonLink({ variant = "secondary", size = "normal", className, children, ...rest }: ButtonLinkProps) {
  return (
    <a {...rest} className={cx("k-btn", variant !== "secondary" && `k-btn--${variant}`, size === "small" && "k-btn--small", className)}>
      {children}
    </a>
  );
}

/** A row of actions; `end` right-aligns them. */
export function Actions({ end, className, children }: { end?: boolean; className?: string; children: ReactNode }) {
  return <div className={cx("k-actions", end && "k-actions--end", className)}>{children}</div>;
}
