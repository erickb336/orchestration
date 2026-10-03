// The kit's behaviour. There is no DOM test environment in this repository, so the markup is checked
// through react-dom/server and the keyboard and confirmation logic through its pure helpers (keys.ts, confirmCore.ts).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Banner } from "./Banner";
import { Button, ButtonLink } from "./Button";
import { Card } from "./Card";
import { Chip, SIMULATED_TITLE, SimulatedChip } from "./Chip";
import { ConfirmPanel, InlineConfirm } from "./Confirm";
import { confirmFallbackText, confirmKeyAction, createConfirmQueue, rememberFocus, type ConfirmRequest } from "./confirmCore";
import { Disclosure } from "./Disclosure";
import { EmptyState } from "./EmptyState";
import { Checkbox, Field, Input, Select, Textarea } from "./Field";
import { moveIndex, trapTabIndex } from "./keys";
import { NeedsYouItem, Row, Rows } from "./Row";
import { SideNav } from "./SideNav";
import { StatePill } from "./StatePill";
import { STEP_MARK, STEP_WORD, StepList } from "./StepList";
import { SegmentedControl, Tabs } from "./Tabs";
import { Toast } from "./Toast";
import { shiftIntoWindow } from "./inWindow";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const attr = (markup: string, name: string) => [...markup.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);

describe("Button", () => {
  it("has a variant and a size class, and is a button by default", () => {
    const m = html(
      <Button variant="primary" size="small">
        Merge
      </Button>,
    );
    expect(m).toContain('class="k-btn k-btn--primary k-btn--small"');
    expect(m).toContain('type="button"');
    expect(html(<Button>Pause</Button>)).toContain('class="k-btn"');
  });

  it("is natively disabled without a reason", () => {
    const m = html(<Button disabled>Start</Button>);
    expect(m).toContain(" disabled");
    expect(m).not.toContain("aria-disabled");
  });

  it("stays focusable with a reason, which is the title; the reason line is linked", () => {
    const m = html(
      <Button disabled disabledReason="Paused: resume the project first." showReason>
        Start
      </Button>,
    );
    expect(m).not.toMatch(/<button[^>]* disabled/);
    expect(m).toContain('aria-disabled="true"');
    expect(m).toContain('title="Paused: resume the project first."');
    const [described] = attr(m, "aria-describedby");
    expect(described).toBeTruthy();
    expect(m).toContain(`<span class="k-btn-reason" id="${described}">Paused: resume the project first.</span>`);
  });

  it("while loading is busy, soft-disabled and shows a spinner", () => {
    const m = html(<Button loading>Pausing…</Button>);
    expect(m).toContain('aria-busy="true"');
    expect(m).toContain('aria-disabled="true"');
    expect(m).toContain('class="k-spinner"');
  });

  it("ButtonLink is an anchor in the button's clothes", () => {
    expect(html(<ButtonLink href="#/review">Results</ButtonLink>)).toBe('<a href="#/review" class="k-btn">Results</a>');
  });
});

