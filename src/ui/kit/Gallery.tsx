// The kit gallery, at #/kit (not in the navigation). Every component in every state, on the dark theme, with the
// product's words. Use it to check that screens stay consistent.
import { useEffect, useState, type ReactNode } from "react";
import {
  Actions,
  Banner,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  Chip,
  ConfirmProvider,
  Disclosure,
  EmptyState,
  Field,
  InlineConfirm,
  Input,
  NeedsYouItem,
  Row,
  Rows,
  SegmentedControl,
  Select,
  SideNav,
  SideNavLayout,
  SimulatedChip,
  StatePill,
  StepList,
  Tabs,
  Textarea,
  Toast,
  ToastRegion,
  useConfirm,
  type StepItem,
  type ToastProps,
  type Tone,
} from "./index";

const SECTIONS = [
  ["tokens", "Tokens"],
  ["buttons", "Button"],
  ["chips", "Chip"],
  ["pills", "StatePill"],
  ["cards", "Card"],
  ["banners", "Banner"],
  ["rows", "Row and Needs you"],
  ["fields", "Field"],
  ["disclosure", "Disclosure"],
  ["confirm", "Confirm"],
  ["tabs", "Tabs and Segmented"],
  ["sidenav", "SideNav"],
  ["steps", "StepList"],
  ["empty", "EmptyState"],
  ["toast", "Toast"],
  ["narrow", "Narrow layouts"],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

function sectionFromHash(hash: string): SectionId {
  const part = hash.replace(/^#\/?/, "").split("/")[1];
  return (SECTIONS.find(([id]) => id === part)?.[0] ?? "tokens") as SectionId;
}

export function Gallery() {
  const [current, setCurrent] = useState<SectionId>(() => sectionFromHash(location.hash));
  useEffect(() => {
    const go = () => {
      const id = sectionFromHash(location.hash);
      setCurrent(id);
      if (location.hash.split("/").length > 2) document.getElementById(`kit-${id}`)?.scrollIntoView({ block: "start" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  return (
    <ConfirmProvider>
      <div className="k-gallery" data-kit-gallery>
        <SideNav label="Kit sections" current={current} items={SECTIONS.map(([id, label]) => ({ id, label, href: `#/kit/${id}` }))} />
        <div className="k-gallery__main">
          <div className="k-stack k-stack--tight">
            <h1>Component kit</h1>
            <p className="k-gallery__note">
              One small component per role, in <code>src/ui/kit</code>. Screens use these and nothing else for these roles; colour means state and nothing else. Every state is shown here, so a
              screen that looks different from this page is the thing to fix.
            </p>
          </div>
          <TokensSection />
          <ButtonsSection />
          <ChipsSection />
          <PillsSection />
          <CardsSection />
          <BannersSection />
          <RowsSection />
          <FieldsSection />
          <DisclosureSection />
          <ConfirmSection />
          <TabsSection />
          <SideNavSection />
          <StepsSection />
          <EmptySection />
          <ToastSection />
          <NarrowSection />
        </div>
      </div>
    </ConfirmProvider>
  );
}

function Section({ id, title, note, children }: { id: SectionId; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="k-gallery__section" id={`kit-${id}`} aria-labelledby={`kit-${id}-h`}>
      <h2 id={`kit-${id}-h`}>{title}</h2>
      {note && <p className="k-gallery__note">{note}</p>}
      {children}
    </section>
  );
}

function Demo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="k-gallery__demo">
      <p className="k-gallery__label">{label}</p>
      {children}
    </div>
  );
}

const TONES: Tone[] = ["neutral", "work", "you", "done", "fail"];
const TONE_WORD: Record<Tone, string> = { neutral: "Proposed", work: "Running", you: "Needs you", done: "Done", fail: "Failed" };

function TokensSection() {
  return (
    <Section id="tokens" title="Tokens" note="The spacing scale (--space-1 to --space-6) and the type scale (--fs-micro to --fs-h1). The kit uses these and the state colours; nothing is sized or coloured inline.">
      <div className="k-grid-2">
        <Demo label="Spacing">
          <div className="k-swatches">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div key={n} className={`k-swatch k-swatch--${n}`}>
                <span>--space-{n}</span>
                <i aria-hidden="true" />
              </div>
            ))}
          </div>
        </Demo>
        <Demo label="Type">
          <div className="k-type">
            {(["micro", "small", "meta", "body", "h3", "h2", "h1"] as const).map((s) => (
              <div key={s}>
                <span>--fs-{s}</span>
                <span className={`fs-${s}`}>Make the trail map readable</span>
              </div>
            ))}
          </div>
        </Demo>
      </div>
      <Demo label="State colours, each with its word">
        <div className="k-tones">
          {TONES.map((t) => (
            <StatePill key={t} tone={t}>
              {TONE_WORD[t]}
            </StatePill>
          ))}
        </div>
      </Demo>
    </Section>
  );
}

function ButtonsSection() {
  const [loading, setLoading] = useState(false);
  return (
    <Section id="buttons" title="Button" note="One primary action per screen. Secondary for the rest, quiet for the least important, danger for what cannot be undone.">
      <Demo label="Variants">
        <Actions>
          <Button variant="primary">Message the lead</Button>
          <Button>Pause</Button>
          <Button variant="quiet">More</Button>
          <Button variant="danger">Cancel task</Button>
          <ButtonLink href="#/kit/buttons">Open</ButtonLink>
        </Actions>
      </Demo>
      <Demo label="Small">
        <Actions>
          <Button variant="primary" size="small">
            Merge
          </Button>
          <Button size="small">Keep for me</Button>
          <Button variant="quiet" size="small">
            Send back…
          </Button>
          <Button variant="danger" size="small">
            Cancel
          </Button>
          <ButtonLink size="small" href="#/kit/buttons">
            Results
          </ButtonLink>
        </Actions>
      </Demo>
      <Demo label="Disabled: plain, with a reason in the title, and with the reason shown">
        <Actions>
          <Button disabled>Start</Button>
          <Button disabled disabledReason="Paused: resume the project first.">
            Start
          </Button>
          <Button variant="primary" disabled disabledReason="The service is offline; controls return when it reconnects." showReason>
            Merge
          </Button>
        </Actions>
      </Demo>
      <Demo label="Loading: the label says what is happening">
        <Actions>
          <Button loading>Pausing…</Button>
          <Button variant="primary" loading>
            Merging…
          </Button>
          <Button
            loading={loading}
            onClick={() => {
              setLoading(true);
              window.setTimeout(() => setLoading(false), 1500);
            }}
          >
            {loading ? "Sending…" : "Send a note"}
          </Button>
        </Actions>
      </Demo>
    </Section>
  );
}

function ChipsSection() {
  return (
    <Section id="chips" title="Chip" note="A small label: an area, a flow, a count, a provider. The one “simulated” chip is dashed, once per thing that could pass for real.">
      <Demo label="Tones">
        <div className="k-tones">
          <Chip>Accessibility</Chip>
          <Chip strong>Feature flow</Chip>
          <Chip tone="work">Claude · implementing</Chip>
          <Chip tone="you">1 finding</Chip>
          <Chip tone="done">Code ✓</Chip>
          <Chip tone="fail">Checks failed</Chip>
          <SimulatedChip />
        </div>
      </Demo>
      <Demo label="In a line">
        <p className="meta">
          <span className="k-row__id">WT-005</span> Pull request #1000 · <Chip tone="done">Code ✓</Chip> <Chip tone="done">Security ✓</Chip> <Chip tone="done">Checks ✓</Chip>{" "}
          <SimulatedChip title="Simulated pull request: nothing was sent to GitHub." />
        </p>
      </Demo>
    </Section>
  );
}

function PillsSection() {
  return (
    <Section id="pills" title="StatePill" note="The state of a task or a run, in words. The dot pulses only while agents work. A pause shows two bars.">
      <Demo label="Every state">
        <div className="k-tones">
          <StatePill tone="neutral">Proposed</StatePill>
          <StatePill tone="neutral">Ready</StatePill>
          <StatePill tone="neutral">Waiting for your go-ahead</StatePill>
          <StatePill tone="work" pulse>
            Running
          </StatePill>
          <StatePill tone="work" pulse>
            Reviewing
          </StatePill>
          <StatePill tone="work" pulse title="The runtime has not acknowledged the stop yet">
            Pausing…
          </StatePill>
          <StatePill tone="neutral" paused>
            Paused
          </StatePill>
          <StatePill tone="you">Needs you</StatePill>
          <StatePill tone="done">Done</StatePill>
          <StatePill tone="done">Landed</StatePill>
          <StatePill tone="fail">Failed</StatePill>
          <StatePill tone="neutral">Deferred</StatePill>
          <StatePill tone="neutral">Cancelled</StatePill>
        </div>
      </Demo>
    </Section>
  );
}

function CardsSection() {
  return (
    <Section id="cards" title="Card" note="A title, an optional count, actions at the right, a body. One card per thing.">
      <div className="k-grid-2">
        <Card title="Needs you" count={3} countTone="you">
          <p className="meta">Three things wait for a decision. The count is amber because they wait for you.</p>
        </Card>
        <Card title="New results" count={2} actions={<ButtonLink size="small" href="#/kit/cards">All results</ButtonLink>}>
          <p className="meta">A neutral count; an action in the head.</p>
        </Card>
      </div>
      <Card title="Focus" as="h3">
        <p>Offline maps first: the map must work with no signal.</p>
        <p className="small muted">Set by the lead from your message, 45 minutes ago.</p>
      </Card>
      <Card>
        <p className="meta">A card without a title: a plain surface.</p>
      </Card>
    </Section>
  );
}

function BannersSection() {
  return (
    <Section id="banners" title="Banner" note="One message across the content. Amber: something needs you. Neutral: something to know. Red: something failed. Green: something finished.">
      <Banner
        tone="you"
        title="A finding needs your decision"
        actions={
          <>
            <Button size="small">Fix: kilometres</Button>
            <Button size="small">Accept as is</Button>
            <Button size="small" variant="quiet">
              Message the lead
            </Button>
          </>
        }
      >
        <p>
          <strong>Read distances in miles or kilometres?</strong>
        </p>
        <p>The UX review found that VoiceOver reads raw metres. Choosing the unit is a product decision, so it waits for you.</p>
      </Banner>
      <Banner tone="info" title="Pausing" actions={<Button size="small">Resume</Button>}>
        Two runs are still stopping. The change is saved; “Paused” appears when the runtime acknowledges.
      </Banner>
      <Banner tone="fail" title="Service offline" actions={<Button size="small">Reconnect now</Button>}>
        Showing the last known state from 4 minutes ago. Controls are disabled until it reconnects.
      </Banner>
      <Banner tone="done" title="Landed in main" actions={<ButtonLink size="small" href="#/kit/banners">Results</ButtonLink>}>
        WT-011 Faster trail search. Code ✓ Security ✓ Checks ✓.
      </Banner>
      <Banner tone="info">A banner without a title or actions: one sentence.</Banner>
    </Section>
  );
}

function RowsSection() {
  return (
    <Section id="rows" title="Row and Needs you" note="One item in a list: main text, a meta line, actions on the right. They stack when the list is narrow. A Needs-you item names what is needed, and settles it in place.">
      <Card title="Needs you" count={3} countTone="you">
        <Rows label="Things that need you">
          <NeedsYouItem
            taskId="WT-007"
            title="Make the trail map readable with VoiceOver"
            href="#/kit/rows"
            what="Decide a finding:"
            detail="read distances in miles or kilometres?"
            actions={
              <>
                <Button size="small">Fix</Button>
                <Button size="small">Accept as is</Button>
                <Button size="small" variant="quiet">
                  Message the lead
                </Button>
              </>
            }
          />
          <NeedsYouItem
            taskId="WT-004.3"
            title="Join a trip without an account"
            href="#/kit/rows"
            what="Choose an approach:"
            detail="A, a guest link that expires · B, an account later"
            actions={
              <>
                <Button size="small">Choose A</Button>
                <Button size="small">Choose B</Button>
              </>
            }
          />
          <NeedsYouItem
            taskId="WT-005"
            title="Suggest a packing list from trail length and weather"
            href="#/kit/rows"
            what="Ready to merge:"
            detail={
              <>
                <Chip tone="done">Code ✓</Chip> <Chip tone="done">Security ✓</Chip> <Chip tone="done">Checks ✓</Chip>
              </>
            }
            simulated
            actions={
              <>
                <Button size="small" variant="primary">
                  Merge
                </Button>
                <Button size="small">Keep for me</Button>
              </>
            }
          />
        </Rows>
      </Card>
      <Card title="New results" count={2}>
        <Rows label="New results">
          <Row
            as="li"
            id="WT-011"
            title="Faster trail search"
            href="#/kit/rows"
            meta="Landed 2 days ago · Code ✓ Security ✓ · Search answers in under 100 ms on 5,000 trails."
            actions={
              <>
                <Button size="small">Mark as seen</Button>
                <Button size="small" variant="quiet">
                  Send back…
                </Button>
              </>
            }
          />
          <Row as="li" id="WT-001" title="Cache trail map tiles for offline use" href="#/kit/rows" meta="Landed 3 days ago · Code ✓ Security ✓" actions={<Button size="small">Mark as seen</Button>} />
          <Row as="li" title="A row without an id, a link or actions" meta="Only a meta line." />
        </Rows>
      </Card>
    </Section>
  );
}

function FieldsSection() {
  const [name, setName] = useState("");
  return (
    <Section id="fields" title="Field" note="Every control sits in a Field, so it is labelled and its hint and error are linked to it (aria-describedby, aria-invalid).">
      <div className="k-grid-2">
        <div>
          <Field label="Project name" hint="Shown in the header and in the lead's messages." width="medium">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekend Trips" />
          </Field>
          <Field label="Agents at once" hint="How many agents may work at the same time." width="short">
            <Input type="number" defaultValue={3} min={1} max={8} />
          </Field>
          <Field label="Repository" error="This folder is not a git repository." width="medium">
            <Input defaultValue="~/Code/weekend-trips" />
          </Field>
          <Field label="Branch" hint="Disabled while the project is paused." width="medium">
            <Input defaultValue="main" disabled />
          </Field>
        </div>
        <div>
          <Field label="Message the lead" hint="It replies here and may change the plan; every change has Undo.">
            <Textarea placeholder="Offline maps first: the map must work with no signal." />
          </Field>
          <Field label="Who merges a pull request" width="medium">
            <Select
              defaultValue="you"
              options={[
                { value: "you", label: "You merge" },
                { value: "auto", label: "Merges automatically" },
              ]}
            />
          </Field>
          <Checkbox label="Notify me in this browser" hint="When something needs you or a result lands." defaultChecked />
          <Checkbox label="Wait for my go-ahead before each task starts" />
          <Checkbox label="Run checks in a sandbox" hint="Not available on this machine." disabled />
        </div>
      </div>
    </Section>
  );
}

function DisclosureSection() {
  return (
    <Section id="disclosure" title="Disclosure" note="The rest, a click away. Native details and summary, with a noun for a label and an optional count.">
      <Disclosure label="Details">
        <p className="meta">Spec and options, outputs, runs, activity, revisions and models would sit here.</p>
      </Disclosure>
      <Disclosure label="Outputs" count={7} defaultOpen>
        <ul className="plain meta">
          <li>S1.design v1</li>
          <li>S2.change v2</li>
          <li>S3.checks v1</li>
        </ul>
      </Disclosure>
      <p className="meta">
        6 files, +167 −12.{" "}
        <Disclosure label="Why it's ready" inline>
          <span className="muted">Code review: no findings. Security review: no findings. Checks passed on the merge commit.</span>
        </Disclosure>
      </p>
    </Section>
  );
}

function ConfirmSection() {
  const confirm = useConfirm();
  const [last, setLast] = useState<string>("Nothing chosen yet.");
  const [inline, setInline] = useState(false);
  return (
    <Section id="confirm" title="Confirm" note="An in-page confirmation instead of the browser's confirm(). The dialog traps focus and gives it back; Escape cancels; Enter on the dialog accepts. A destructive one starts on Cancel.">
      <Demo label="Modal, through useConfirm()">
        <Actions>
          <Button
            onClick={async () => {
              const ok = await confirm({ title: "Replace all data with the sample project?", text: "Every task, run and message in this service is replaced. The sample project is the demo's.", primaryLabel: "Replace" });
              setLast(ok ? "You chose Replace." : "You cancelled.");
            }}
          >
            Reset sample data
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await confirm({ title: "Cancel WT-007?", text: "The agent working on it is stopped.\nThe spec and the partial outputs are kept. A cancel cannot be undone.", primaryLabel: "Cancel task", cancelLabel: "Keep it", danger: true });
              setLast(ok ? "You chose Cancel task." : "You kept it.");
            }}
          >
            Cancel task
          </Button>
          <span className="meta muted" aria-live="polite">
            {last}
          </span>
        </Actions>
      </Demo>
      <Demo label="Inline, under the control that asked">
        <div>
          <Button size="small" variant="quiet" onClick={() => setInline(true)} aria-expanded={inline}>
            Send back…
          </Button>
          {inline && (
            <InlineConfirm
              title="Send WT-011 back to the lead?"
              text="It leaves Results and the lead gets your note. The landed code stays in main."
              primaryLabel="Send back"
              cancelLabel="Keep"
              onResolve={(ok) => {
                setInline(false);
                setLast(ok ? "You sent it back." : "You kept it in Results.");
              }}
            />
          )}
        </div>
      </Demo>
    </Section>
  );
}

