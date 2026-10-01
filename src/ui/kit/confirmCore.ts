// The in-page confirmation's logic, apart from React and the DOM, so it is tested directly.

export type ConfirmOptions = {
  /** The question, as a short sentence: "Replace all data with the sample project?" */
  title: string;
  /** What happens if they say yes, and what is kept. Line breaks are kept. */
  text?: string;
  /** The verb on the primary button. Default "OK". */
  primaryLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** A destructive action: the primary button turns red and focus starts on Cancel. */
  danger?: boolean;
  /** Where focus starts. Default: the primary button, or Cancel when `danger`. */
  initialFocus?: "primary" | "cancel";
};

export type ConfirmRequest = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

/**
 * One confirmation at a time. `ask` queues a request and resolves its promise when `settle` is called for it;
 * `onChange` receives the request to show, or null when the queue is empty.
 */
export function createConfirmQueue(onChange: (current: ConfirmRequest | null) => void) {
  const queue: ConfirmRequest[] = [];
  let seq = 0;
  return {
    ask(opts: ConfirmOptions): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        queue.push({ ...opts, id: ++seq, resolve });
        if (queue.length === 1) onChange(queue[0]);
      });
    },
    settle(ok: boolean) {
      const current = queue.shift();
      if (!current) return;
      current.resolve(ok);
      onChange(queue[0] ?? null);
    },
    get current(): ConfirmRequest | null {
      return queue[0] ?? null;
    },
  };
}

/**
 * What a key does inside a confirmation: Escape cancels; Enter accepts when focus is on the dialog itself or on its
 * text, but not on a button, a link or a text area, where Enter has its own meaning (the focused button is clicked).
 */
export function confirmKeyAction(key: string, target: { tagName?: string } | null = null): "accept" | "cancel" | null {
  if (key === "Escape") return "cancel";
  if (key === "Enter") {
    const tag = target?.tagName?.toUpperCase();
    if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA") return null;
    return "accept";
  }
  return null;
}

/** Remember what had focus; the returned function gives it back (if it still exists). */
export function rememberFocus<T extends { focus(): void }>(active: T | null | undefined): () => void {
  return () => {
    try {
      active?.focus();
    } catch {
      // The element may be gone; nothing to return focus to.
    }
  };
}

/** The native `confirm()` text for a request, used only when no ConfirmProvider is mounted. */
export function confirmFallbackText(opts: ConfirmOptions): string {
  return [opts.title, opts.text].filter(Boolean).join("\n\n");
}