describe("Chip and StatePill", () => {
  it("chips carry a tone class; the simulated chip is dashed and says simulated once", () => {
    expect(html(<Chip tone="you">1 finding</Chip>)).toBe('<span class="k-chip k-chip--you">1 finding</span>');
    expect(html(<Chip>Area</Chip>)).toBe('<span class="k-chip">Area</span>');
    const sim = html(<SimulatedChip />);
    expect(sim).toContain("k-chip--sim");
    expect(sim).toContain(`title="${SIMULATED_TITLE}"`);
    expect(sim.match(/simulated/g)).toHaveLength(1);
  });

  it("the pill pulses only for work, and shows a pause mark instead of the dot", () => {
    const running = html(
      <StatePill tone="work" pulse>
        Running
      </StatePill>,
    );
    expect(running).toContain("k-pill--pulse");
    expect(running).toContain('class="k-pill__dot"');
    expect(
      html(
        <StatePill tone="you" pulse>
          Needs you
        </StatePill>,
      ),
    ).not.toContain("k-pill--pulse");
    const paused = html(
      <StatePill tone="neutral" paused>
        Paused
      </StatePill>,
    );
    expect(paused).toContain("k-pill__pause");
    expect(paused).not.toContain("k-pill__dot");
    expect(paused).toContain(">Paused</span>");
  });

  it("with an href the pill is a link to the place it describes; without one it is not", () => {
    expect(
      html(
        <StatePill tone="work" pulse href="#/tasks" title="3 agents working">
          Factory running · 3 agents
        </StatePill>,
      ),
    ).toBe('<a class="k-pill k-pill--work k-pill--pulse k-pill--link" href="#/tasks" title="3 agents working"><span class="k-pill__dot" aria-hidden="true"></span><span class="k-pill__text">Factory running · 3 agents</span></a>');
    expect(html(<StatePill tone="done">Done</StatePill>)).toBe('<span class="k-pill k-pill--done"><span class="k-pill__dot" aria-hidden="true"></span>Done</span>');
  });
});

describe("Card and Banner", () => {
  it("the card is a section labelled by its title, with a count badge in the asked tone", () => {
    const m = html(
      <Card title="Needs you" count={3} countTone="you" actions={<button>All</button>}>
        body
      </Card>,
    );
    const [labelledBy] = attr(m, "aria-labelledby");
    expect(m).toContain(`<h2 class="k-card__title" id="${labelledBy}">Needs you<span class="k-count k-count--you">3</span></h2>`);
    expect(m).toContain('<div class="k-card__actions k-actions"><button>All</button></div>');
    expect(m).toContain('<div class="k-card__body">body</div>');
    expect(html(<Card>plain</Card>)).toBe('<section class="k-card"><div class="k-card__body">plain</div></section>');
  });

  it("banners are polite, except a failure, which is an alert", () => {
    expect(html(<Banner tone="you" title="A finding needs your decision">q</Banner>)).toContain('class="k-banner k-banner--you" role="status"');
    expect(html(<Banner tone="fail">Service offline</Banner>)).toContain('role="alert"');
    expect(html(<Banner>info</Banner>)).toContain("k-banner--info");
    expect(html(<Banner role="none">quiet</Banner>)).not.toContain("role=");
  });
});

describe("Row and NeedsYouItem", () => {
  it("renders id, linked title, meta and actions", () => {
    const m = html(
      <Rows label="New results">
        <Row as="li" id="WT-011" title="Faster trail search" href="#/task/WT-011" meta="Landed 2 days ago" actions={<button>Mark as seen</button>} />
      </Rows>,
    );
    expect(m).toContain('<ul class="k-rows" aria-label="New results">');
    expect(m).toContain('<li class="k-row">');
    expect(m).toContain('<span class="k-row__id">WT-011</span><a href="#/task/WT-011">Faster trail search</a>');
    expect(m).toContain('<div class="k-row__meta">Landed 2 days ago</div>');
    expect(m).toContain('<div class="k-row__actions"><button>Mark as seen</button></div>');
  });

  it("a Needs-you item says what is needed and marks a simulated thing once", () => {
    const m = html(<NeedsYouItem taskId="WT-005" title="Suggest a packing list" what="Ready to merge:" detail="Code ✓ Security ✓" simulated actions={<button>Merge</button>} />);
    expect(m).toContain('<span class="k-row__what">Ready to merge:</span><span>Code ✓ Security ✓</span><span class="k-chip k-chip--sim"');
    expect(m.match(/simulated/g)).toHaveLength(1);
    expect(m.startsWith('<li class="k-row">')).toBe(true);
  });
});

