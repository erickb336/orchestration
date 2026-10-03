// The hash routes, as pure functions so they can be tested without React. `#/results` is the Results page
// (the tab used to be called Review); `#/review` still opens it. `#/vision` is Vision, the studio, in the main
// navigation (ORC-029 r12). A
// query after the page name (`#/overview?history=1`, `#/tasks?area=Maps`) never changes which page opens; the page
// reads it.

export type Route = { page: "overview" | "tasks" | "review" | "activity" | "settings" | "kit" | "vision" | "lock-in" | "reality" } | { page: "task"; id: string };

/** The page under the tab it belongs to: a task page to Tasks, the Lock in summary to Vision, Design and reality to Results. */
export function tabOf(route: Route): string {
  if (route.page === "task") return "tasks";
  if (route.page === "lock-in") return "vision";
  if (route.page === "reality") return "review";
  return route.page;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  const page = parts[0].split("?")[0];
  const sub = parts[1]?.split("?")[0];
  if (page === "task" && parts[1]) return { page: "task", id: decodeURIComponent(parts[1].split("?")[0]) };
  // Design and reality (ORC-029 pass 5): each part of the design beside what the factory built, under Results.
  if ((page === "results" || page === "review") && sub === "design") return { page: "reality" };
  if (page === "results" || page === "review") return { page: "review" };
  // The component kit's gallery, #/kit. Not in the navigation.
  if (page === "kit") return { page: "kit" };
  // The Lock in summary (ORC-029 pass 5), from the studio's draft bar.
  if (page === "vision" && sub === "lock-in") return { page: "lock-in" };
  // Vision, the studio (ORC-029): a main navigation item, in Vision and in Factory.
  if (page === "vision") return { page: "vision" };
  if (page === "overview" || page === "activity" || page === "settings") return { page };
  return { page: "tasks" };
}

/** The Focus banner's History link opens the Overview with the vision history shown: `#/overview?history=1`. */
export const HISTORY_HASH = "#/overview?history=1";

export function historyRequested(hash: string): boolean {
  const q = hash.indexOf("?");
  if (q < 0) return false;
  try {
    return new URLSearchParams(hash.slice(q + 1)).get("history") === "1";
  } catch {
    return false;
  }
}
