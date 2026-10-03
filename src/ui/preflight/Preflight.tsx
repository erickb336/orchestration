// The pre-flight (ORC-029 pass 6, screen 7 of the pass 1 prototype), `#/vision/pre-flight`: the one way the factory
// starts, on the owner's explicit agreement. One screen shows the blueprint as one list (ORC-030 C1: each part with its
// focus, new or changed, the PE's verdict and estimate; Start the factory is the first Lock in, so this is also what
// it changes), what is still open, what the factory will do (the tasks, the agents in one line, the two budgets as
// fields beside the PE's estimate), and how it runs, which the owner sets here. Start the factory sends `startFactory`
// with the revisions and the open items this screen showed; when they change while the owner reads, the screen says
// so, shows the new pre-flight and clears the agreement (not when the owner saved the budgets here). After the start,
// it says what was recorded and links to the factory floor (Home). The words are in preflightView.ts.

import { useEffect, useRef, useState } from "react";
import * as M from "../../domain/model";
import type { FactorySettings, State } from "../../domain/types";
import { Banner, Button, ButtonLink, Card, Checkbox, Chip, Field, Input, Row, Rows, SegmentedControl, SimulatedChip } from "../kit";
import { budgetAmount, budgetProblem, liveBudgets, type BudgetsDraft } from "../settings/budgets";
import { cardHref } from "../settings/sections";
import { useStore } from "../store";
import { LockInTasks } from "../studio/LockIn";
import { lockInWords } from "../studio/lockInView";
import * as V from "./preflightView";
import "../studio/studio.css";
import "./preflight.css";

export function PreflightPage() {
  const { state, send, disabled, service } = useStore();
  const now = V.seenNow(state);
  /** What this screen shows, which the start names. */
  const [seen, setSeen] = useState(now);
  const [settings, setSettings] = useState(() => M.currentFactorySettings(state));
  const [agreed, setAgreed] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The budgets the owner saves on this screen, until the state shows them. */
  const ownBudgets = useRef<State["project"]["budgets"] | null>(null);
  const building = state.project.stage === "building";
  // The draft, the vision, the summary or what is open changed under the screen (another tab, the lead, a probe, a
  // budget, a refused stale start): show the new pre-flight, and ask for the agreement again. The budgets the owner
  // saves here change the summary too: the screen shows them at once, with no stale banner.
  useEffect(() => {
    if (building || busy || V.sameSeen(now, seen)) return;
    if (V.ownBudgetsSaved(now, seen, state.project.budgets, ownBudgets.current)) {
      ownBudgets.current = null;
      setSeen(now);
      return;
    }
    setSeen(now);
    setAgreed(false);
    setStale(true);
  }, [building, busy, now, seen, state.project.budgets]);

  const start = async () => {
    if (V.startGate(state, agreed, disabled) || !V.sameSeen(now, seen)) return;
    const c = V.startFactoryCommand(seen, settings);
    setBusy(true);
    await send(c.name, c.args);
    setBusy(false);
  };

  return (
    <Preflight
      state={state}
      settings={settings}
      agreed={agreed}
      stale={stale}
      busy={busy}
      offline={disabled}
      simulated={service.runtime !== "real"}
      onSettings={setSettings}
      onAgree={(v) => (setAgreed(v), setStale(false))}
      onStart={() => void start()}
      onBudgetsSaving={(b) => (ownBudgets.current = b)}
    />
  );
}

export interface PreflightProps {
  state: State;
  settings: FactorySettings;
  agreed: boolean;
  stale: boolean;
  busy: boolean;
  offline: boolean;
  simulated: boolean;
  onSettings: (x: FactorySettings) => void;
  onAgree: (v: boolean) => void;
  onStart: () => void;
  /** The owner saves the budgets on the screen (the budgets), or the save failed (null). */
  onBudgetsSaving?: (saved: State["project"]["budgets"] | null) => void;
}

