// ORC-025 pass 5 (S5): one way of saving. Each Settings section edits a draft and saves it with one button.
// The draft holds only what the person changed; every other field follows the live value, so a change made
// elsewhere (another tab, the lead, the service) still shows, and the person's own edits are never overwritten.

import { useCallback, useEffect, useState } from "react";
import type { SendResult } from "../store";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields whose edit differs from the live value. */
export function changedKeys<T extends object>(live: T, edits: Partial<T>): (keyof T)[] {
  return (Object.keys(edits) as (keyof T)[]).filter((k) => !same(edits[k], live[k]));
}

/** The edits without those that now equal the live value (it caught up, or the person typed it back). */
export function pruneEdits<T extends object>(live: T, edits: Partial<T>): Partial<T> {
  const keep = new Set(changedKeys(live, edits));
  return Object.fromEntries(Object.entries(edits).filter(([k]) => keep.has(k as keyof T))) as Partial<T>;
}

export type Draft<T extends object> = {
  /** The live values with the person's edits on top: what the controls show. */
  value: T;
  /** The fields that differ from the live value. */
  changed: ReadonlySet<keyof T>;
  dirty: boolean;
  set: (patch: Partial<T>) => void;
  /** Drop every edit (Discard, or after a save). */
  reset: () => void;
};

export function useDraft<T extends object>(live: T): Draft<T> {
  const [edits, setEdits] = useState<Partial<T>>({});
  const liveKey = JSON.stringify(live);
  // An edit that equals the live value is no edit: drop it, so it does not pin a stale value later.
  useEffect(() => {
    setEdits((e) => (changedKeys(live, e).length === Object.keys(e).length ? e : pruneEdits(live, e)));
    // The live object is rebuilt on every render; its serialised form is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);
  const changed = new Set(changedKeys(live, edits));
  const set = useCallback((patch: Partial<T>) => setEdits((e) => ({ ...e, ...patch })), []);
  const reset = useCallback(() => setEdits({}), []);
  return { value: { ...live, ...edits }, changed, dirty: changed.size > 0, set, reset };
}

/**
 * Send a section's commands one after another, stopping at the first that fails. The store shows the
 * failure; what was not saved stays in the draft, still marked unsaved.
 */
export async function sendInOrder(steps: (() => Promise<SendResult> | null)[]): Promise<boolean> {
  for (const step of steps) {
    const r = await step();
    if (r && !r.ok) return false;
  }
  return true;
}

/** A whole number in [lo, hi], from a field's text; undefined when it is not one. */
export function intIn(text: string, lo: number, hi: number): number | undefined {
  if (!/^\s*-?\d+\s*$/.test(text)) return undefined;
  const n = Number(text);
  return n >= lo && n <= hi ? n : undefined;
}

/** A number in [lo, hi] (decimals allowed), from a field's text. */
export function numIn(text: string, lo: number, hi: number): number | undefined {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}
