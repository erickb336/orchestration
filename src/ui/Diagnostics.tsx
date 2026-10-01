// ORC-025 pass 2 (H2): usage and the service's details, moved from Home to Settings. They are diagnostics,
// not the daily view: token use and provider-reported cost per model, how busy each provider is now, and
// where the service runs. Settings renders them as one card, "Usage and service".

import { useState } from "react";
import * as M from "../domain/model";
import { PROVIDERS, isProvider, type Attempt, type ProviderId } from "../domain/types";
import { fmtTime, involvementOf } from "./common";
import { Card, SegmentedControl } from "./kit";
import { INVOLVEMENT_NAME } from "./Overview";
import { useStore } from "./store";

type Usage = NonNullable<Attempt["usage"]>;
interface Tally {
  runs: number;
  reported: number;
  input: number;
  output: number;
  cost: number;
  costRuns: number;
}
const emptyTally = (): Tally => ({ runs: 0, reported: 0, input: 0, output: 0, cost: 0, costRuns: 0 });

function add(t: Tally, u: Usage | undefined) {
  t.runs += 1;
  if (!u) return;
  if (u.inputTokens !== undefined || u.outputTokens !== undefined) t.reported += 1;
  t.input += u.inputTokens ?? 0;
  t.output += u.outputTokens ?? 0;
  if (u.costUsd !== undefined) {
    t.cost += u.costUsd;
    t.costRuns += 1;
  }
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const fmtCost = (t: Tally) => (t.costRuns ? `$${t.cost.toFixed(2)}` : "—");

/** Settings › Advanced, its last card: usage, then the service. */
export function DiagnosticsCard() {
  return (
    <Card title="Usage and service" id="diagnostics" as="h3">
      <div className="k-stack">
        <UsageCard />
        <ServiceCard />
      </div>
    </Card>
  );
}

/** Token use and provider-reported cost per provider and model, plus how busy each provider is now. A section of "Usage and service". */
export function UsageCard() {
  const { state } = useStore();
  const [range, setRange] = useState<"today" | "all">("today");
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const inRange = (iso: string) => range === "all" || Date.parse(iso) >= startOfToday.getTime();

  // Agent and lead runs, each with the model the provider reported when known.
  // ORC-013: service runs (checks) use no model tokens and are not counted.
  const rows: { provider: ProviderId; model: string; at: string; usage?: Usage; lead: boolean }[] = [
    ...state.attempts.flatMap((a) => (isProvider(a.snapshot.provider) ? [{ provider: a.snapshot.provider, model: a.actualModel ?? a.snapshot.model, at: a.endedAt ?? a.startedAt, usage: a.usage, lead: false }] : [])),
    ...state.leadRuns.map((r) => ({ provider: r.provider, model: r.actualModel ?? r.model, at: r.endedAt ?? r.startedAt, usage: r.usage, lead: true })),
  ].filter((r) => inRange(r.at));

  const byProvider = new Map<ProviderId, Tally>();
  const byModel = new Map<string, { provider: ProviderId; model: string; t: Tally }>();
  const total = emptyTally();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, emptyTally());
    add(byProvider.get(r.provider)!, r.usage);
    const key = `${r.provider}\u0000${r.model}`;
    if (!byModel.has(key)) byModel.set(key, { provider: r.provider, model: r.model, t: emptyTally() });
    add(byModel.get(key)!.t, r.usage);
    add(total, r.usage);
  }
  const models = [...byModel.values()].sort((a, b) => b.t.input + b.t.output - (a.t.input + a.t.output));

  const active = M.activeAttempts(state);
  const lead = M.activeLeadRun(state);
  const p = state.project;

  return (
    <section className="k-stack k-stack--tight" aria-labelledby="usage-h">
      <div className="row">
        <h4 id="usage-h" className="no-margin">
          Usage
        </h4>
        <SegmentedControl
          label="Usage period"
          size="small"
          value={range}
          onChange={setRange}
          options={[
            { value: "today", label: "Today" },
            { value: "all", label: "All time" },
          ]}
        />
      </div>

      <h5 className="no-margin">Running now</h5>
      <table className="usage-table meta">
        <tbody>
          {PROVIDERS.map((pr) => {
            const n = active.filter((a) => a.snapshot.provider === pr).length;
            const limit = p.providerLimits?.[pr] ?? p.workerLimit;
            const enabled = p.enabledProviders.includes(pr);
            return (
              <tr key={pr}>
                <td>{M.providerLabel(pr)}</td>
                <td className="num">
                  {n} of {Math.min(limit, p.workerLimit)} agents
                </td>
                <td className="muted">{!enabled ? "not enabled" : limit === 0 ? "limit 0: no runs" : lead?.provider === pr ? "+ lead run" : ""}</td>
              </tr>
            );
          })}
          <tr>
            <td>All agents</td>
            <td className="num">
              {active.length} of {p.workerLimit}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="muted small">Each provider is limited by its own setting and by Agents at once (Settings › Agents).</p>

      <h5 className="no-margin">{range === "today" ? "Today" : "All time"}</h5>
      {rows.length === 0 ? (
        <p className="muted">No runs {range === "today" ? "today" : "yet"}.</p>
      ) : (
        <div className="table-wrap">
          <table className="usage-table meta">
            <thead>
              <tr>
                <th>Provider / model</th>
                <th className="num">Runs</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.filter((pr) => byProvider.has(pr)).map((pr) => {
                const t = byProvider.get(pr)!;
                return (
                  <UsageRows key={pr} label={<strong>{M.providerLabel(pr)}</strong>} t={t}>
                    {models
                      .filter((m) => m.provider === pr)
                      .map((m) => (
                        <UsageRow key={m.model} label={<span className="mono usage-model">{m.model}</span>} t={m.t} />
                      ))}
                  </UsageRows>
                );
              })}
              <UsageRow label={<strong>Total</strong>} t={total} />
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Includes agent and lead runs. Cost is the provider's estimate; Codex reports tokens only.
        {total.runs > total.reported ? ` ${total.runs - total.reported} run${total.runs - total.reported === 1 ? "" : "s"} reported no token counts.` : ""}
      </p>
    </section>
  );
}

