import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { cx } from "./cx";

export type ToastTone = "neutral" | "done" | "fail";

export type ToastProps = {
  tone?: ToastTone;
  /** One action, usually Undo. */
  action?: ReactNode;
  onDismiss?: () => void;
  children: ReactNode;
};

const MARK: Record<ToastTone, string | null> = { neutral: null, done: "✓", fail: "!" };

/** The toast's body: the message, a mark for done or failed, an action, Dismiss. */
function ToastBody({ tone = "neutral", action, onDismiss, inline, children }: ToastProps & { inline?: boolean }) {
  const mark = MARK[tone];
  return (
    <div className={cx("k-toast", tone !== "neutral" && `k-toast--${tone}`, inline && "k-toast--inline")}>
      {mark && (
        <span className="k-toast__mark" aria-hidden="true">
          {mark}
        </span>
      )}
      <span className="k-toast__text">{children}</span>
      {action}
      {onDismiss && (
        <Button size="small" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

/**
 * A toast in the flow of the page, with its own live region: role status (polite) or, for a failure, alert.
 * Use ToastRegion for the one floating toast of a page.
 */
export function Toast(props: ToastProps) {
  const fail = props.tone === "fail";
  return (
    <div role={fail ? "alert" : "status"} aria-live={fail ? undefined : "polite"}>
      <ToastBody {...props} inline />
    </div>
  );
}

/**
 * The page's floating toast. Mount it once; it keeps a polite live region and an alert region in the DOM so a
 * message set later is announced. Renders into document.body, so no ancestor's layout can catch it.
 */
export function ToastRegion({ toast }: { toast: ToastProps | null }) {
  const fail = toast?.tone === "fail";
  const node = (
    <div className="k-toast-region">
      <div role="status" aria-live="polite">
        {toast && !fail && <ToastBody {...toast} />}
      </div>
      <div role="alert">{toast && fail && <ToastBody {...toast} />}</div>
    </div>
  );
  if (typeof document === "undefined") return node;
  return createPortal(node, document.body);
}