describe("Field", () => {
  it("labels its control and links hint and error; the control is invalid when there is an error", () => {
    const m = html(
      <Field label="Repository" hint="A local git repository." error="This folder is not a git repository.">
        <Input defaultValue="~/Code" />
      </Field>,
    );
    const [forId] = attr(m, "for");
    const [inputId] = attr(m, "id");
    expect(forId).toBe(inputId);
    const [described] = attr(m, "aria-describedby");
    const ids = described.split(" ");
    expect(ids).toHaveLength(2);
    expect(m).toContain(`<span class="k-field__hint" id="${ids[0]}">A local git repository.</span>`);
    expect(m).toContain(`<span class="k-field__error" id="${ids[1]}" role="alert">This folder is not a git repository.</span>`);
    expect(m).toContain('aria-invalid="true"');
  });

  it("without hint or error the control has no description and is not invalid", () => {
    const m = html(
      <Field label="Name">
        <Input />
      </Field>,
    );
    expect(m).not.toContain("aria-describedby");
    expect(m).not.toContain("aria-invalid");
    expect(m).toContain('<label class="k-field__label" for=');
  });

  it("wraps Textarea and Select the same way; Select takes options", () => {
    const t = html(
      <Field label="Message" hint="h">
        <Textarea />
      </Field>,
    );
    expect(attr(t, "for")[0]).toBe(attr(t, "id")[0]);
    expect(t).toMatch(/<textarea id="[^"]+" aria-describedby="[^"]+" class="k-control">/);
    const s = html(
      <Field label="Who merges" width="medium">
        <Select
          defaultValue="you"
          options={[
            { value: "you", label: "You merge" },
            { value: "auto", label: "Merges automatically" },
          ]}
        />
      </Field>,
    );
    expect(s).toContain("k-field--medium");
    expect(s).toContain('<option value="you" selected="">You merge</option>');
    expect(s).toContain('<option value="auto">Merges automatically</option>');
  });

  it("a hidden label is still a label; a checkbox has its label and hint", () => {
    expect(
      html(
        <Field label="Filter" labelHidden>
          <Input />
        </Field>,
      ),
    ).toContain('class="k-field__label sr-only"');
    const c = html(<Checkbox label="Notify me" hint="When something needs you." />);
    expect(c).toMatch(/^<label class="k-check"><input type="checkbox" class="k-check__box" aria-describedby="[^"]+"\/>/);
    expect(c).toContain('<span class="k-check__hint" id="');
  });
});

describe("Disclosure", () => {
  it("is a details with a labelled summary and an optional count", () => {
    expect(html(<Disclosure label="Outputs" count={7}>x</Disclosure>)).toBe('<details class="k-disc"><summary class="k-disc__summary">Outputs<span class="k-count">7</span></summary><div class="k-disc__body">x</div></details>');
    expect(html(<Disclosure label="Why it's ready" inline defaultOpen>x</Disclosure>)).toContain('<details class="k-disc k-disc--inline" open="">');
  });
});

