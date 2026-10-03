// The sleep line of "Usage and service" (ORC-030 C4): on a Mac where the service holds the idle-sleep assertion while
// agents run, it says so; elsewhere, and when the assertion could not be held, it keeps the warning.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import { buildDemo } from "../domain/demo";
import { ServiceCard } from "./Diagnostics";
import { StoreContext, type ServiceStore } from "./store";

function render(keepAwake?: ServiceInfo["keepAwake"]): string {
  const service: ServiceInfo = {
    startedAt: new Date().toISOString(),
    scheduler: "active",
    runtime: "real",
    sim: { auto: false, ackMode: "normal" },
    dbPath: "/tmp/db.sqlite",
    providers: {} as ServiceInfo["providers"],
    ...(keepAwake ? { keepAwake } : {}),
  };
  const store = { state: buildDemo(Date.now()), service, version: 1, status: "online", disabled: false, send: async () => ({ ok: true }), postJson: async () => ({ ok: true, body: {} }), notice: null } as unknown as ServiceStore;
  const html = renderToStaticMarkup(
    <StoreContext.Provider value={store}>
      <ServiceCard />
    </StoreContext.Provider>,
  );
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

describe("the sleep line", () => {
  it("on a Mac that the service keeps awake: it says so, whether a run is active now or not", () => {
    for (const holding of [true, false]) {
      const t = render({ holding });
      expect(t).toContain("Nothing runs while this service is stopped. This Mac stays awake while agents run.");
      expect(t).not.toContain("the computer sleeps");
    }
  });

  it("elsewhere, the warning stays; when caffeinate could not start, the warning says why", () => {
    expect(render()).toContain("Nothing runs while this service is stopped or the computer sleeps.");
    const t = render({ holding: false, failed: "caffeinate could not start (spawn /usr/bin/caffeinate ENOENT)" });
    expect(t).toContain("Nothing runs while this service is stopped or the computer sleeps: caffeinate could not start (spawn /usr/bin/caffeinate ENOENT).");
    expect(t).not.toContain("stays awake");
  });
});