function TabsSection() {
  const [tab, setTab] = useState("new");
  const [view, setView] = useState<"list" | "board">("list");
  const [who, setWho] = useState<"you" | "auto" | "keep">("you");
  return (
    <Section id="tabs" title="Tabs and SegmentedControl" note="Tabs switch a view in place; a segmented control chooses one of a few. Both move with the arrow keys, Home and End.">
      <Demo label="Tabs with counts and a panel">
        <Tabs
          label="Show"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "new", label: "New", count: 2 },
            { id: "all", label: "All", count: 14 },
            { id: "back", label: "Sent back", count: 1 },
            { id: "off", label: "Archived", disabled: true },
          ]}
        >
          <p className="meta">{tab === "new" ? "Two results you have not seen." : tab === "all" ? "Everything that landed." : "One result the lead is reworking."}</p>
        </Tabs>
      </Demo>
      <Demo label="Segmented: normal and small">
        <Actions>
          <SegmentedControl
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
            ]}
          />
          <SegmentedControl
            label="Who merges a pull request"
            size="small"
            value={who}
            onChange={setWho}
            options={[
              { value: "you", label: "You merge" },
              { value: "auto", label: "Merges automatically" },
              { value: "keep", label: "Keep for me", disabled: true },
            ]}
          />
        </Actions>
      </Demo>
    </Section>
  );
}

