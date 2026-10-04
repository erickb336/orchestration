// Start (ORC-032, screen 1): the import of an existing repository, from Settings › Project › Start a new project, or,
// in the demo, on the invented sample repository (tally). Nothing runs until Start the import: the screen reads the
// repository once (the commit, the files, what it proposes and why), then sends initProject, the kind of product, the
// devices, how it runs and startImport, in that order. Words: importView.ts.

import { useEffect, useState } from "react";
import { CLIENT_HEADER } from "../../api";
import * as M from "../../domain/model";
import { fmtUsd } from "../../domain/spend";
import { canAllowSubagents } from "../../domain/subagents";
import { DEFAULT_CHECKS, MAX_SUBAGENT_CAP, type Device, type ProjectDomain } from "../../domain/types";
import { Banner, Button, Card, Checkbox, Chip, Field, Input, SimulatedChip, useConfirm } from "../kit";
import { DEVICE_CHOICES, toggleDevice } from "../settings/budgets";
import { shortImage } from "../settings/environment";
import { sendInOrder } from "../settings/draft";
import { confirmNewProject } from "../settingsText";
import { initProjectConfirm } from "../stageChoice";
import { useStore } from "../store";
import { DOMAIN_CHOICES, toggleDomain } from "../studio/studioView";
import { SpendBar } from "./ImportPanel";
import { argvLine, foundBecause, foundLine, howItRuns, startBlocker, startDraft, startInfoRequest, testCheck, type FoundRepository, type ImportStartInfo, type StartDraft } from "./importView";
import "./import.css";

type Loaded = { status: "idle" } | { status: "loading" } | { status: "failed"; message: string } | { status: "ok"; info: ImportStartInfo };

