// A pop-up (a menu's list) stays inside the window. A menu's list hangs from its button's right edge, which is right
// while the button sits at the right of the window. On a phone the header and a task's actions wrap, the button lands
// at the left, and the list ran past the left edge (ORC-030 QA, Q-02: "Resume project" could not be read at 375 wide).
// So each time a list opens, and when the window's width changes while it is open, it moves sideways just enough.

import { useLayoutEffect, type RefObject } from "react";

/** The space kept between a pop-up and the window's edge, in pixels. */
export const WINDOW_MARGIN = 8;

/**
 * How far to move a box sideways (pixels; positive is to the right) so it sits inside a window `width` wide, `margin`
 * from each edge. A box wider than the room keeps its left edge in. Pure.
 */
export function shiftIntoWindow(box: { left: number; right: number }, width: number, margin = WINDOW_MARGIN): number {
  if (box.left < margin) return margin - box.left;
  if (box.right > width - margin) return Math.max(width - margin - box.right, margin - box.left);
  return 0;
}

/** Move a shown pop-up inside the window: measured at its own place, then moved with `translate`. */
export function placeInWindow(el: HTMLElement) {
  el.style.translate = "";
  const shift = shiftIntoWindow(el.getBoundingClientRect(), document.documentElement.clientWidth);
  if (shift) el.style.translate = `${Math.round(shift)}px 0`;
}

/** Keep the element in `ref` inside the window while `open` (a pop-up React shows; a native details uses `placeInWindow`). */
export function useInWindow(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const place = () => placeInWindow(el);
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [ref, open]);
}
