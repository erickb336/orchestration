// The housekeeping section of "Usage and service": the last sweep in one line, its notes, the owner's setting, the
// "Clean up now" button and how to undo; the simulated service says it never touches Codex or Claude.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HousekeepingInfo, ServiceInfo } from "../api";
import { buildDemo } from "../domain/demo";
import { HousekeepingSection } from "./Diagnostics";
import { StoreContext, type ServiceStore } from "./store";

const service = (housekeeping?: HousekeepingInfo): ServiceInfo => ({
  startedAt: new Date().toISOString(),
  scheduler: "active",
  runtime: housekeeping?.ownerApps ? "real" : "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "",
  providers: {} as ServiceInfo["providers"],
  ...(housekeeping ? { housekeeping } : {}),
});
function render(info?: HousekeepingInfo): string {
  const store = { state: buildDemo(Date.now()), service: service(info), version: 1, status: "online", disabled: false, send: async () => ({ ok: true }), postJson: async () => ({ ok: true, body: {} }), notice: null } as unknown as ServiceStore;
  return renderToStaticMarkup(
    <StoreContext.Provider value={store}>
      <HousekeepingSection />
    </StoreContext.Provider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("housekeeping in Usage and service", () => {
  it("shows the last sweep, its notes, the setting, Clean up now and how to undo", () => {
    const html = render({
      running: false,
      everyHours: 6,
      ownerApps: true,
      last: { at: "2026-10-03T12:00:00Z", trigger: "start", ownerApps: true, archived: 2, trashed: 1, containers: 0, networks: 0, stages: 0, held: 1, recent: 0, notes: ["Docker did not answer, so the recorder's containers were not checked"] },
    });
    const t = text(html);
    expect(t).toContain("at start: archived 2 Codex threads, moved 1 Claude session folder to the Trash; 1 thread held open by another app waits for the next sweep.");
    expect(t).toContain("Notes Docker did not answer, so the recorder's containers were not checked");
    expect(t).toContain("every 6 hours");
    expect(t).toContain("To undo: unarchive the thread in Codex, or put the folder back from the Trash.");
    expect(html).toMatch(/<button[^>]*>Clean up now<\/button>/);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(html).not.toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"/);
  });

  it("says nothing was there to clean, and the simulated service never touches Codex or Claude", () => {
    const t = text(render({ running: false, everyHours: 6, ownerApps: false, last: { at: "2026-10-03T12:00:00Z", trigger: "owner", ownerApps: false, archived: 0, trashed: 0, containers: 0, networks: 0, stages: 0, held: 0, recent: 2, notes: [] } }));
    expect(t).toContain("by you: nothing to clean; 2 items changed in the last hour wait for the next sweep.");
    expect(t).toContain("The simulated service never touches Codex or Claude.");
    expect(t).not.toContain("Notes");
    expect(t).not.toContain("With the setting below");
  });

  it("is not shown by a service without housekeeping", () => {
    expect(render()).toBe("");
  });
});