describe("Confirm", () => {
  it("resolves true when settled by the primary action and false when cancelled", async () => {
    const shown: (ConfirmRequest | null)[] = [];
    const q = createConfirmQueue((c) => shown.push(c));
    const a = q.ask({ title: "Replace all data?" });
    expect(shown.at(-1)?.title).toBe("Replace all data?");
    q.settle(true);
    await expect(a).resolves.toBe(true);
    const b = q.ask({ title: "Cancel WT-007?", danger: true });
    q.settle(false);
    await expect(b).resolves.toBe(false);
    expect(shown.at(-1)).toBeNull();
  });

  it("shows one request at a time, in order", async () => {
    const shown: (ConfirmRequest | null)[] = [];
    const q = createConfirmQueue((c) => shown.push(c));
    const first = q.ask({ title: "First?" });
    const second = q.ask({ title: "Second?" });
    expect(q.current?.title).toBe("First?");
    expect(shown.map((s) => s?.title)).toEqual(["First?"]);
    q.settle(true);
    expect(q.current?.title).toBe("Second?");
    q.settle(false);
    expect(q.current).toBeNull();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    q.settle(true); // nothing queued: a no-op
  });

  it("Escape cancels; Enter accepts on the dialog but not on a button, link or text area", () => {
    expect(confirmKeyAction("Escape")).toBe("cancel");
    expect(confirmKeyAction("Escape", { tagName: "BUTTON" })).toBe("cancel");
    expect(confirmKeyAction("Enter", { tagName: "DIV" })).toBe("accept");
    expect(confirmKeyAction("Enter", null)).toBe("accept");
    expect(confirmKeyAction("Enter", { tagName: "BUTTON" })).toBeNull();
    expect(confirmKeyAction("Enter", { tagName: "a" })).toBeNull();
    expect(confirmKeyAction("Enter", { tagName: "TEXTAREA" })).toBeNull();
    expect(confirmKeyAction("Tab")).toBeNull();
    expect(confirmKeyAction(" ")).toBeNull();
  });

  it("the focus trap wraps at both ends and pulls focus in from outside", () => {
    expect(trapTabIndex(3, 2, false)).toBe(0);
    expect(trapTabIndex(3, 0, true)).toBe(2);
    expect(trapTabIndex(3, 1, false)).toBeNull();
    expect(trapTabIndex(3, 1, true)).toBeNull();
    expect(trapTabIndex(3, -1, false)).toBe(0);
    expect(trapTabIndex(3, -1, true)).toBe(2);
    expect(trapTabIndex(0, -1, false)).toBeNull();
  });

  it("focus returns to what had it, and nothing breaks when that is gone", () => {
    let focused = 0;
    const back = rememberFocus({ focus: () => void focused++ });
    back();
    expect(focused).toBe(1);
    expect(() => rememberFocus(null)()).not.toThrow();
    expect(() =>
      rememberFocus({
        focus: () => {
          throw new Error("gone");
        },
      })(),
    ).not.toThrow();
  });

  it("the panel is a modal dialog labelled by its title and described by its text, with Cancel then the primary action", () => {
    const m = html(<ConfirmPanel title="Replace all data with the sample project?" text="Every task is replaced." primaryLabel="Replace" onResolve={() => undefined} />);
    expect(m).toContain('role="dialog" aria-modal="true"');
    const [labelledBy] = attr(m, "aria-labelledby");
    const [describedBy] = attr(m, "aria-describedby");
    expect(m).toContain(`<h2 class="k-dialog__title" id="${labelledBy}">Replace all data with the sample project?</h2>`);
    expect(m).toContain(`<p class="k-dialog__text" id="${describedBy}">Every task is replaced.</p>`);
    expect(m).toMatch(/data-confirm="cancel"[^>]*>Cancel<\/button><button[^>]*data-confirm="primary"[^>]*class="k-btn k-btn--primary"[^>]*>Replace<\/button>/);
    expect(m).toContain('tabindex="-1"');
  });

  it("a destructive confirmation has a red primary action; the inline panel is a group with Escape handling", () => {
    const d = html(<ConfirmPanel title="Cancel WT-007?" primaryLabel="Cancel task" cancelLabel="Keep it" danger onResolve={() => undefined} />);
    expect(d).toContain("k-dialog--danger");
    expect(d).toContain('class="k-btn k-btn--danger"');
    expect(d).toContain(">Keep it</button>");
    const i = html(<InlineConfirm title="Send it back?" text="The lead gets your note." primaryLabel="Send back" onResolve={() => undefined} />);
    expect(i).toContain('class="k-confirm-inline" role="group" aria-labelledby="');
    expect(i).toContain('<p class="k-confirm-inline__title" id="');
    expect(i).toContain(">Send back</button>");
  });

  it("the window.confirm fallback carries the title and the text", () => {
    expect(confirmFallbackText({ title: "Reset?", text: "All data is replaced." })).toBe("Reset?\n\nAll data is replaced.");
    expect(confirmFallbackText({ title: "Reset?" })).toBe("Reset?");
  });
});

