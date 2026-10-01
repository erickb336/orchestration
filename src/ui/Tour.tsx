// ORC-017 §4: the first-run tour, on driver.js. Demo only. It starts once on the first visit to the
// Overview, is replayed from the header's Tour button, and records "done" per browser (see tour.ts).
// Skip, Esc and Done all mark it done. Keyboard: arrows, Enter, Esc. Reduced motion turns the animation off.

import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { useCallback, useEffect, useRef } from "react";
import { browserStore, createTourGate, demoLandingRedirect } from "./tourState";

/** One gate per page load. */
const gate = createTourGate(browserStore);

/** The stops, anchored on `data-tour` attributes. The last one has no anchor: a centred popover. */
const STOPS: { anchor?: string; title: string; text: string }[] = [
  { anchor: "demo-bar", title: "This is a demo", text: "Every run is simulated: no agents run, and nothing touches your code or GitHub." },
  { anchor: "progress", title: "Progress by area", text: "Each part of the product, how far along it is, and which agent is on it right now." },
  { anchor: "needs-you", title: "Only what needs you", text: "A pull request to merge, an option to choose, a finding to decide." },
  { anchor: "tab-tasks", title: "Tasks", text: "Every task has a spec, a pipeline and a truthful state. Claude and Codex agents work on different tasks at the same time." },
  { anchor: "lead", title: "The lead", text: "Message the lead from any page. It can change the focus or defer work, and every change has an Undo." },
  { anchor: "tab-results", title: "Results", text: "What landed waits here for you to look at, at your own pace. Send it back if it is wrong." },
  { title: "Explore", text: "Open any task to see its pipeline: provider and model per step, Pause and Resume. Replay this tour from Tour." },
];

const reducedMotion = () => typeof window !== "undefined" && "matchMedia" in window && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let active: Driver | null = null;

/** Start the tour now. Ends any copy already running. `onEnd` runs when it is skipped or finished. */
export function startTour(onEnd?: () => void) {
  active?.destroy();
  const d = driver({
    steps: STOPS.map((s) => ({
      ...(s.anchor ? { element: `[data-tour="${s.anchor}"]` } : {}),
      popover: { title: s.title, description: s.text, side: s.anchor === "demo-bar" ? "bottom" : "bottom", align: "start" },
    })),
    animate: !reducedMotion(),
    smoothScroll: !reducedMotion(),
    overlayColor: "#000",
    overlayOpacity: 0.45,
    stagePadding: 6,
    stageRadius: 8,
    showProgress: true,
    progressText: "{{current}} of {{total}}",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Start exploring",
    popoverClass: "orc-tour",
    // Anchors render with the Overview; the Tour button may start it from another page right after a navigation.
    waitForElement: 1500,
    skipMissingElement: true,
    onPopoverRender: (popover) => {
      popover.closeButton.textContent = "Skip";
      popover.closeButton.setAttribute("aria-label", "Skip the tour");
    },
    // Skip, Esc, a click outside and "Start exploring" all arrive here. driver.js calls onDestroyed only while it
    // still holds a highlighted element, which a re-render of the Overview can take away, so the end is handled
    // here: record it, close the tour (destroy() skips this hook), then hand focus back.
    onDestroyStarted: () => {
      gate.markDone();
      d.destroy();
      if (active === d) active = null;
      onEnd?.();
    },
  });
  active = d;
  d.drive();
}

/**
 * The auto start: on the Overview, in the demo, once per browser (or once per page load when storage is
 * blocked). It waits a moment so the Overview's anchors exist.
 */
export function useFirstRunTour(demo: boolean, onOverview: boolean, returnFocus: () => void) {
  // In the demo the bare address opens the Overview, where Progress by area and the tour live; a link to any page is left alone.
  useEffect(() => {
    const to = demoLandingRedirect(demo, location.hash);
    if (to) location.replace(to);
  }, [demo]);
  useEffect(() => {
    if (!demo || !onOverview || !gate.shouldAutoStart(demo)) return;
    const id = window.setTimeout(() => startTour(returnFocus), 400);
    return () => window.clearTimeout(id);
    // Runs once: the gate never says yes twice in one load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, onOverview]);
}

/** The header's Tour button (demo only). Replays the tour from the Overview; focus comes back here when it ends. */
export function TourButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const start = useCallback(() => {
    const onOverview = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] === "overview";
    if (!onOverview) location.hash = "#/overview";
    // After a navigation the Overview needs a frame to render its anchors; driver.js also waits for them.
    window.setTimeout(() => startTour(() => ref.current?.focus()), onOverview ? 0 : 120);
  }, []);
  return (
    <button ref={ref} onClick={start} title="A short tour of the demo: progress, what needs you, the board, the lead and Results">
      Tour
    </button>
  );
}
