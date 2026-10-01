// Settings in five sections, one involvement card with the numbers it really sets, the developer forms in
// Advanced, Checks as one line, one Save per section, and visible help instead of "How this works". Rendered
// statically over the demo (there is no DOM test environment in this repository), plus the pure parts: the
// addresses, the draft, and a check that no Settings file sizes or colours things inline.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../../api";
import { buildDemo } from "../../domain/demo";
import type { State } from "../../domain/types";
import { findInlineStyleDrift } from "../kit/inlineStyleCheck";
import { Settings } from "../Settings";
import { StoreContext, type SendResult, type ServiceStore } from "../store";
import { AdvancedSection } from "./Advanced";
import { AgentsSection } from "./Agents";
import { changedKeys, intIn, numIn, pruneEdits, sendInOrder } from "./draft";
import { ProjectSection } from "./Project";
import { QualitySection } from "./Quality";
import { CARD_SECTION, SECTIONS, cardHref, parseSettingsHash, settingsHref } from "./sections";
import { WorkingStyleSection } from "./WorkingStyle";

const T0 = Date.now();
const service: ServiceInfo = {
  startedAt: new Date(T0).toISOString(),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "immediate" as ServiceInfo["sim"]["ackMode"] },
  dbPath: "",
  providers: {} as ServiceInfo["providers"],
};

function render(state: State, node: React.ReactElement): string {
  const store = { state, service, version: 1, status: "online", disabled: false, send: async () => ({ ok: true }), notice: null } as unknown as ServiceStore;
  return renderToStaticMarkup(<StoreContext.Provider value={store}>{node}</StoreContext.Provider>);
}
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

describe("Settings addresses", () => {
  it("#/settings opens Working style; each section has its own address", () => {
    expect(parseSettingsHash("#/settings")).toEqual({ section: "working-style" });
    expect(parseSettingsHash("#/settings/")).toEqual({ section: "working-style" });
    for (const s of SECTIONS) expect(parseSettingsHash(settingsHref(s.id))).toEqual({ section: s.id });
    expect(parseSettingsHash("#/settings/nonsense")).toEqual({ section: "working-style" });
  });

  it("a card opens its section at the card, by its section's address or by its name alone", () => {
    expect(parseSettingsHash("#/settings/project/delivery")).toEqual({ section: "project", card: "delivery" });
    expect(parseSettingsHash("#/settings/delivery")).toEqual({ section: "project", card: "delivery" });
    expect(parseSettingsHash("#/settings/checks")).toEqual({ section: "quality", card: "checks" });
    expect(parseSettingsHash("#/settings/diagnostics")).toEqual({ section: "advanced", card: "diagnostics" });
    // A card asked for in the wrong section is not scrolled to; the section opens at its top.
    expect(parseSettingsHash("#/settings/agents/delivery")).toEqual({ section: "agents" });
    expect(cardHref("sandbox")).toBe("#/settings/advanced/sandbox");
    for (const [card, section] of Object.entries(CARD_SECTION)) {
      expect(SECTIONS.map((s) => s.id)).toContain(section);
      expect(parseSettingsHash(`#/settings/${card}`)).toEqual({ section, card });
    }
  });
});

describe("the draft", () => {
  it("counts only the edits that differ from the live value", () => {
    const live = { a: "1", b: true, c: ["x"] };
    expect(changedKeys(live, { a: "1", b: false })).toEqual(["b"]);
    expect(changedKeys(live, { c: ["x"] })).toEqual([]);
    expect(changedKeys(live, { c: ["x", "y"] })).toEqual(["c"]);
    expect(pruneEdits(live, { a: "1", b: false })).toEqual({ b: false });
  });

  it("reads numbers in range from a field's text", () => {
    expect(intIn("5", 5, 1440)).toBe(5);
    expect(intIn("4", 5, 1440)).toBeUndefined();
    expect(intIn("2.5", 0, 5)).toBeUndefined();
    expect(intIn("", 0, 5)).toBeUndefined();
    expect(numIn("0.5", 0.01, 1000)).toBe(0.5);
    expect(numIn("", 0.01, 1000)).toBeUndefined();
  });

  it("sends a section's commands in order and stops at the first that fails", async () => {
    const sent: string[] = [];
    const step = (name: string, ok: boolean) => async (): Promise<SendResult> => (sent.push(name), ok ? { ok: true } : { ok: false });
    expect(await sendInOrder([step("a", true), () => null, step("b", false), step("c", true)])).toBe(false);
    expect(sent).toEqual(["a", "b"]);
    expect(await sendInOrder([() => null])).toBe(true);
  });
});

