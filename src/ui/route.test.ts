// The Results page used to be the Review tab, so `#/results` and `#/review` open the same page; a query after a page
// name never changes the page, and the Focus banner's History link asks the Overview for the vision history.

import { describe, expect, it } from "vitest";
import { HISTORY_HASH, historyRequested, parseRoute, tabOf } from "./route";

describe("routes", () => {
  it("#/kit opens the component kit's gallery, which is not in the navigation", () => {
    expect(parseRoute("#/kit")).toEqual({ page: "kit" });
    expect(parseRoute("#/kit/button")).toEqual({ page: "kit" });
  });

  it("#/results is the Results page and #/review still opens it", () => {
    expect(parseRoute("#/results")).toEqual({ page: "review" });
    expect(parseRoute("#/review")).toEqual({ page: "review" });
    expect(parseRoute("#results")).toEqual({ page: "review" });
    expect(parseRoute("#/overview")).toEqual({ page: "overview" });
    expect(parseRoute("#/activity")).toEqual({ page: "activity" });
    expect(parseRoute("#/settings")).toEqual({ page: "settings" });
    expect(parseRoute("#/task/WT-004.3")).toEqual({ page: "task", id: "WT-004.3" });
    expect(parseRoute("#/task/WT%2D1")).toEqual({ page: "task", id: "WT-1" });
    for (const h of ["", "#", "#/", "#/tasks", "#/nope"]) expect(parseRoute(h)).toEqual({ page: "tasks" });
  });

  it("the Lock in summary and the pre-flight are under Vision and Design and reality under Results; each lights its tab", () => {
    expect(parseRoute("#/vision/lock-in")).toEqual({ page: "lock-in" });
    expect(parseRoute("#/vision/pre-flight")).toEqual({ page: "preflight" });
    expect(tabOf(parseRoute("#/vision/pre-flight"))).toBe("vision");
    expect(parseRoute("#/results/design")).toEqual({ page: "reality" });
    expect(parseRoute("#/review/design?item=bi-3")).toEqual({ page: "reality" });
    expect(parseRoute("#/vision/other")).toEqual({ page: "vision" });
    expect(parseRoute("#/results/other")).toEqual({ page: "review" });
    expect(["#/vision/lock-in", "#/results/design", "#/task/WT-1", "#/vision", "#/results"].map((h) => tabOf(parseRoute(h)))).toEqual(["vision", "review", "tasks", "vision", "review"]);
  });

  it("a query after the page name is the page's to read; it never changes which page opens", () => {
    expect(parseRoute("#/tasks?area=Offline%20maps")).toEqual({ page: "tasks" });
    expect(parseRoute("#/overview?history=1")).toEqual({ page: "overview" });
    expect(parseRoute("#/results?x=1")).toEqual({ page: "review" });
    expect(parseRoute("#/task/WT-1?x=1")).toEqual({ page: "task", id: "WT-1" });
  });

  it("the History link opens the vision history on the Overview", () => {
    expect(parseRoute(HISTORY_HASH)).toEqual({ page: "overview" });
    expect(historyRequested(HISTORY_HASH)).toBe(true);
    expect(historyRequested("#/overview")).toBe(false);
    expect(historyRequested("#/overview?history=0")).toBe(false);
    expect(historyRequested("#/tasks?area=x")).toBe(false);
  });
});