function UsageRow({ label, t }: { label: React.ReactNode; t: Tally }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{t.runs}</td>
      <td className="num">{t.reported ? fmtTokens(t.input) : "—"}</td>
      <td className="num">{t.reported ? fmtTokens(t.output) : "—"}</td>
      <td className="num">{fmtCost(t)}</td>
    </tr>
  );
}

function UsageRows({ label, t, children }: { label: React.ReactNode; t: Tally; children: React.ReactNode }) {
  return (
    <>
      <UsageRow label={label} t={t} />
      {children}
    </>
  );
}

/** Where and how the service runs: connection, scheduler role, agents, paths, and when the lead plans. A section of "Usage and service". */
export function ServiceCard() {
  const { state, status, service } = useStore();
  return (
    <section className="k-stack k-stack--tight" aria-labelledby="svc-h">
      <h4 id="svc-h" className="no-margin">
        Service
      </h4>
      <dl className="kv">
        <dt>Status</dt>
        <dd>{status === "online" ? "Online" : status === "connecting" ? "Connecting…" : "Offline — showing the last known state"}</dd>
        <dt>Started</dt>
        <dd>{fmtTime(service.startedAt)}</dd>
        <dt>Scheduler role</dt>
        <dd>{service.scheduler === "active" ? "Active — this instance holds the scheduler lease" : "Observer — another service instance holds the scheduler lease"}</dd>
        <dt>Agents</dt>
        <dd>
          {service.runtime === "real"
            ? `Real: ${Object.values(service.providers)
                .map((p) => p.label)
                .join(", ")}`
            : "Simulated: no agent runs. Start with ORCHESTRATION_RUNTIME=real to run Claude and Codex."}
        </dd>
        <dt>Database</dt>
        <dd className="mono">{service.dbPath}</dd>
        <dt>Repository</dt>
        <dd className="mono">{state.project.repoPath}</dd>
        <dt>Scheduler</dt>
        <dd>
          {INVOLVEMENT_NAME[involvementOf(state.project.autonomy, state.project.prDelivery.enabled)]}:{" "}
          {state.project.autonomy.enabled
            ? `the lead plans every ${state.project.autonomy.planningIntervalMinutes} min${state.project.autonomy.operatingHours ? ` between ${state.project.autonomy.operatingHours.start} and ${state.project.autonomy.operatingHours.end}` : ""}, while this service runs`
            : "the lead runs only when you message it"}
          . Nothing runs while this service is stopped or the computer sleeps.
        </dd>
      </dl>
    </section>
  );
}
