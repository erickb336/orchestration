// ORC-018 §4: the Compare page rendered with a hand-made fixture (the domain's compareRows/groupRows are
// not needed to show the table), checking the text, the chips, the empty states and the accessibility hooks.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER } from "../domain/compare";
import { CompareContent, EMPTY_TEXT } from "./Compare";
import { fixtureGroups, fixtureMergedGroups, fixtureRows } from "./compareFixture";
import { MISSING_TITLE, TOO_FEW_LINE } from "./compareView";

const noop = () => {};
const render = (props: Partial<Parameters<typeof CompareContent>[0]> = {}) => {
  const rows = fixtureRows();
  return renderToStaticMarkup(<CompareContent rows={rows} groups={fixtureGroups(rows)} filter={DEFAULT_FILTER} setFilter={noop} onDownload={noop} {...props} />);
};
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the groups table", () => {
  const html = render();

  it("has one row per group, with the name, the version, source, experiment and too-few chips, and n", () => {
    expect(html).toContain("Change, reviewed by the other provider");
    expect(html).toContain("3f1c9a7e · current");
    expect(html).toContain("0c1d2e3f · older");
    expect(count(html, ">built-in<")).toBe(4);
    expect(count(html, ">experiment<")).toBe(1);
    expect(count(html, ">too few to compare<")).toBe(1);
    expect(html).toContain("9 tasks");
    expect(html).toContain("2 tasks");
  });

  it("shows the default measures as column headers with their help in a title and a hidden description", () => {
    for (const label of ["Time to done", "Agent runs", "Cost", "Repair rounds", "Open at the end", "Checks passed first time", "Landed", "Sent back"]) expect(html).toContain(`class="measure">${label}<`);
    expect(html).not.toContain('class="measure">Input tokens<');
    expect(html).toContain('title="From the first run to done or cancelled, including any time waiting for you. Missing when no run started."');
    expect(html).toContain('<span class="sr-only">. From the first run to done or cancelled');
  });

  it("shows medians with spreads, rates as 'count of n', a missing cell as a dash with its title, and the strips hidden from assistive technology", () => {
    expect(html).toMatch(/class="cell-main num">\d+m \d\ds</);
    expect(html).toMatch(/class="cell-spread num">\d+m \d\ds–\d+m \d\ds</);
    expect(html).toMatch(/class="cell-main num">\d of \d</);
    expect(html).toContain("of 9 reported");
    expect(html).toContain(`title="${MISSING_TITLE}"`);
    expect(count(html, 'aria-hidden="true" focusable="false"')).toBeGreaterThan(20);
    expect(html).not.toContain("--st-");
  });

  it("labels every checkbox and offers to open a group", () => {
    expect(html).toContain('aria-label="Select Change (3f1c9a7e · current) to compare"');
    expect(html).toContain('aria-label="Select Bug fix (0c1d2e3f · older) to compare"');
    expect(count(html, 'aria-expanded="false"')).toBe(4);
    expect(html).toContain(">Show tasks<");
    expect(html).toContain("Download CSV");
    expect(html).toContain("Download JSON");
    expect(html).toContain("Measures…");
  });
});

describe("selecting and opening", () => {
  it("shows two selected groups side by side, with 'Too few tasks to compare this' where either side is small", () => {
    const groups = fixtureGroups();
    const html = render({ initialSelected: [groups[0].key, groups[3].key] });
    expect(html).toContain(">Side by side<");
    expect(count(html, TOO_FEW_LINE)).toBeGreaterThanOrEqual(8);
    expect(html).toContain('title="Two groups are selected already; clear one first"');
    expect(html).toContain("Clear selection");
    const twoBig = render({ initialSelected: [groups[0].key, groups[1].key] });
    expect(twoBig).toContain(">Side by side<");
    // Only measures that few rows reported (cost) say so; the rest compare.
    expect(count(twoBig, TOO_FEW_LINE)).toBeLessThan(3);
  });

  it("keeps at most two selected", () => {
    const groups = fixtureGroups();
    const html = render({ initialSelected: groups.map((g) => g.key) });
    const checkedSelects = html.match(/<input(?=[^>]*checked="")(?=[^>]*aria-label="Select )[^>]*>/g) ?? [];
    expect(checkedSelects).toHaveLength(2);
    expect(html.match(/<input(?=[^>]*aria-label="Select )[^>]*>/g)).toHaveLength(4);
  });

  it("lists an open group's tasks, linked, with the settled date and the visible measures", () => {
    const groups = fixtureGroups();
    const html = render({ initialOpen: [groups[2].key] });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(">Hide tasks<");
    expect(count(html, 'href="#/task/WT-1')).toBe(5);
    expect(html).toContain("WT-119");
    expect(html).toMatch(/<th scope="col">Task<\/th><th scope="col">Settled<\/th>/);
    expect(html).toContain('title="Not reported"');
  });

  it("says a merged group mixes versions", () => {
    const rows = fixtureRows();
    const html = render({ groups: fixtureMergedGroups(rows), filter: { ...DEFAULT_FILTER, mergeVersions: true } });
    expect(html).toContain("mixes 2 versions");
    expect(html).toContain("7 tasks");
  });
});

describe("empty states", () => {
  it("explains what will appear when there are no rows at all", () => {
    const html = render({ rows: [], groups: [] });
    expect(html).toContain(EMPTY_TEXT);
    expect(html).not.toContain("Download CSV");
  });

  it("says when filters leave nothing, keeping the toolbar", () => {
    const html = render({ groups: [] });
    expect(html).toContain("No finished tasks match these filters.");
    expect(html).toContain("Download CSV");
  });

  it("falls back to input tokens when no row reports a cost", () => {
    const rows = fixtureRows().map((r) => ({ ...r, m: Object.fromEntries(Object.entries(r.m).filter(([k]) => k !== "cost")) }));
    const html = render({ rows, groups: fixtureGroups(rows) });
    expect(html).toContain('class="measure">Input tokens<');
    expect(html).not.toContain('class="measure">Cost<');
  });
});
