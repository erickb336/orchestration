// The first-run tour, on driver.js. Demo only. It starts once on the first visit to Home,
// is replayed from the demo bar's Simulation menu, and records "done" per browser (see
// tourState.ts, which also holds the stops). A stop on another page opens that page first. Skip, Esc and the
// last stop's button all mark it done; finishing the last stop goes back to Home. Keyboard: arrows, Enter, Esc.
// Reduced motion turns the animation off.

import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { useCallback, useEffect } from "react";
import { Button } from "./kit";
import { TOUR_STOPS, browserStore, createTourGate, demoLandingRedirect, tourNeedsNavigation } from "./tourState";

/** The Simulation menu's own button, where focus returns when the tour ends. */
export const SIM_MENU_BUTTON_ID = "sim-menu-button";
export const focusSimMenu = () => document.getElementById(SIM_MENU_BUTTON_ID)?.focus();

const HOME = "#/overview";

/** One gate per page load. */
const gate = createTourGate(browserStore);

const reducedMotion = () => typeof window !== "undefined" && "matchMedia" in window && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let active: Driver | null = null;

/** Open the stop's page when it is not the one shown, then move there; driver.js waits for the stop's element. */
function goTo(d: Driver, index: number) {
  const stop = TOUR_STOPS[index];
  if (tourNeedsNavigation(location.hash, stop, !!document.querySelector(stop.element))) location.hash = stop.page!;
  d.moveTo(index);
}

/** Start the tour now. Ends any copy already running. `onEnd` runs when it is skipped or finished. */
export function startTour(onEnd?: () => void) {
  active?.destroy();
  let finished = false;
  // Record it, close the tour (destroy() skips onDestroyStarted), and hand focus back. Finishing the last stop
  // goes back to Home, where the demo starts; a skip leaves you where you are.
  const end = (completed: boolean) => {
    if (finished) return;
    finished = true;
    gate.markDone();
    d.destroy();
    if (active === d) active = null;
    if (completed && location.hash !== HOME) location.hash = HOME;
    onEnd?.();
  };
  const d = driver({
    steps: TOUR_STOPS.map((s) => ({ element: s.element, popover: { title: s.title, description: s.text, side: "bottom", align: s.align ?? "start" } })),
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
    // A stop on another page waits for that page to render its element; one that never appears shows centred.
    // Nothing is skipped: driver.js would count a stop on another page as missing and label Next as the end.
    waitForElement: 3000,
    skipMissingElement: false,
    // A scroll during the move to a stop (back up to the header, say) places the popover against the previous
    // stop's element; once the move has finished, place it again against this one.
    onHighlighted: () => {
      window.requestAnimationFrame(() => {
        if (active === d) d.refresh();
      });
    },
    onPopoverRender: (popover) => {
      popover.closeButton.textContent = "Skip";
      popover.closeButton.setAttribute("aria-label", "Skip the tour");
    },
    // Next, Back and the arrow keys arrive here, so a stop on another page can open it first.
    onNextClick: () => {
      const i = d.getActiveIndex() ?? 0;
      if (i >= TOUR_STOPS.length - 1) end(true);
      else goTo(d, i + 1);
    },
    onPrevClick: () => {
      const i = d.getActiveIndex() ?? 0;
      if (i > 0) goTo(d, i - 1);
    },
    // Skip, Esc and a click outside arrive here. driver.js calls onDestroyed only while it still holds a
    // highlighted element, which a re-render can take away, so the end is handled here.
    onDestroyStarted: () => end(false),
  });
  active = d;
  if (tourNeedsNavigation(location.hash, TOUR_STOPS[0], !!document.querySelector(TOUR_STOPS[0].element))) location.hash = TOUR_STOPS[0].page!;
  d.drive();
}

/**
 * The auto start: on Home, in the demo, once per browser (or once per page load when storage is blocked). It
 * waits a moment so Home's anchors exist. Focus lands on the Simulation menu's button when the tour ends.
 */
export function useFirstRunTour(demo: boolean, onHome: boolean) {
  // In the demo the bare address opens Home, where Progress by area and the tour live; a link to any page is left alone.
  useEffect(() => {
    const to = demoLandingRedirect(demo, location.hash);
    if (to) location.replace(to);
  }, [demo]);
  useEffect(() => {
    if (!demo || !onHome || !gate.shouldAutoStart(demo)) return;
    const id = window.setTimeout(() => startTour(focusSimMenu), 400);
    return () => window.clearTimeout(id);
    // Runs once: the gate never says yes twice in one load.
  }, [demo, onHome]);
}

/**
 * The Simulation menu's Tour item (demo only). Replays the tour from Home; `onStart` closes the menu, and focus
 * comes back to the menu's button when the tour ends.
 */
export function TourButton({ onStart }: { onStart?: () => void }) {
  const start = useCallback(() => {
    onStart?.();
    const onHome = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] === "overview";
    if (!onHome) location.hash = HOME;
    // After a navigation Home needs a frame to render its anchors; driver.js also waits for them.
    window.setTimeout(() => startTour(focusSimMenu), onHome ? 0 : 120);
  }, [onStart]);
  return (
    <Button size="small" variant="quiet" onClick={start} title="A short tour of the demo: what needs you, progress, the lead, a task's steps, Results and how involved you are">
      Tour
    </Button>
  );
}