async function readRepository(q: { path: string } | "demo"): Promise<Loaded> {
  const { url, method } = startInfoRequest(q);
  try {
    const res = await fetch(url, method === "POST" ? { method, headers: { Accept: "application/json", "Content-Type": "application/json", [CLIENT_HEADER]: "1" }, body: "{}" } : { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return { status: "failed", message: `The service could not read it (${res.status}).` };
    return { status: "ok", info: (await res.json()) as ImportStartInfo };
  } catch {
    return { status: "failed", message: "The service is unreachable." };
  }
}

/** The import's Start: `sample` reads the demo's invented repository; else the owner gives a path. */
export function StartImport({ sample, onCancel }: { sample: boolean; onCancel?: () => void }) {
  const [path, setPath] = useState("");
  const [loaded, setLoaded] = useState<Loaded>({ status: sample ? "loading" : "idle" });
  useEffect(() => {
    if (sample) void readRepository("demo").then(setLoaded);
  }, [sample]);
  const read = async () => {
    setLoaded({ status: "loading" });
    setLoaded(await readRepository({ path: path.trim() }));
  };
  const info = loaded.status === "ok" ? loaded.info : undefined;
  return (
    <div className="k-stack imp-start">
      <p className="no-margin">The import reads your repository and shows what the product does today, as parts in Vision. You answer only what the code cannot. Then your Lock in makes it the baseline.</p>
      {!sample && (
        <form
          className="imp-path"
          onSubmit={(e) => {
            e.preventDefault();
            void read();
          }}
        >
          <Field label="Repository path (absolute)" hint="A git repository with at least one commit.">
            <Input type="text" className="s-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/your/repo" spellCheck={false} />
          </Field>
          <Button type="submit" disabled={!path.trim()} loading={loaded.status === "loading"}>
            Read the repository
          </Button>
        </form>
      )}
      {loaded.status === "loading" && sample && <p className="small muted">Reading the sample repository…</p>}
      {loaded.status === "failed" && <Banner tone="fail">{loaded.message}</Banner>}
      {info && !info.ok && <Banner tone="fail" title="The import cannot read this repository.">{info.reason}</Banner>}
      {info?.ok && <StartForm key={`${info.path}@${info.commit}`} info={info} onCancel={onCancel} />}
    </div>
  );
}

export function StartForm({ info, onCancel }: { info: FoundRepository; onCancel?: () => void }) {
  const { state, send, disabled, setNotice } = useStore();
  const confirm = useConfirm();
  const [d, setD] = useState<StartDraft>(() => startDraft(info));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<StartDraft>) => setD((x) => ({ ...x, ...p }));
  const runs = howItRuns(d);
  const blocker = disabled ? "The service is offline." : startBlocker(d);
  const estimate = info.estimate;
  const budget = Number(d.budget) > 0 ? Number(d.budget) : 0;

  const start = async () => {
    if (blocker || busy) return;
    const name = d.name.trim();
    if (!(await confirm(confirmNewProject(name, initProjectConfirm(name, M.currentVisionDocs(state).length))))) return;
    setBusy(true);
    const env = d.environment && ("devcontainer" in d.environment ? { prepare: [], hosts: [], devcontainer: d.environment.devcontainer } : { image: d.environment.image, prepare: d.environment.prepare, hosts: [] });
    const { rev: _rev, ...checks } = DEFAULT_CHECKS;
    const ok = await sendInOrder([
      () => send("initProject", { name, repoPath: info.path, vision: "", focus: "" }),
      () => send("setDomains", { domains: d.domains }),
      () => send("setDevices", { devices: d.devices }),
      () => (env ? send("setEnvironment", { environment: env }) : null),
      () => (d.testCommand.trim() ? send("setChecks", { config: { ...checks, enabled: true, commands: [testCheck(d.testCommand)], ...(d.testReport.trim() ? { testReport: d.testReport.trim() } : {}) } }) : null),
      () => send("startImport", { commit: info.commit, ...(info.branch ? { branch: info.branch } : {}), budgetUsd: Number(d.budget), helpers: d.helpers ? d.helperCap : null, size: info.size }),
    ]);
    setBusy(false);
    if (!ok) return;
    setNotice({ kind: "info", message: `The import of "${name}" started. Vision shows the reading.` });
    location.hash = "#/vision";
  };

  return (
    <div className="imp-cols">
      <div className="k-stack">
        <Card title="The repository" as="h3">
          <p className="small no-margin">
            <b className="imp-ok">✓ Found</b> {foundLine(info)} {info.demo && <SimulatedChip title="The sample repository: tally is an invented command-line tool. No agent has run." />}
          </p>
          <p className="micro muted no-margin s-mono imp-wrap">{info.path}</p>
          <Field label="Project name">
            <Input type="text" value={d.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </Card>

        <Card title="Kind of product" as="h3">
          <fieldset className="s-choices">
            <legend className="sr-only">Kind of product</legend>
            {DOMAIN_CHOICES.map((c) => {
              const because = foundBecause(info, (d) => d.domain === c.value);
              return (
                <Checkbox
                  key={c.value}
                  label={
                    <>
                      {c.label} {because && <Chip>prefilled</Chip>}
                    </>
                  }
                  hint={because ? `Found: ${because}. ${c.makes}` : `Not found. ${c.makes}`}
                  checked={d.domains.includes(c.value)}
                  onChange={() => set({ domains: toggleDomain(d.domains, c.value as ProjectDomain) })}
                />
              );
            })}
          </fieldset>
          <p className="micro muted no-margin">Change any kind that is wrong. The designer makes what each kind needs.</p>
        </Card>

        <Card title="Devices" as="h3">
          <fieldset className="s-choices">
            <legend className="sr-only">Devices</legend>
            {DEVICE_CHOICES.map((c) => {
              const because = foundBecause(info, (d) => d.device === c.value);
              return (
                <Checkbox
                  key={c.value}
                  label={
                    <>
                      {c.label} {because && <Chip>prefilled</Chip>}
                    </>
                  }
                  hint={`${c.hint} ${because ? `Found: ${because}.` : "Not found."}`}
                  checked={d.devices.includes(c.value)}
                  onChange={() => set({ devices: toggleDevice(d.devices, c.value as Device) })}
                />
              );
            })}
          </fieldset>
        </Card>

        <Card title="How it runs" as="h3" actions={<Chip tone={runs.complete ? "done" : "you"}>{runs.complete ? "complete" : `missing ${runs.missing.join(", ")}`}</Chip>}>
          <p className="small no-margin">The import runs your tests once and records the CLI and the screens, in the project's environment, with no network.</p>
          <HowItRunsFields info={info} d={d} set={set} />
          {runs.effect && (
            <p className="small imp-why imp-why--you no-margin" role="note">
              {runs.effect}
            </p>
          )}
        </Card>
      </div>

      <div className="k-stack">
        <Card title="The import budget" as="h3">
          <Field label="Import budget (dollars)" width="short">
            <Input type="text" inputMode="decimal" className="num" value={d.budget} onChange={(e) => set({ budget: e.target.value })} />
          </Field>
          <SpendBar spent={0} budget={budget} estimate={estimate.usd} />
          <div className="imp-scale micro muted" aria-hidden="true">
            <span>$0</span>
            <span>
              <span className="imp-key imp-key--est" />
              the estimate
            </span>
            <span>{budget ? `${fmtUsd(budget)}, the budget` : ""}</span>
          </div>
          <p className="no-margin">
            <b>
              The estimate: about {fmtUsd(estimate.usd[0])}–{fmtUsd(estimate.usd[1])}.
            </b>
          </p>
          <p className="micro muted no-margin">{estimate.basis}</p>
          <p className="micro muted no-margin">At the budget, the import stops and asks you. The building budget is separate: the import spends nothing from it.</p>
          {canAllowSubagents(state) && (
            <div className="k-stack k-stack--tight">
              <Checkbox label="Let the rules reader start helpers" hint="Read-only helpers, each counted in the import budget. Off until you turn it on." checked={d.helpers} onChange={(e) => set({ helpers: e.target.checked })} />
              {d.helpers && (
                <Field label="Helpers at most" width="short">
                  <Input type="number" min={1} max={MAX_SUBAGENT_CAP} value={d.helperCap} onChange={(e) => set({ helperCap: Math.max(1, Math.min(MAX_SUBAGENT_CAP, Number(e.target.value) || 1)) })} />
                </Field>
              )}
            </div>
          )}
        </Card>

        <Card title="What happens" as="h3">
          <ol className="imp-flow small">
            <li>
              <b>Reading.</b> The service runs your tests. A reader turns the tests and the code into rules. A designer makes the parts with their rules, and the service records them. The words are read at the same time.
            </li>
            <li>
              <b>Review.</b> Round 0, As it is today, opens in Vision. It asks you only about conflicts and important guesses, at most 10.
            </li>
            <li>
              <b>Baseline.</b> Your Lock in makes it the baseline: in force and built. The factory has nothing to build until you change something.
            </li>
          </ol>
          <p className="imp-safe small no-margin">
            <b>It only reads.</b> The readers use a read-only copy. The tests and the CLI run in the project's container with no network. No file in your repository changes, and the vision stays on this computer.
          </p>
          <div className="k-actions">
            <Button variant="primary" disabled={!!blocker} disabledReason={blocker} showReason={!!blocker} loading={busy} onClick={() => void start()}>
              {busy ? "Starting…" : "Start the import"}
            </Button>
            {onCancel && (
              <Button variant="quiet" onClick={onCancel}>
                Not yet
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The environment, the test command and its report, each prefilled with why. */
function HowItRunsFields({ info, d, set }: { info: FoundRepository; d: StartDraft; set: (p: Partial<StartDraft>) => void }) {
  const dc = info.devcontainer;
  const p = info.proposal;
  const test = info.testReport?.command ?? info.checks.find((c) => c.kind === "check");
  const env = d.environment;
  return (
    <div className="k-stack k-stack--tight">
      <section className="imp-run" aria-label="The environment">
        <p className="small no-margin">
          <b>The environment</b>{" "}
          {env ? <Chip>prefilled</Chip> : <Chip tone="you">missing</Chip>}
        </p>
        {dc && !dc.refused && dc.sha256 ? (
          <Checkbox
            label={`Use the dev container ${dc.file}`}
            hint={`It is the repository's own: ${dc.image ? `the image ${dc.image}` : `the Dockerfile ${dc.dockerfile ?? ""}`}. Ticking it confirms it, as Settings does.`}
            checked={!!env && "devcontainer" in env}
            onChange={(e) => set({ environment: e.target.checked ? { devcontainer: { file: dc.file, sha256: dc.sha256! } } : p ? { image: p.image, prepare: p.prepare } : null })}
          />
        ) : p ? (
          <Checkbox label={`Use the image ${p.label}`} hint={`${p.because} ${shortImage(p.image)}`} checked={!!env && "image" in env} onChange={(e) => set({ environment: e.target.checked ? { image: p.image, prepare: p.prepare } : null })} />
        ) : (
          <p className="micro muted no-margin">{dc?.refused ?? "The repository proposes no environment. Set one in Settings › How your project runs after the start."}</p>
        )}
      </section>
      <Field label="Test command" hint={info.testReport ? `Prefilled. ${info.testReport.because} shows a test runner that writes a JUnit report.` : test ? "Prefilled from the repository's files. Make it write a JUnit report too." : "Not found. The command that runs your tests and writes a JUnit report."}>
        <Input type="text" className="s-mono" value={d.testCommand} onChange={(e) => set({ testCommand: e.target.value })} placeholder={test ? argvLine(test.argv) : "pytest --junitxml=reports/junit.xml"} spellCheck={false} />
      </Field>
      <Field label="JUnit report path" hint={info.testReport ? "Prefilled: where that test command writes its report." : "Not found. Where the test command writes its JUnit report, from the repository's root."}>
        <Input type="text" className="s-mono" value={d.testReport} onChange={(e) => set({ testReport: e.target.value })} placeholder="reports/junit.xml" spellCheck={false} />
      </Field>
    </div>
  );
}
