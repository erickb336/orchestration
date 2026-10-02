// "Questions for you" under PE review (ORC-029 pass 4, convergence): the PE's open cases on the artifact shown, as
// product questions for the owner, never as revisions. Rendered through react-dom/server over a fake store, as
// studio.test.tsx does.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../../api";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { DESIGNER, addScreen, openRound, pePass, sha } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { ConfirmProvider } from "../kit";
import { StoreContext, type ServiceStore } from "../store";
import { Studio } from "./Studio";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const service: ServiceInfo = {
  startedAt: at(0),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
  prototypePort: 5320,
};
const render = (state: State) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={{ state, version: 1, service, status: "online", disabled: false, send: async () => ({ ok: true as const }), notice: null, setNotice: () => {} } as unknown as ServiceStore}>
        <Studio />
      </StoreContext.Provider>
    </ConfirmProvider>,
  );
const AB = [
  { id: "a", label: "A · Map first", entry: "a/index.html" },
  { id: "b", label: "B · Day by day", entry: "b/index.html" },
];

/** The trip plan in round 1, with the PE's first pass (these verdicts) on v1. */
function reviewed(verdicts: Parameters<typeof pePass>[3]) {
  const r = openRound(M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/trips", vision: "Plan weekend trips with friends.", focus: "" }, at(0)), "experience", at(1));
  const a = addScreen(r.state, r.n, at(2), { title: "Trip plan", variants: AB, files: [{ path: "a/index.html", sha256: sha("a") }, { path: "b/index.html", sha256: sha("b") }], madeBy: DESIGNER });
  return { s: pePass(a.state, a.id, 1, verdicts, at(3)), id: a.id, n: r.n };
}

describe("PE review: questions for you", () => {
  it("shows the PE's open cases under its verdicts, with why, the variant and the pass, in plain words and no revision wording", () => {
    const { s } = reviewed([
      { variant: "a", verdict: "feasible", openCases: [{ text: "Who pays when a friend drops out after booking?", why: "Nobody set the rule." }] },
      { variant: "b", verdict: "feasible", openCases: [{ text: "What happens to the plan on a rain day?" }] },
    ]);
    const html = render(s);
    const block = /<h3 class="st-label">Questions for you<\/h3>[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
    expect(block).toContain("The PE noticed these about the product. They are yours to decide. The lead asks you about them.");
    expect(block).toContain('<li class="st-verdict"><p class="small">Who pays when a friend drops out after booking?</p><p class="small muted">Nobody set the rule.</p><p class="micro muted">A · Map first · PE pass 1</p></li>');
    expect(block).toContain('<li class="st-verdict"><p class="small">What happens to the plan on a rain day?</p><p class="micro muted">B · Day by day · PE pass 1</p></li>');
    expect(block).not.toMatch(/revis/i);
    // Under the PE's verdicts, inside PE review.
    expect(html.indexOf('aria-label="The PE&#x27;s verdicts"')).toBeLessThan(html.indexOf("Questions for you"));
    expect(html.indexOf('aria-label="PE review"')).toBeLessThan(html.indexOf("Questions for you"));
  });

  it("the questions of an earlier pass stay with the revised version; with none raised, there is no block", () => {
    const { s, id, n } = reviewed([
      { variant: "a", verdict: "feasible", openCases: [{ text: "Who pays when a friend drops out after booking?" }] },
      { variant: "b", verdict: "feasible-if", change: "Daily forecasts." },
    ]);
    const v2 = addScreen(s, n, at(4), { artifactId: id, title: "Trip plan", variants: AB, files: [{ path: "a/index.html", sha256: sha("a") }, { path: "b/index.html", sha256: sha("c") }], madeBy: DESIGNER }).state;
    const agreed = pePass(v2, id, 2, [{ variant: "a", verdict: "feasible" }, { variant: "b", verdict: "feasible" }], at(5));
    expect(render(agreed)).toContain("<p class=\"small\">Who pays when a friend drops out after booking?</p><p class=\"micro muted\">A · Map first · PE pass 1</p>");
    expect(render(reviewed([{ variant: "a", verdict: "feasible" }, { variant: "b", verdict: "feasible" }]).s)).not.toContain("Questions for you");
  });
});
