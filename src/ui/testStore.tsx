// Test helpers for the screens (not used by the application): there is no DOM test environment here, so a screen is
// rendered through react-dom/server over a fake store, and read as the text a reader sees.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceInfo } from "../api";
import type { State } from "../domain/types";
import { ConfirmProvider } from "./kit";
import { StoreContext, type ServiceStore } from "./store";

export const testService = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  startedAt: "2026-10-02T09:00:00.000Z",
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
  ...over,
});

/** A store as a screen sees it once the service answered: online, with `state`, and commands that go nowhere. */
export function testStore(state: State, svc: ServiceInfo = testService()): ServiceStore {
  const noop = async () => ({ ok: true as const });
  return { state, version: 1, service: svc, status: "online", disabled: false, send: noop, notice: null, setNotice: () => {} } as unknown as ServiceStore;
}

/** The screen's markup over a fake store holding `state`. */
export const renderScreen = (node: ReactElement, state: State, svc?: ServiceInfo) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={testStore(state, svc)}>{node}</StoreContext.Provider>
    </ConfirmProvider>,
  );

/** The text a reader sees in rendered markup: tags dropped, entities read, spaces collapsed. */
export const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
