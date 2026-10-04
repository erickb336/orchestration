// The hash routes, as pure functions so they can be tested without React. `#/results` is the Results page
// (the tab used to be called Review); `#/review` still opens it. `#/vision` is Vision, the studio, in the main
// navigation (ORC-029 r12). A
// query after the page name (`#/vision?history=1`, `#/tasks?area=Maps`) never changes which page opens; the page
// reads it.

export type Route = { page: "overview" | "tasks" | "review" | "activity" | "settings" | "kit" | "vision" | "lock-in" | "preflight" | "reality" | "baseline" } | { page: "task"; id: string } | { page: "change-order"; rev: number };

/** The page under the tab it belongs to: a task page and a change order to Tasks, the Lock in summary, the baseline and the pre-flight to Vision, Design and reality to Results. */
export function tabOf(route: Route): string {
  if (route.page === "task" || route.page === "change-order") return "tasks";
  if (route.page === "lock-in" || route.page === "preflight" || route.page === "baseline") return "vision";
  if (route.page === "reality") return "review";
  return route.page;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  const page = parts[0].split("?")[0];
  const sub = parts[1]?.split("?")[0];
  if (page === "task" && parts[1]) return { page: "task", id: decodeURIComponent(parts[1].split("?")[0]) };
  // A change order (ORC-029 pass 5, screen 4), under Tasks: `#/tasks/change-order/3`.
  const rev = Number(parts[2]?.split("?")[0]);
  if (page === "tasks" && sub === "change-order" && Number.isInteger(rev) && rev > 0) return { page: "change-order", rev };
  // Design and reality (ORC-029 pass 5): each part of the design beside what the factory built, under Results.
  if ((page === "results" || page === "review") && sub === "design") return { page: "reality" };
  if (page === "results" || page === "review") return { page: "review" };
  // The component kit's gallery, #/kit. Not in the navigation.
  if (page === "kit") return { page: "kit" };
  // The Lock in summary (ORC-029 pass 5), from the studio's draft bar.
  if (page === "vision" && sub === "lock-in") return { page: "lock-in" };
  // The baseline Lock in of an import (ORC-032, C4), from the import's review.
  if (page === "vision" && sub === "baseline") return { page: "baseline" };
  // The pre-flight (ORC-029 pass 6): Start the factory, from Home, Vision and Settings while in Vision.
  if (page === "vision" && sub === "pre-flight") return { page: "preflight" };
  // Vision, the studio (ORC-029): a main navigation item, in Vision and in Factory.
  if (page === "vision") return { page: "vision" };
  if (page === "tasks" || page === "activity" || page === "settings") return { page };
  // Home: the bare address (where every new project's Get started list is, and the demo's tour), and any page we do not know.
  return { page: "overview" };
}

/** A link to the vision history opens Vision with the history shown: `#/vision?history=1` (the vision text lives in Vision, ORC-030 C1). */
export const HISTORY_HASH = "#/vision?history=1";

export function historyRequested(hash: string): boolean {
  const q = hash.indexOf("?");
  if (q < 0) return false;
  try {
    return new URLSearchParams(hash.slice(q + 1)).get("history") === "1";
  } catch {
    return false;
  }
}