describe("the Settings page", () => {
  const s = buildDemo(T0);
  const html = render(s, <Settings />);

  it("has five sections in a side menu, each with one heading, one help line and one Save; only the first shows", () => {
    expect(count(html, 'class="k-sidenav__link"')).toBe(5);
    expect(html).toContain('href="#/settings/working-style" aria-current="page"');
    const sections = [...html.matchAll(/<section class="s-section"[^>]*>/g)].map((m) => m[0]);
    expect(sections).toHaveLength(5);
    expect(sections.filter((x) => x.includes("hidden"))).toHaveLength(4);
    expect([...html.matchAll(/<h2 id="settings-[a-z-]+-h">([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(["Working style", "Project", "Agents", "Quality", "Advanced"]);
    expect(count(html, 'class="s-savebar"')).toBe(5);
    expect(count(text(html), "No unsaved changes")).toBe(5);
    expect(count(html, 'class="s-help"')).toBe(5);
  });

  it("has no 'How this works' disclosure and no browser confirm text", () => {
    expect(text(html)).not.toMatch(/How this works/);
    expect(html).not.toMatch(/class="how"/);
  });

  it("drops the separate planning card: involvement is one card, and its numbers are the ones set", () => {
    const t = text(render(s, <WorkingStyleSection current onDirty={noop} />));
    expect(t).not.toMatch(/Advanced: planning|Let the lead plan and propose tasks on its own/);
    const a = s.project.autonomy;
    // The demo plans every 60 minutes, 3 per plan, 5 open: Check-in says so; Autopilot says what choosing it sets.
    expect(t).toContain(`Check-in The lead plans every ${a.planningIntervalMinutes} minutes, up to ${a.maxProposalsPerCycle} tasks per plan and at most ${a.maxOpenProposals} open.`);
    expect(t).toContain("Autopilot The lead plans every 30 minutes, up to 5 tasks per plan and at most 15 open.");
    expect(t).toContain("Fine-tune");
    expect(t).toMatch(/Open lead proposals: \d+/);
    expect(t).toContain("When you message the lead");
    expect(t).toContain("Findings that need a decision go to");
    expect(t).toContain("Notify me in this browser");
  });

  it("Project holds the repository, the stage and delivery basics; the rest of the pull-request options are in Advanced", () => {
    const t = text(render(s, <ProjectSection current onDirty={noop} />));
    for (const x of ["Repository path", "Stage", "Back to shaping", "Delivery", "Off", "Local branch", "GitHub pull requests", "Remote", "Base branch", "You merge", "Merges automatically"]) expect(t).toContain(x);
    for (const x of ["Review bots", "This repository has no CI", "Protected files", "Re-run a check GitHub cancelled", "Open pull requests at most"]) expect(t).not.toContain(x);
  });

  it("Agents holds the providers, the lead's model, the models per role, agents at once and run limits; no capability table", () => {
    const html = render(s, <AgentsSection current onDirty={noop} />);
    const t = text(html);
    for (const x of ["Providers", "Check again", "The lead", "Project default", "Coder", "Security reviewer", "Same as the code reviewer", "All agents", "Claude at most", "Codex at most", "Turns at most", "Claude budget per run (USD)"]) expect(t).toContain(x);
    expect(t).not.toMatch(/Live steering|Child-agent tracking|Sample models/);
    // The lead's model is one choice (setting it also set the Lead role default): one field, not two.
    expect(count(t, "The lead ")).toBe(1);
  });

  it("Quality shows checks as one line with Suggest and Edit; the editor and the sandbox are not in the main view", () => {
    const html = render(s, <QualitySection current onDirty={noop} />);
    const t = text(html);
    expect(t).toContain(`On · ${s.project.checks.commands.length} commands`);
    expect(t).toContain("Suggest from repository");
    expect(t).toContain("Edit commands");
    expect(t).not.toMatch(/Arguments, the program first|\+ argument|Codex sandbox \(recommended\)|Protected check inputs/);
    expect(t).toContain("Default flow");
    expect(t).toContain("Principles");
  });

  it("Advanced has every developer form and the diagnostics", () => {
    const t = text(render(s, <AdvancedSection current onDirty={noop} />));
    for (const x of [
      "Pull requests",
      "Review bots",
      "This repository has no CI",
      "Re-run a check GitHub cancelled",
      "What the app found on GitHub",
      "Checks sandbox",
      "Codex sandbox (recommended)",
      "Protected check inputs",
      "Environment variables to pass through",
      "Provider capabilities",
      "Sample models",
      "Data",
      "Download board (Markdown)",
      "Usage and service",
    ])
      expect(t).toContain(x);
  });
});

describe("Settings files size and colour nothing inline", () => {
  const sources = import.meta.glob<string>(["./*.tsx", "../Settings.tsx", "../ChecksSettings.tsx", "../DeliverySettings.tsx"], { query: "?raw", import: "default", eager: true });
  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith(".test.tsx")) continue;
    it(path, () => {
      expect(findInlineStyleDrift(source)).toEqual([]);
      expect(source).not.toMatch(/style=\{\{/);
      expect(source).not.toMatch(/(^|[^.\w])confirm\(\s*["`]/m);
    });
  }
});
