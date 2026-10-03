// The pre-flight (ORC-029 pass 6, screen 7 of the pass 1 prototype), `#/vision/pre-flight`: the one way the factory
// starts, on the owner's explicit agreement. One screen shows the blueprint (by focus, with PE review on each approved
// item, and what is still open), the first Lock in's summary (the Lock in screen's own parts), what the factory will
// do, and how it runs, which the owner sets here. Start the factory sends `startFactory` with the revisions and the
// open items this screen showed; when they change while the owner reads, the screen says so, shows the new pre-flight
// and clears the agreement. After the start, it says what was recorded and links to the factory floor (Home).
// The words are in preflightView.ts.

import { useEffect, useState } from "react";
import * as M from "../../domain/model";
import type { FactorySettings, State } from "../../domain/types";
import { Banner, Button, ButtonLink, Card, Checkbox, Chip, Row, Rows, SegmentedControl, SimulatedChip } from "../kit";
import { cardHref } from "../settings/sections";
import { useStore } from "../store";
import { LockInBudgets, LockInChanges, LockInNewWork, LockInTasks } from "../studio/LockIn";
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
  const building = state.project.stage === "building";
  // The draft, the vision, the summary or what is open changed under the screen (another tab, the lead, a probe, a
  // budget, a refused stale start): show the new pre-flight, and ask for the agreement again.
  useEffect(() => {
    if (building || busy || V.sameSeen(now, seen)) return;
    setSeen(now);
    setAgreed(false);
    setStale(true);
  }, [building, busy, now, seen]);

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
}

/** The pre-flight as it stands: what the owner reads, the settings they chose, and their agreement. */
export function Preflight(p: PreflightProps) {
  const s = p.state;
  const started = V.startedWords(s);
  const blocker = M.startFactoryBlocker(s);
  const open = V.openLines(s);
  const w = lockInWords(s);
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
            <Banner tone="fail" title="The factory cannot start yet." actions={<ButtonLink size="small" href="#/overview">Write the vision</ButtonLink>}>
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
            <FactoryCard state={s} settings={p.settings} />
          </div>
          <Card title="Your first Lock in" className="pf-card">
            <p className="small no-margin">
              Start the factory is your first Lock in.{" "}
              {w.changes ? `It puts the draft into force as Lock in ${w.rev}, and records this summary with your agreement. The open items stay in the draft.` : "The draft approves nothing yet, so nothing goes into force. The factory starts from the vision text."}
            </p>
            {w.changes > 0 && (
              <>
                <LockInChanges w={w} />
                <LockInTasks w={w} />
                <LockInNewWork w={w} />
              </>
            )}
          </Card>
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

/** What the draft approves by focus, with PE review on each item, and what is still open. */
function BlueprintCard({ state, open }: { state: State; open: V.OpenLine[] }) {
  const groups = V.blueprintByFocus(state);
  return (
    <Card title="The blueprint" className="pf-card">
      {groups.length ? (
        groups.map((g) => (
          <section key={g.focus} aria-label={g.focus}>
            <h3>
              {g.focus} · {g.items.length} approved
            </h3>
            <ul className="pf-items">
              {g.items.map((i) => (
                <li key={i.itemId}>
                  <span>{i.name}</span>
                  <Chip tone={i.pe.tone} title={i.pe.why}>
                    {i.pe.word}
                  </Chip>
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="small muted no-margin">Nothing is approved yet. The factory builds from the vision text alone.</p>
      )}
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

/** The tasks planned from the blueprint, the agents and their limits, and the budgets beside the PE's estimate. */
function FactoryCard({ state, settings }: { state: State; settings: FactorySettings }) {
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
        <ul className="st-lockin__list small">
          {[...V.roleLines(state), ...V.limitLines(state)].map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="small no-margin">
          <a href="#/settings/agents">Change them in Settings › Agents</a>
        </p>
      </section>
      <LockInBudgets w={lockInWords(state)} title="The budgets and the PE's estimate" />
      <p className="small no-margin">
        <a href={cardHref("budgets")}>{state.project.budgets.buildingUsd === null && state.project.budgets.maintenanceUsdPerMonth === null ? "Set the budgets in Settings › Project › Budgets" : "Change them in Settings › Project › Budgets"}</a>
      </p>
    </Card>
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