describe("Tabs and SegmentedControl", () => {
  const tabs = [
    { id: "new", label: "New", count: 2 },
    { id: "all", label: "All" },
    { id: "back", label: "Sent back", disabled: true },
  ];

  it("arrow keys move and wrap, Home and End jump, disabled items are skipped", () => {
    expect(moveIndex(3, 0, "ArrowRight")).toBe(1);
    expect(moveIndex(3, 2, "ArrowRight")).toBe(0);
    expect(moveIndex(3, 0, "ArrowLeft")).toBe(2);
    expect(moveIndex(3, 1, "Home")).toBe(0);
    expect(moveIndex(3, 1, "End")).toBe(2);
    expect(moveIndex(3, 1, "ArrowDown")).toBeNull();
    expect(moveIndex(3, 1, "ArrowDown", "vertical")).toBe(2);
    expect(moveIndex(3, 1, "ArrowUp", "both")).toBe(0);
    expect(moveIndex(3, 1, "Enter")).toBeNull();
    expect(moveIndex(0, 0, "ArrowRight")).toBeNull();
    const skip = (i: number) => i === 2;
    expect(moveIndex(3, 1, "ArrowRight", "horizontal", skip)).toBe(0);
    expect(moveIndex(3, 0, "End", "horizontal", skip)).toBe(1);
    expect(moveIndex(3, 0, "ArrowRight", "horizontal", () => true)).toBeNull();
  });

  it("tabs have the roles, one selected tab in the tab order, and a panel labelled by it", () => {
    const m = html(
      <Tabs label="Show" tabs={tabs} value="all" onChange={() => undefined}>
        content
      </Tabs>,
    );
    expect(m).toContain('role="tablist" aria-label="Show"');
    expect(m.match(/role="tab"/g)).toHaveLength(3);
    expect(m).toMatch(/aria-selected="false"[^>]*tabindex="-1"[^>]*>New<span class="k-count">2<\/span>/);
    expect(m).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*>All</);
    expect(m).toMatch(/aria-selected="false"[^>]*tabindex="-1" disabled=""[^>]*>Sent back/);
    const panelId = attr(m, "aria-controls")[1];
    const tabId = attr(m, "id")[1];
    expect(m).toContain(`<div role="tabpanel" id="${panelId}" aria-labelledby="${tabId}" class="k-tabpanel" tabindex="0">content</div>`);
  });

  it("without children no panel is rendered; with no matching value the first tab is reachable", () => {
    const m = html(<Tabs label="Show" tabs={tabs} value="none" onChange={() => undefined} />);
    expect(m).not.toContain("tabpanel");
    expect(m).toMatch(/tabindex="0"[^>]*>New</);
  });

  it("the segmented control is a radio group with one checked radio in the tab order", () => {
    const m = html(
      <SegmentedControl
        label="View"
        size="small"
        value="board"
        onChange={() => undefined}
        options={[
          { value: "list", label: "List" },
          { value: "board", label: "Board" },
        ]}
      />,
    );
    expect(m).toContain('role="radiogroup" aria-label="View" class="k-seg k-seg--small"');
    expect(m).toMatch(/role="radio" class="k-seg__btn" aria-checked="false" tabindex="-1">List/);
    expect(m).toMatch(/role="radio" class="k-seg__btn" aria-checked="true" tabindex="0">Board/);
  });
});

describe("SideNav", () => {
  it("renders links with the current page marked, or buttons when there is no href", () => {
    const links = html(<SideNav label="Settings sections" current="project" items={[{ id: "style", label: "Working style", href: "#/settings/style" }, { id: "project", label: "Project", href: "#/settings/project", count: 1 }]} />);
    expect(links).toContain('<nav aria-label="Settings sections" class="k-sidenav">');
    expect(links).toContain('<a class="k-sidenav__link" href="#/settings/style">Working style</a>');
    expect(links).toContain('<a class="k-sidenav__link" href="#/settings/project" aria-current="page">Project<span class="k-count">1</span></a>');
    const buttons = html(<SideNav label="Sections" current="a" onSelect={() => undefined} items={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} />);
    expect(buttons).toContain('<button type="button" class="k-sidenav__link" aria-current="true">A</button>');
    expect(buttons).toContain('<button type="button" class="k-sidenav__link">B</button>');
  });
});