const SETTINGS_SECTIONS = [
  { id: "style", label: "Working style" },
  { id: "project", label: "Project" },
  { id: "agents", label: "Agents" },
  { id: "quality", label: "Quality", count: 1 },
  { id: "advanced", label: "Advanced" },
];

function SideNavSection() {
  const [section, setSection] = useState("style");
  return (
    <Section id="sidenav" title="SideNav" note="The sections of a long page, down the side; a horizontal scroller when there is no side.">
      <SideNavLayout nav={<SideNav label="Settings sections" items={SETTINGS_SECTIONS} current={section} onSelect={setSection} />}>
        <Card title={SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? ""} as="h3">
          <p className="meta">The section's cards would be here. Choose another section to see the current mark move.</p>
        </Card>
      </SideNavLayout>
    </Section>
  );
}

const STEPS: StepItem[] = [
  { id: "design", name: "Design", who: "Claude", state: "done", mark: "done" },
  { id: "implement", name: "Implement", who: "Codex", state: "done", mark: "done" },
  { id: "checks", name: "Checks", who: "the service", state: "passed", mark: "done" },
  { id: "code", name: "Code review", who: "Claude", state: "no findings", mark: "done" },
  { id: "security", name: "Security review", who: "Claude", state: "running", mark: "running", action: <Button size="small">Send a note</Button> },
  { id: "ux", name: "UX review", who: "Codex", state: "1 finding needs you", mark: "you" },
  { id: "repair", name: "Repair", state: "waits for your decision", mark: "waiting" },
  { id: "final", name: "Final checks, then the lead verifies", state: "not started", mark: "waiting" },
];

