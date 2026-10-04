// Reading (ORC-032, screen 2), in Vision while the import reads: the spend against the import budget with the
// estimate, each step in order (the tests, the rules, the parts, the recording; the words at the same time) and its
// state, and Pause. Once stopped, why. Words: importView.ts.

import { useState } from "react";
import { fmtUsd } from "../../domain/spend";
import { importParts } from "../../domain/studio/import";
import { projectPause } from "../../domain/places";
import { Banner, Button, Card, Field, Input, SimulatedChip, StatePill, StepList } from "../kit";
import { useStore } from "../store";
import { importSpend, productName, readingSteps, spendWords } from "./importView";
import "./import.css";

/** The spend as a bar: what is spent, over the estimate's band, against the budget. */
export function SpendBar({ spent, budget, estimate, label }: { spent: number; budget: number; estimate: [number, number]; label?: string }) {
  const scale = Math.max(budget, estimate[1], spent) || 1;
  const pct = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  return (
    <div className="imp-band" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <span className="imp-band__est" style={{ left: pct(estimate[0]), width: pct(estimate[1] - estimate[0]) }} />
      {spent > 0 && <span className="imp-band__used" style={{ width: pct(spent) }} />}
    </div>
  );
}

export function ImportPanel() {
  const { state, send, disabled } = useStore();
  const imp = state.studio.import!;
  const sw = spendWords(state);
  const steps = readingSteps(state);
  const done = steps.filter((s) => s.mark === "done" || s.mark === "skipped").length;
  const pause = projectPause(state);
  const name = productName(state);
  const simulated = state.studio.runs.some((r) => r.importStep && r.simulated) || (imp.checks.status === "read" && imp.checks.simulated);
  const reading = imp.reading;
  const words = importParts(state).find((a) => a.kind === "dictionary");
  const parts = importParts(state).filter((a) => a.kind !== "dictionary");
  const example = reading?.rules.find((r) => r.tests.length) ?? reading?.rules[0];
  return (
    <div className="k-stack imp-page">
      <header className="st-head">
        <h1 className="no-margin">Vision</h1>
        <p className="small muted no-margin">
          Importing <b>{name}</b> {simulated && <SimulatedChip />} at commit {imp.commit.slice(0, 7)}
          {imp.branch ? ` on ${imp.branch}` : ""}. The readers only read the repository. No file in it changes.
        </p>
      </header>

      {imp.stopped && (
        <Banner tone="fail" title={`The import stopped: ${imp.stopped.reason}`}>
          Nothing more runs for it. To import again, start a new project in Settings › Project.
        </Banner>
      )}
      {!imp.stopped && sw.atBudget && <BudgetStop />}

      <Card title="The import" actions={<StatePill tone={imp.stopped ? "fail" : pause ? "neutral" : "work"} pulse={!imp.stopped && !pause} paused={!!pause}>{imp.stopped ? "stopped" : pause ? (pause.state === "paused" ? "paused by you" : "pausing") : `reading · ${done} of ${steps.length} steps done`}</StatePill>}>
        <p className="no-margin">
          <b className="num">{fmtUsd(sw.spent)}</b> spent of the <b>{fmtUsd(sw.budget)}</b> import budget. The estimate: {fmtUsd(sw.estimate[0])}–{fmtUsd(sw.estimate[1])}.
        </p>
        <SpendBar spent={sw.spent} budget={sw.budget} estimate={sw.estimate} label={sw.line} />
        <div className="imp-legend micro muted">
          <span>
            <span className="imp-key imp-key--used" />
            spent
          </span>
          <span>
            <span className="imp-key imp-key--est" />
            the estimate
          </span>
          {imp.helpers ? <span>up to {imp.helpers} helpers, read-only, under the rules reader</span> : null}
        </div>
        {sw.unknown && <p className="micro muted no-margin">{sw.unknown}</p>}
        <StepList steps={steps} label="The import's steps" className="imp-steps" />
        <div className="imp-between">
          <p className="small muted no-margin">You can leave this page. The import goes on, and Home shows it.</p>
          {!imp.stopped &&
            (state.project.hold ? (
              <Button size="small" disabled={disabled} onClick={() => void send("resumeProject")}>
                Resume the import
              </Button>
            ) : (
              <Button size="small" disabled={disabled} onClick={() => void send("pauseProject")}>
                Pause the import
              </Button>
            ))}
        </div>
      </Card>

      <div className="imp-cols3">
        <Card title="The rules" as="h3" actions={<StatePill tone={reading ? "done" : "work"}>{reading ? "done" : "reading"}</StatePill>}>
          <p className="small no-margin">The reader turns each test into a rule, with the test that proves it. Then it reads the code and the docs for rules that no test covers.</p>
          {reading ? (
            <>
              <dl className="imp-stats">
                <div>
                  <dt>{imp.checks.status === "read" ? Object.values(imp.checks.counts).reduce((a, b) => a + b, 0) : 0}</dt>
                  <dd>tests read{imp.checks.status === "read" && imp.checks.counts.passed === Object.values(imp.checks.counts).reduce((a, b) => a + b, 0) ? "; all pass" : ""}</dd>
                </div>
                <div>
                  <dt>{reading.rules.filter((r) => r.tests.length).length}</dt>
                  <dd>rules from the tests</dd>
                </div>
                <div>
                  <dt>{reading.rules.filter((r) => !r.tests.length).length}</dt>
                  <dd>rules from the code, no test</dd>
                </div>
              </dl>
              {example && (
                <div className="imp-eg">
                  <p className="st-label no-margin">For example</p>
                  <p className="small no-margin">{example.text}</p>
                  {example.tests[0] && <p className="micro muted no-margin s-mono imp-wrap">{example.tests[0]}</p>}
                </div>
              )}
            </>
          ) : (
            <p className="small muted no-margin">{imp.checks.status === "pending" ? "It starts when the tests have run." : "Reading the tests and the code…"}</p>
          )}
        </Card>

        <Card title="The parts" as="h3" actions={<StatePill tone={imp.capture ? "done" : parts.length ? "work" : "neutral"}>{imp.capture ? "done" : parts.length ? "recording" : reading ? "designing" : "waiting"}</StatePill>}>
          <p className="small no-margin">A designer makes what {name} does today: each command as a terminal demo, each screen, the data and the core algorithms. The service records each in the project's container, with no network.</p>
          {parts.length ? (
            <ul className="imp-ticks small">
              {parts.map((a) => {
                const cap = imp.capture?.parts.find((p) => p.artifactId === a.id);
                return (
                  <li key={a.id} className={cap || !["screen", "terminal-demo", "tui"].includes(a.kind) ? "" : "imp-ticks--run"}>
                    {a.title}
                    <span>{cap ? (cap.status === "captured" ? `recorded${imp.capture?.simulated ? " (simulated)" : ""}` : `not recorded: ${cap.detail}`) : ["screen", "terminal-demo", "tui"].includes(a.kind) ? "to record" : `${a.kind}, from ${a.provenance?.files.join(", ")}`}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="small muted no-margin">It starts when the rules are read: each part carries its rules.</p>
          )}
        </Card>

        <Card title="The words" as="h3" actions={<StatePill tone={words ? "done" : "work"}>{words ? "done" : "reading"}</StatePill>}>
          <p className="small no-margin">The product's own words, from the README, the docs and the names in the code.</p>
          {words?.dictionary?.length ? (
            <ul className="imp-words">
              {words.dictionary.map((w) => (
                <li key={w.term}>{w.term}</li>
              ))}
            </ul>
          ) : (
            <p className="small muted no-margin">Reading…</p>
          )}
        </Card>
      </div>

      <Card>
        <p className="small no-margin">
          When the reading ends, round 0, <b>As it is today</b>, opens here. It asks you only what the code cannot answer.
        </p>
      </Card>
    </div>
  );
}

/** At the import budget, the import's runs wait: raise the budget to go on. */
function BudgetStop() {
  const { state, send, disabled } = useStore();
  const imp = state.studio.import!;
  const [usd, setUsd] = useState(String(Math.ceil(imp.budgetUsd * 2)));
  const n = Number(usd);
  return (
    <Banner tone="you" title={`The import waits at its budget: ${fmtUsd(importSpend(state).usd)} of ${fmtUsd(imp.budgetUsd)}.`}>
      <p className="no-margin">Nothing new starts for it until you raise the import budget. The building budget stays apart.</p>
      <form
        className="imp-path"
        onSubmit={(e) => {
          e.preventDefault();
          if (n > imp.budgetUsd) void send("setImportBudget", { budgetUsd: n });
        }}
      >
        <Field label="New import budget (dollars)" width="short">
          <Input type="text" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
        </Field>
        <Button type="submit" size="small" disabled={disabled || !(n > imp.budgetUsd)}>
          Raise the budget
        </Button>
      </form>
    </Banner>
  );
}
