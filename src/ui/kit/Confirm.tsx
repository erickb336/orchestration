import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { confirmFallbackText, confirmKeyAction, createConfirmQueue, rememberFocus, type ConfirmOptions, type ConfirmRequest } from "./confirmCore";
import { cx } from "./cx";
import { focusables, trapTabIndex } from "./keys";

export type { ConfirmOptions } from "./confirmCore";

type Ask = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Ask | null>(null);

/** Mount once near the root. It shows one confirmation at a time, as a modal dialog. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ConfirmRequest | null>(null);
  const queue = useMemo(() => createConfirmQueue(setCurrent), []);
  return (
    <ConfirmContext.Provider value={queue.ask}>
      {children}
      {current && <ConfirmDialog key={current.id} {...current} onResolve={queue.settle} />}
    </ConfirmContext.Provider>
  );
}

let warnedNoProvider = false;

/**
 * `const confirm = useConfirm(); if (await confirm({ title: "Reset sample data?", text: "…" })) …`
 * Replaces window.confirm. Without a ConfirmProvider it falls back to window.confirm and warns once.
 */
export function useConfirm(): (opts: ConfirmOptions | string) => Promise<boolean> {
  const ask = useContext(ConfirmContext);
  return useCallback(
    (o: ConfirmOptions | string) => {
      const opts = typeof o === "string" ? { title: o } : o;
      if (ask) return ask(opts);
      if (!warnedNoProvider) {
        warnedNoProvider = true;
        console.warn("useConfirm: no ConfirmProvider is mounted; falling back to window.confirm.");
      }
      return Promise.resolve(typeof window !== "undefined" ? window.confirm(confirmFallbackText(opts)) : false);
    },
    [ask],
  );
}

export type ConfirmDialogProps = ConfirmOptions & { onResolve: (ok: boolean) => void };

/**
 * The modal confirmation: a dialog over a scrim with the question, its consequences, Cancel and the primary action.
 * Focus is trapped inside and returns to where it was; Escape cancels; Enter on the dialog accepts; the scrim cancels.
 * It renders into document.body so no ancestor's layout or containment can catch it.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (typeof document === "undefined") return null;
  return createPortal(<ConfirmModal {...props} />, document.body);
}

function ConfirmModal({ onResolve, ...opts }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const resolve = useRef(onResolve);
  resolve.current = onResolve;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const giveBack = rememberFocus(document.activeElement as HTMLElement | null);
    const start = opts.initialFocus ?? (opts.danger ? "cancel" : "primary");
    root.querySelector<HTMLElement>(`[data-confirm="${start}"]`)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      giveBack();
    };
    // Runs once per dialog: the provider keys each dialog by request id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      const items = focusables(ref.current!);
      const next = trapTabIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (next !== null) {
        e.preventDefault();
        items[next].focus();
      }
      return;
    }
    const action = confirmKeyAction(e.key, e.target as HTMLElement);
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      resolve.current(action === "accept");
    }
  };
  const onScrim = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) resolve.current(false);
  };
  return (
    <div className="k-backdrop" onMouseDown={onScrim} onKeyDown={onKeyDown}>
      <ConfirmPanel ref={ref} {...opts} onResolve={(ok) => resolve.current(ok)} />
    </div>
  );
}

/** The dialog itself, without the scrim or the behaviour: what the tests render. */
export function ConfirmPanel({ ref, title, text, primaryLabel = "OK", cancelLabel = "Cancel", danger, onResolve }: ConfirmDialogProps & { ref?: React.Ref<HTMLDivElement> }) {
  const titleId = useId();
  const textId = useId();
  return (
    <div ref={ref} className={cx("k-dialog", danger && "k-dialog--danger")} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={text ? textId : undefined} tabIndex={-1}>
      <h2 className="k-dialog__title" id={titleId}>
        {title}
      </h2>
      {text && (
        <p className="k-dialog__text" id={textId}>
          {text}
        </p>
      )}
      <div className="k-dialog__actions">
        <Button data-confirm="cancel" onClick={() => onResolve(false)}>
          {cancelLabel}
        </Button>
        <Button data-confirm="primary" variant={danger ? "danger" : "primary"} onClick={() => onResolve(true)}>
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * An in-page confirmation under the control that asked for it, for one small decision ("Cancel this task?").
 * Not modal: the page stays usable. Focus moves in (Cancel first when `danger`), Escape cancels, focus returns.
 */
export function InlineConfirm({ onResolve, title, text, primaryLabel = "OK", cancelLabel = "Cancel", danger, initialFocus }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const textId = useId();
  useEffect(() => {
    const giveBack = rememberFocus(document.activeElement as HTMLElement | null);
    const start = initialFocus ?? (danger ? "cancel" : "primary");
    ref.current?.querySelector<HTMLElement>(`[data-confirm="${start}"]`)?.focus();
    return giveBack;
    // Once, when the panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      className={cx("k-confirm-inline", danger && "k-confirm-inline--danger")}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={text ? textId : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onResolve(false);
        }
      }}
    >
      <p className="k-confirm-inline__title" id={titleId}>
        {title}
      </p>
      {text && (
        <p className="k-confirm-inline__text" id={textId}>
          {text}
        </p>
      )}
      <div className="k-actions">
        <Button data-confirm="primary" size="small" variant={danger ? "danger" : "primary"} onClick={() => onResolve(true)}>
          {primaryLabel}
        </Button>
        <Button data-confirm="cancel" size="small" variant="quiet" onClick={() => onResolve(false)}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