/** The pre-flight as it stands: what the owner reads, the settings they chose, and their agreement. */
export function Preflight(p: PreflightProps) {
  const s = p.state;
  const started = V.startedWords(s);
  const blocker = M.startFactoryBlocker(s);
  const open = V.openLines(s);
  const gate = V.startGate(s, p.agreed, p.offline);
  return (
    <div className="k-stack pf-page">
      <header className="pf-head">
        <p className="small muted no-margin">
          <a href="#/vision">Vision</a> › Start the factory
        </p>
        <h1 className="no-margin">{started ? started.title : "Start the factory?"}</h1>
        {!started && (
          <p className="small muted no-margin">
            Your agreement covers the draft and vision r{M.currentVision(s).rev} as this screen shows them. After the start, many agents build at once, and a change to the blueprint becomes a change order.{" "}
            {p.simulated && <SimulatedChip title="Simulated: the factory's runs are simulated. No model builds anything, and nothing leaves this computer." />}
          </p>
        )}
      </header>
      {started ? (
        <Started words={started} />
      ) : (
        <>
          {blocker && (
            <Banner tone="fail" title="The factory cannot start yet." actions={<ButtonLink size="small" href="#/vision">Write the vision</ButtonLink>}>
              {blocker}
            </Banner>
          )}
          {p.stale && (
            <Banner tone="you" title="The draft, the vision, the summary or what is open changed while you read.">
              This is the new pre-flight. Read it again, and agree again to start the factory.
            </Banner>
          )}
          <div className="k-grid-2 pf-grid">
            <BlueprintCard state={s} open={open} />
            <FactoryCard state={s} settings={p.settings} onBudgetsSaving={p.onBudgetsSaving} />
          </div>
          <HowItRuns state={s} settings={p.settings} onSettings={p.onSettings} />
          <Card title="Your agreement" className="pf-card">
            <Checkbox label={V.agreementWords(open.length)} checked={p.agreed} onChange={(e) => p.onAgree(e.target.checked)} disabled={!!blocker || p.offline} />
            <div className="k-actions">
              <Button variant="primary" disabled={!!gate} disabledReason={gate} showReason={!!blocker || p.offline} loading={p.busy} onClick={p.onStart}>
                {p.busy ? "Starting…" : "Start the factory"}
              </Button>
              <ButtonLink variant="quiet" href="#/vision">
                Not yet
              </ButtonLink>
            </div>
            <p className="small muted no-margin">Only you can start the factory. The start records who agreed, when, what this screen showed, and how the factory runs.</p>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * The blueprint as one list (ORC-030 a-pre-one-list): each part the start puts into force, with its focus, new or
 * changed, the PE's verdict and its estimate; the tasks it touches and the new work, when there are any; then what is
 * still open. Start the factory is the first Lock in, so this is also its summary of what changes.
 */
function BlueprintCard({ state, open }: { state: State; open: V.OpenLine[] }) {
  const parts = V.partLines(state);
  const w = lockInWords(state);
  const newWork = V.newWorkLine(state);
  return (
    <Card title="The blueprint" count={parts.length || undefined} className="pf-card">
      <p className="small no-margin">
        {w.changes
          ? `Start the factory is your first Lock in: it puts ${parts.length === 1 ? "this part" : `these ${parts.length} parts`} into force as Lock in ${w.rev}, and records this summary with your agreement.`
          : "Nothing is approved yet. The factory builds from the vision text alone."}
      </p>
      {parts.length > 0 && (
        <Rows label="The parts">
          {parts.map((part) => (
            <Row
              as="li"
              key={part.itemId}
              title={part.name}
              meta={
                <>
                  <span>{part.focus}</span>
                  <span aria-hidden="true">·</span>
                  <Chip tone={part.change === "dropped" ? "fail" : part.change === "changed" ? "work" : "neutral"}>{part.change}</Chip>
                  {part.pe && (
                    <Chip tone={part.pe.tone} title={part.pe.why}>
                      {part.pe.word}
                    </Chip>
                  )}
                  {part.estimate && <span>{part.estimate === "no estimate" ? "No estimate" : `Estimate: ${part.estimate}`}</span>}
                </>
              }
            />
          ))}
        </Rows>
      )}
      {w.tasks.length > 0 && <LockInTasks w={w} />}
      {newWork && <p className="small muted no-margin">{newWork}</p>}
      <section aria-label="Still open">
        <h3>Still open</h3>
        {open.length ? (
          <>
            <ul className="pf-open">
              {open.map((o) => (
                <li key={o.key}>
                  <Chip tone="you">Open</Chip>
                  <span>{o.text}</span>
                </li>
              ))}
            </ul>
            <p className="small muted no-margin">None of these stops the start. Your agreement below confirms them as they are.</p>
          </>
        ) : (
          <p className="small muted no-margin">Nothing: every area of the vision is clear, and every part of the draft is settled.</p>
        )}
      </section>
    </Card>
  );
}

/** The tasks planned from the blueprint, the agents in one line, and the budgets beside the PE's estimate. */
function FactoryCard({ state, settings, onBudgetsSaving }: { state: State; settings: FactorySettings; onBudgetsSaving?: (saved: Budgets | null) => void }) {
  const plan = V.plannedTasks(state, settings);
  return (
    <Card title="What the factory will do" className="pf-card">
      <section aria-label="The tasks">
        <h3>The tasks</h3>
        <p className="small no-margin">{plan.summary}</p>
        {plan.tasks.length > 0 && (
          <Rows label="The planned tasks">
            {plan.tasks.map((t) => (
              <Row
                as="li"
                key={t.id}
                id={t.id}
                title={t.title}
                href={`#/task/${encodeURIComponent(t.id)}`}
                meta={
                  <>
                    <Chip>{t.flow}</Chip>
                    <span>{t.outcome}</span>
                  </>
                }
              />
            ))}
          </Rows>
        )}
      </section>
      <section aria-label="The agents">
        <h3>The agents</h3>
        <p className="small no-margin">
          {V.agentsLine(state)} <a href="#/settings/agents">Change in Settings</a>
        </p>
      </section>
      <PreflightBudgets state={state} onSaving={onBudgetsSaving} />
    </Card>
  );
}

type Budgets = State["project"]["budgets"];

/**
 * The two budgets on the pre-flight (ORC-030 a-pre-budgets): the fields hold the project's budgets (the same setting as
 * Settings › Project › Budgets, through the same `setBudgets`), each beside the spend and the PE's estimate. Until you
 * type, they follow the setting; Save sends both, and Cancel puts the setting back in the fields.
 */
function PreflightBudgets({ state, onSaving }: { state: State; onSaving?: (saved: Budgets | null) => void }) {
  const { send, disabled } = useStore();
  const live = liveBudgets(state);
  const [edit, setEdit] = useState<BudgetsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const v = edit ?? live;
  const changed = !!edit && (edit.buildingUsd !== live.buildingUsd || edit.maintenanceUsd !== live.maintenanceUsd);
  const problem = budgetProblem(v.buildingUsd) ?? budgetProblem(v.maintenanceUsd);
  const beside = V.budgetsBeside(state, budgetAmount(v.buildingUsd) != null);
  const set = (p: Partial<BudgetsDraft>) => setEdit({ ...v, ...p });
  const save = async () => {
    if (!changed || problem || saving) return;
    const saved = { buildingUsd: budgetAmount(v.buildingUsd) ?? null, maintenanceUsdPerMonth: budgetAmount(v.maintenanceUsd) ?? null };
    // Said before the command: the state it brings may arrive before the command's answer.
    onSaving?.(saved);
    setSaving(true);
    const r = await send("setBudgets", saved);
    setSaving(false);
    if (r.ok) setEdit(null);
    else onSaving?.(null);
  };
  return (
    <section aria-label="The budgets" className="k-stack k-stack--tight">
      <h3>The budgets</h3>
      <div className="pf-budgets">
        <Field label="Building budget (dollars)" hint={beside.building} error={budgetProblem(v.buildingUsd)}>
          <Input type="text" inputMode="decimal" value={v.buildingUsd} placeholder="Not set" onChange={(e) => set({ buildingUsd: e.target.value })} />
        </Field>
        <Field label="Maintenance budget (dollars a month)" hint={beside.maintenance} error={budgetProblem(v.maintenanceUsd)}>
          <Input type="text" inputMode="decimal" value={v.maintenanceUsd} placeholder="Not set" onChange={(e) => set({ maintenanceUsd: e.target.value })} />
        </Field>
      </div>
      {changed && (
        <div className="k-actions">
          <Button size="small" variant="primary" disabled={disabled || !!problem} disabledReason={disabled ? "The service is offline." : problem} loading={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save the budgets"}
          </Button>
          <Button size="small" variant="quiet" onClick={() => setEdit(null)}>
            Cancel
          </Button>
        </div>
      )}
      <p className="micro muted no-margin">
        The same budgets as in <a href={cardHref("budgets")}>Settings › Project › Budgets</a>. Each is an estimate at the providers' published prices, not a bill.
      </p>
    </section>
  );
}

const AUTONOMY_OPTIONS = [
  { value: "autopilot" as const, label: "Autopilot" },
  { value: "checkin" as const, label: "Check-in" },
  { value: "manual" as const, label: "Manual" },
];

/** How the factory runs, set here: how much it does on its own, who merges, and where it pauses or asks you. */
function HowItRuns({ state, settings: x, onSettings }: { state: State; settings: FactorySettings; onSettings: (x: FactorySettings) => void }) {
  const pr = x.delivery.mode === "pr";
  const manual = x.autonomy === "manual";
  return (
    <Card title="How the factory runs" className="pf-card">
      <p className="small muted no-margin">Set here. You can change each one later in Settings.</p>
      <div className="k-grid-2 pf-choices">
        <div className="pf-q">
          <span className="pf-q__label">How much it does on its own</span>
          <SegmentedControl label="How much it does on its own" options={AUTONOMY_OPTIONS} value={x.autonomy} onChange={(m) => onSettings(V.chooseAutonomy(x, m))} />
          <p className="small muted no-margin">{V.AUTONOMY_HELP[x.autonomy]}</p>
        </div>
        <div className="pf-q">
          <span className="pf-q__label">Who merges</span>
          <SegmentedControl
            label="Who merges"
            options={[
              { value: "user" as const, label: "You merge", disabled: !pr && x.delivery.merge !== "user" },
              { value: "auto" as const, label: "Merges automatically", disabled: !pr && x.delivery.merge !== "auto" },
            ]}
            value={x.delivery.merge}
            onChange={(m) => onSettings(V.chooseMerge(x, m))}
          />
          <p className="small muted no-margin">{V.deliveryHelp(x)}</p>
        </div>
      </div>
      <section aria-label="Where it pauses or asks for your input" className="k-stack k-stack--tight">
        <h3>Where it pauses or asks for your input</h3>
        <Checkbox label="At the building budget: it always stops and asks you" checked disabled hint={V.budgetStopHelp(state)} />
        <Checkbox label="Trade-off decisions: ask me" checked={x.pausePoints.tradeoffs === "user"} onChange={(e) => onSettings(V.chooseTradeoffs(x, e.target.checked))} hint={x.pausePoints.tradeoffs === "user" ? "Each finding that needs a decision comes to you." : V.tradeoffsOffHelp(x)} />
        <Checkbox
          label="Change orders: ask me before the lead updates the tasks"
          checked={x.pausePoints.changeOrders === "user"}
          onChange={(e) => onSettings(V.chooseChangeOrders(x, e.target.checked))}
          hint={x.pausePoints.changeOrders === "user" ? "Each update waits for your go-ahead on the change order." : "Off: the lead updates the tasks, and you can undo each update."}
        />
        <Checkbox
          label="Before each task starts: wait for my go-ahead"
          checked={manual || x.pausePoints.startEachTask}
          disabled={manual}
          onChange={(e) => onSettings(V.chooseWaitBeforeEachTask(x, e.target.checked))}
          hint={manual ? "On Manual nothing starts until you start it." : "On, the factory runs on Check-in. Off, it runs on Autopilot."}
        />
        <Checkbox label="Before merging: I merge each pull request" checked={x.delivery.merge === "user"} disabled={!pr} onChange={(e) => onSettings(V.chooseMerge(x, e.target.checked ? "user" : "auto"))} hint={pr ? "Off: each pull request merges after an independent review and passing checks." : "You choose this only with pull requests: see Who merges."} />
      </section>
    </Card>
  );
}

/** After the start: what was recorded, and the way to the factory floor. */
function Started({ words }: { words: { title: string; lines: string[] } }) {
  return (
    <Banner
      tone="done"
      actions={
        <>
          <ButtonLink size="small" variant="primary" href="#/overview">
            Go to the factory floor
          </ButtonLink>
          <ButtonLink size="small" variant="quiet" href="#/vision">
            Open Vision
          </ButtonLink>
        </>
      }
    >
      <ul className="pf-started">
        {words.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Banner>
  );
}