describe("StepList", () => {
  it("renders each mark with its word, the name, who and the state in words, and an action", () => {
    const m = html(
      <StepList
        label="Steps"
        steps={[
          { id: "1", name: "Design", who: "Claude", state: "done", mark: "done" },
          { id: "2", name: "Security review", who: "Claude", state: "running", mark: "running", action: <button>Send a note</button> },
          { id: "3", name: "UX review", who: "Codex", state: "1 finding needs you", mark: "you" },
          { id: "4", name: "Repair", state: "waits for your decision", mark: "waiting" },
          { id: "5", name: "Checks", state: "skipped: checks are off", mark: "skipped" },
          { id: "6", name: "Checks", who: "the service", state: "2 of 3 failed", mark: "fail" },
        ]}
      />,
    );
    expect(m).toContain('<ol class="k-steps" aria-label="Steps">');
    for (const mark of ["done", "running", "you", "waiting", "skipped", "fail"] as const) {
      expect(m).toContain(`<li class="k-step k-step--${mark}"><span class="k-step__mark" aria-hidden="true">${STEP_MARK[mark]}</span><span class="k-step__name"><span class="sr-only">${STEP_WORD[mark]}: </span>`);
    }
    expect(Object.values(STEP_MARK)).toEqual(["✓", "●", "!", "○", "–", "✕"]);
    expect(m).toContain('<span class="k-step__state">Claude · done</span>');
    expect(m).toContain('<span class="k-step__state">Codex · 1 finding needs you</span>');
    expect(m).toContain('<span class="k-step__state">waits for your decision</span>');
    expect(m).toContain('<span class="k-step__action"><button>Send a note</button></span>');
  });
});

describe("EmptyState and Toast", () => {
  it("the empty state has a title, text and an action", () => {
    expect(html(<EmptyState title="Nothing needs you." action={<button>Message the lead</button>}>Decisions appear here.</EmptyState>)).toBe(
      '<div class="k-empty"><p class="k-empty__title">Nothing needs you.</p><p class="k-empty__text">Decisions appear here.</p><div class="k-actions"><button>Message the lead</button></div></div>',
    );
  });

  it("an in-flow toast is a polite status, a failure an alert, each with its mark and a Dismiss", () => {
    const t = html(<Toast action={<button>Undo</button>} onDismiss={() => undefined}>Focus set.</Toast>);
    expect(t).toContain('<div role="status" aria-live="polite"><div class="k-toast k-toast--inline">');
    expect(t).toContain('<span class="k-toast__text">Focus set.</span><button>Undo</button><button type="button" class="k-btn k-btn--small">Dismiss</button>');
    const f = html(<Toast tone="fail">The service did not answer.</Toast>);
    expect(f).toContain('<div role="alert"><div class="k-toast k-toast--fail k-toast--inline"><span class="k-toast__mark" aria-hidden="true">!</span>');
    expect(html(<Toast tone="done">Seen.</Toast>)).toContain('<span class="k-toast__mark" aria-hidden="true">✓</span>');
  });
});

describe("a menu's list stays inside the window (Q-02)", () => {
  it("moves right off the left edge: the Project menu at 375 wide, beside the Paused pill, sat at -136 px", () => {
    expect(shiftIntoWindow({ left: -136, right: 104 }, 375)).toBe(144);
    expect(shiftIntoWindow({ left: 8, right: 248 }, 375)).toBe(0);
  });

  it("moves left off the right edge, never past the left one", () => {
    expect(shiftIntoWindow({ left: 200, right: 440 }, 375)).toBe(-73);
    // Wider than the room: its left edge stays in.
    expect(shiftIntoWindow({ left: 40, right: 420 }, 375)).toBe(-32);
  });
});
