// ORC-009: the Lead panel reachable from every page. On desktop a non-modal aside that stays open while
// the user moves around the board; below 768 px a modal dialog with a focus trap. The Overview keeps
// its inline conversation, so the shell scrolls to that instead of opening a second copy.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Conversation } from "./Conversation";

export interface LeadContext {
  /** The task a message is about ("Ask the lead about this task"). */
  taskId?: string;
  /** A composer placeholder, for example from the board's Steer button. */
  placeholder?: string;
}

export interface LeadDrawerApi {
  open: boolean;
  context: LeadContext;
  /** Open the panel (or, on the Overview, focus the inline conversation) with an optional context. */
  openLead: (ctx?: LeadContext) => void;
  closeLead: () => void;
  clearContext: () => void;
}

const noop: LeadDrawerApi = { open: false, context: {}, openLead: () => {}, closeLead: () => {}, clearContext: () => {} };
export const LeadDrawerContext = createContext<LeadDrawerApi>(noop);

export function useLeadContext(): LeadDrawerApi {
  return useContext(LeadDrawerContext);
}

function useNarrow(query = "(max-width: 767px)") {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!("matchMedia" in window)) return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The panel itself. Rendered by the shell when open and not on the Overview. */
export function LeadDrawer({ onClose }: { onClose: () => void }) {
  const narrow = useNarrow();
  const ref = useRef<HTMLElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (!narrow || e.key !== "Tab" || !ref.current) return;
    // A modal dialog keeps focus inside it.
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <>
      {narrow && <div className="lead-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside ref={ref} className={`lead-drawer${narrow ? " modal" : ""}`} aria-label="Lead" role={narrow ? "dialog" : undefined} aria-modal={narrow ? true : undefined} onKeyDown={onKeyDown}>
        <Conversation variant="drawer" onClose={onClose} focusOnMount />
      </aside>
    </>
  );
}
