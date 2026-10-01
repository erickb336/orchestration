// Keyboard helpers shared by Tabs, SegmentedControl and Confirm. Pure, so they are tested without a DOM.

export type Orientation = "horizontal" | "vertical" | "both";

/**
 * Where an arrow key moves the active item in a list of `count` items: wraps at both ends; Home and End jump.
 * `skip(i)` names items that cannot take focus (disabled); they are stepped over. Returns null for any other key,
 * or when every item is skipped.
 */
export function moveIndex(count: number, current: number, key: string, orientation: Orientation = "horizontal", skip: (i: number) => boolean = () => false): number | null {
  if (count <= 0) return null;
  const back = orientation === "vertical" ? ["ArrowUp"] : orientation === "both" ? ["ArrowLeft", "ArrowUp"] : ["ArrowLeft"];
  const fwd = orientation === "vertical" ? ["ArrowDown"] : orientation === "both" ? ["ArrowRight", "ArrowDown"] : ["ArrowRight"];
  let step: 1 | -1;
  let from: number;
  if (key === "Home") {
    step = 1;
    from = -1;
  } else if (key === "End") {
    step = -1;
    from = count;
  } else if (back.includes(key)) {
    step = -1;
    from = current;
  } else if (fwd.includes(key)) {
    step = 1;
    from = current;
  } else return null;
  for (let n = 1; n <= count; n++) {
    const i = (((from + step * n) % count) + count) % count;
    if (!skip(i)) return i;
  }
  return null;
}

/**
 * Where Tab moves inside a focus trap of `count` focusable items: from the last item forward to the first, from the
 * first backward to the last, and from outside the list (activeIndex -1) to the first or last. Null means the browser
 * moves focus itself, because the next item is inside the trap anyway.
 */
export function trapTabIndex(count: number, activeIndex: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return shift ? count - 1 : 0;
  if (shift && activeIndex === 0) return count - 1;
  if (!shift && activeIndex === count - 1) return 0;
  return null;
}

/** The elements inside `root` a Tab press can reach, in document order. */
export function focusables(root: ParentNode): HTMLElement[] {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");
}