function StepsSection() {
  return (
    <Section id="steps" title="StepList" note="A task's steps: a mark, the name, who does it and the state in words. ✓ done, ● running, ! needs you, ○ waiting, – skipped, ✕ failed.">
      <div className="k-grid-2">
        <Card title="Steps" as="h3" actions={<Chip strong>Feature flow</Chip>}>
          <StepList label="Steps of WT-007" steps={STEPS} />
        </Card>
        <Card title="Other marks" as="h3">
          <StepList
            label="Steps of WT-006"
            steps={[
              { id: "a", name: "Implement", who: "Claude", state: "done", mark: "done" },
              { id: "b", name: "Checks", who: "the service", state: "2 of 3 failed", mark: "fail", action: <Button size="small">Open the check output</Button> },
              { id: "c", name: "Security review", state: "skipped: no code changed", mark: "skipped" },
              { id: "d", name: "Repair", who: "Codex", state: "waiting for your go-ahead", mark: "waiting", action: <Button size="small" variant="primary">Start</Button> },
            ]}
          />
        </Card>
      </div>
    </Section>
  );
}

function EmptySection() {
  return (
    <Section id="empty" title="EmptyState" note="Nothing here yet, said plainly: what would appear, and how to make it appear.">
      <div className="k-grid-2">
        <Card title="Needs you" as="h3">
          <EmptyState title="Nothing needs you.">Decisions, findings and pull requests that wait for you appear here.</EmptyState>
        </Card>
        <Card title="Results" as="h3">
          <EmptyState title="No results yet." action={<Button size="small">Message the lead</Button>}>
            When a task lands in main it appears here, with what changed and who reviewed it.
          </EmptyState>
        </Card>
      </div>
    </Section>
  );
}

