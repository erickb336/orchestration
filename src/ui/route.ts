// The hash routes, as pure functions so they can be tested without React. `#/results` is the Results page
// (the tab used to be called Review); `#/review` still opens it. A query after the page name (`#/overview?history=1`,
// `#/tasks?area=Maps`) never changes which page opens; the page reads it.

export type Route = { page: "overview" | "tasks" | "review" | "activity" | "settings" | "kit" } | { page: "task"; id: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  const page = parts[0].split("?")[0];
  if (page === "task" && parts[1]) return { page: "task", id: decodeURIComponent(parts[1].split("?")[0]) };
  if (page === "results" || page === "review") return { page: "review" };
  // The component kit's gallery, #/kit. Not in the navigation.
  if (page === "kit") return { page: "kit" };
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