function ToastSection() {
  const [toast, setToast] = useState<ToastProps | null>(null);
  const show = (t: ToastProps) => {
    setToast({ ...t, onDismiss: () => setToast(null) });
    window.setTimeout(() => setToast(null), 5000);
  };
  return (
    <Section id="toast" title="Toast" note="A short confirmation at the bottom, in a polite live region; a failure is an alert. One action at most, usually Undo.">
      <Demo label="In the flow of the page">
        <Toast action={<Button size="small">Undo</Button>} onDismiss={() => undefined}>
          Focus set: Offline maps first.
        </Toast>
        <Toast tone="done" onDismiss={() => undefined}>
          Marked 2 results as seen.
        </Toast>
        <Toast tone="fail" onDismiss={() => undefined}>
          The service did not answer. Nothing changed.
        </Toast>
      </Demo>
      <Demo label="Floating, through ToastRegion">
        <Actions>
          <Button size="small" onClick={() => show({ children: "Note sent to the security reviewer." })}>
            Show a toast
          </Button>
          <Button size="small" onClick={() => show({ tone: "fail", children: "The note was not sent: the run has ended." })}>
            Show a failure
          </Button>
        </Actions>
        <ToastRegion toast={toast} />
      </Demo>
    </Section>
  );
}

function NarrowSection() {
  const [section, setSection] = useState("style");
  return (
    <Section id="narrow" title="Narrow layouts" note="The same components in a 360 px frame, as in a drawer or on a phone: rows and banners stack, the step state moves under the name, the side nav scrolls sideways.">
      <div className="k-narrow">
        <SideNav label="Settings sections (narrow)" items={SETTINGS_SECTIONS} current={section} onSelect={setSection} />
        <Banner tone="you" title="A finding needs your decision" actions={<Button size="small">Decide</Button>}>
          Read distances in miles or kilometres?
        </Banner>
        <Card title="Needs you" count={1} countTone="you" as="h3">
          <Rows label="Things that need you (narrow)">
            <NeedsYouItem
              taskId="WT-005"
              title="Suggest a packing list from trail length and weather"
              what="Ready to merge:"
              simulated
              actions={
                <>
                  <Button size="small" variant="primary">
                    Merge
                  </Button>
                  <Button size="small">Keep for me</Button>
                </>
              }
            />
          </Rows>
        </Card>
        <Card title="Steps" as="h3">
          <StepList label="Steps (narrow)" steps={STEPS.slice(3, 7)} />
        </Card>
      </div>
    </Section>
  );
}
