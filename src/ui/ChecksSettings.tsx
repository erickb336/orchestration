// Settings › checks (ORC-013 §12): the project's own check commands, run by the service in the Codex sandbox on a
// throwaway copy of each change. Off until the person turns it on; the commands are the person's settings and nothing
// an agent writes can change them. ORC-025 pass 5 (S4) splits the card in two:
//  - Quality › Checks: on or off, "On · 2 commands", Suggest from repository, and Edit commands (the editor, in place);
//  - Advanced › Checks sandbox: the sandbox, its health, the network for installs, the limits, protected inputs and
//    the environment. Running without a sandbox is a separate, explicit choice with its own warning.
// Both edit their section's draft; each saves the whole configuration with only its own fields changed.

import { useState } from "react";
import type { CheckSuggestions } from "../api";
import { CHECK_PROGRAMS, MAX_CHECK_COMMANDS, MAX_PREPARE_COMMANDS, validateChecks, validateCommand } from "../domain/checks";
import type { CheckCommand, ChecksConfig, State } from "../domain/types";
import { Actions, Banner, Button, Checkbox, Field, Input, Select, SimulatedChip, StatePill, Textarea, type ConfirmOptions } from "./kit";
import { fmtTime, relTime } from "./common";
import { CONFIRM_CHECKS_ON, CONFIRM_NO_SANDBOX, argvText, checksSummary } from "./settingsText";
import { useStore, type SendResult } from "./store";
import { intIn } from "./settings/draft";
import { Choice, SettingsCard } from "./settings/parts";
import { cardHref } from "./settings/sections";

type Confirm = (o: ConfirmOptions) => Promise<boolean>;
type Send = (name: Parameters<ReturnType<typeof useStore>["send"]>[0], args?: object) => Promise<SendResult>;

/** The whole configuration to save: the live one with a section's fields on top. */
function configWith(live: ChecksConfig, patch: Partial<Omit<ChecksConfig, "rev">>): Omit<ChecksConfig, "rev"> {
  const { rev: _rev, ...rest } = live;
  return { ...rest, ...patch, commands: (patch.commands ?? live.commands).map((c) => ({ ...c, argv: [...c.argv] })) };
}

const saveArgs = (config: Omit<ChecksConfig, "rev">) => ({ config, ...(config.sandbox === "none" ? { acknowledgeUnsandboxed: true } : {}) });

// ---------- Quality › Checks ----------

export type ChecksDraft = { enabled: boolean; commands: CheckCommand[] };

export const liveChecks = (state: State): ChecksDraft => ({ enabled: state.project.checks.enabled, commands: state.project.checks.commands });

/** Why the draft's commands cannot be saved, in the domain's words (validateChecks), or undefined. */
export function checksProblem(state: State, v: ChecksDraft): string | undefined {
  return validateChecks({ ...configWith(state.project.checks, v), rev: state.project.checks.rev }, { acknowledged: true });
}

/** The command that saves Quality › Checks. Turning checks on asks first, saying what it means; a "no" saves nothing. */
export async function checksSteps(state: State, v: ChecksDraft, changed: ReadonlySet<keyof ChecksDraft>, send: Send, confirm: Confirm): Promise<(() => Promise<SendResult> | null)[] | null> {
  if (!changed.size) return [];
  if (v.enabled && !state.project.checks.enabled && !(await confirm(CONFIRM_CHECKS_ON))) return null;
  return [() => send("setChecks", saveArgs(configWith(state.project.checks, v)))];
}

export function ChecksCard({ v, set }: { v: ChecksDraft; set: (p: Partial<ChecksDraft>) => void }) {
  const { state, service } = useStore();
  const cfg = state.project.checks;
  const health = state.project.checksHealth;
  const real = service.runtime === "real";
  const sampleBlocked = real && state.project.sample;
  const [editing, setEditing] = useState(false);
  const [suggested, setSuggested] = useState<CheckSuggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const problem = checksProblem(state, v);
  const checksInUse = v.commands.filter((c) => c.kind === "check").length;

  const suggest = async () => {
    setSuggesting(true);
    setSuggested(null);
    try {
      const res = await fetch("/api/checks/suggest");
      if (res.ok) setSuggested((await res.json()) as CheckSuggestions);
      else setSuggested({ commands: [], ref: "", reason: "The suggestions could not be read." });
    } catch {
      setSuggested({ commands: [], ref: "", reason: "The service is unreachable." });
    }
    setSuggesting(false);
  };

  const sandboxLine =
    cfg.enabled && cfg.sandbox === "none"
      ? "Checks run without a sandbox, with your permissions."
      : cfg.enabled && health?.status === "unavailable"
        ? "The sandbox is unavailable, so check steps wait."
        : cfg.enabled && health?.status !== "ready"
          ? "The sandbox is checked before the first run; check steps wait until it is ready."
          : null;
  const tone = !v.enabled ? "neutral" : cfg.enabled && health?.status === "unavailable" ? "fail" : cfg.enabled && health?.status === "ready" && cfg.sandbox === "codex" ? "done" : "neutral";

  return (
    <SettingsCard
      id="checks"
      title="Checks"
      help="The service runs your repository's own commands on a throwaway copy of each change: after the coder, before the review, and on the final change. Agents never choose or change them."
      actions={
        <>
          <Button size="small" disabled={suggesting || sampleBlocked} loading={suggesting} onClick={() => void suggest()}>
            {suggesting ? "Reading…" : "Suggest from repository"}
          </Button>
          <Button size="small" aria-expanded={editing} onClick={() => setEditing((x) => !x)}>
            {editing ? "Close editor" : "Edit commands"}
          </Button>
        </>
      }
    >
      {sampleBlocked && <Banner tone="info">This is the sample project: it has no repository, so its checks cannot be turned on. Start a project of your own in Project.</Banner>}
      <Checkbox label="Run the project's checks on every change" checked={v.enabled} disabled={sampleBlocked} onChange={(e) => set({ enabled: e.target.checked })} />
      <div className="s-status">
        <StatePill tone={tone}>{checksSummary(v.enabled, v.commands)}</StatePill>
        {!real && <SimulatedChip title="Simulated: in the demo nothing is run and nothing is spawned; the results say so." />}
        {v.commands.length > 0 && (
          <span className="s-commands">
            {v.commands.map((c, i) => (
              <code key={i} className="s-mono">
                {argvText(c.argv)}
              </code>
            ))}
          </span>
        )}
      </div>
      {sandboxLine && (
        <p className="s-note">
          {sandboxLine} <a href={cardHref("sandbox")}>Sandbox details in Advanced</a>.
        </p>
      )}

      {suggested && (
        <Banner
          tone="info"
          className="s-gap"
          title={suggested.commands.length ? "Suggested from the repository" : undefined}
          actions={
            suggested.commands.length ? (
              <>
                <Button
                  size="small"
                  onClick={() => {
                    set({ commands: suggested.commands.map((c) => ({ ...c, argv: [...c.argv] })) });
                    setSuggested(null);
                  }}
                >
                  Use these
                </Button>
                <Button size="small" variant="quiet" onClick={() => setSuggested(null)}>
                  Dismiss
                </Button>
              </>
            ) : (
              <Button size="small" variant="quiet" onClick={() => setSuggested(null)}>
                Dismiss
              </Button>
            )
          }
        >
          {suggested.commands.length ? (
            <>
              <p className="no-margin">
                Read at <span className="s-mono">{suggested.ref}</span>. Nothing changes until you use them and save.
              </p>
              <ul className="plain">
                {suggested.commands.map((c) => (
                  <li key={c.id}>
                    {c.kind === "prepare" ? "Prepare: " : ""}
                    <code className="s-mono">{argvText(c.argv)}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            (suggested.reason ?? "Nothing to suggest.")
          )}
        </Banner>
      )}

      {editing && <CommandEditor commands={v.commands} prepareNetwork={cfg.prepareNetwork} defaultTimeout={cfg.commandTimeoutMinutes} onChange={(commands) => set({ commands })} />}

      {problem && (
        <Banner tone="fail" className="s-gap">
          {problem}
        </Banner>
      )}
      {v.enabled && checksInUse === 0 && !problem && (
        <Banner tone="you" className="s-gap">
          Checks are on with no check command: every Checks step is skipped, and says so, until one is added.
        </Banner>
      )}
    </SettingsCard>
  );
}

/** The command list, editable: each command is a list of arguments, never a shell line. */
function CommandEditor({ commands, prepareNetwork, defaultTimeout, onChange }: { commands: CheckCommand[]; prepareNetwork: boolean; defaultTimeout: number; onChange: (c: CheckCommand[]) => void }) {
  const patch = (i: number, p: Partial<CheckCommand>) => onChange(commands.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const setArg = (i: number, k: number, value: string) => patch(i, { argv: commands[i].argv.map((a, l) => (l === k ? value : a)) });
  const move = (i: number, dir: -1 | 1) => {
    const cs = [...commands];
    const [x] = cs.splice(i, 1);
    cs.splice(i + dir, 0, x);
    onChange(cs);
  };
  const add = () => {
    const used = new Set(commands.map((c) => c.id));
    let n = commands.length + 1;
    while (used.has(`check-${n}`)) n++;
    onChange([...commands, { id: `check-${n}`, label: `Check ${n}`, kind: "check", argv: ["npm", "test"] }]);
  };
  const prepares = commands.filter((c) => c.kind === "prepare").length;
  const hasRebuild = commands.some((c) => c.kind === "prepare" && c.argv[1] === "rebuild");
  const addInstallScripts = () => {
    const pm = commands.find((c) => c.kind === "prepare" && ["npm", "pnpm", "yarn"].includes(c.argv[0]))?.argv[0] ?? "npm";
    let at = 0;
    commands.forEach((c, i) => {
      if (c.kind === "prepare") at = i + 1;
    });
    onChange([...commands.slice(0, at), { id: "install-scripts", label: "Run install scripts (offline)", kind: "prepare", argv: [pm, "rebuild"] }, ...commands.slice(at)]);
  };
  return (
    <div className="s-gap">
      <p className="s-card-help">
        Only these programs can run: {CHECK_PROGRAMS.join(", ")}. Prepare commands (installs, at most {MAX_PREPARE_COMMANDS}) run first, then the checks, in this order; at most {MAX_CHECK_COMMANDS} in all.
      </p>
      {commands.length === 0 && <p className="muted">No commands yet. Checks do nothing until at least one check command is set.</p>}
      {commands.map((c, i) => {
        const why = validateCommand(c, { networked: prepareNetwork });
        return (
          <fieldset key={i} className="s-cmd">
            <legend>{c.label || c.id || `Command ${i + 1}`}</legend>
            <div className="s-fields">
              <Field label="Label">
                <Input type="text" value={c.label} onChange={(e) => patch(i, { label: e.target.value })} />
              </Field>
              <Field label="Kind">
                <Select
                  value={c.kind}
                  onChange={(e) => patch(i, { kind: e.target.value as CheckCommand["kind"] })}
                  options={[
                    { value: "check", label: "Check" },
                    { value: "prepare", label: "Prepare (install)" },
                  ]}
                />
              </Field>
              <Field label="Id" hint="Lowercase letters, digits and hyphens.">
                <Input type="text" className="s-mono" value={c.id} onChange={(e) => patch(i, { id: e.target.value })} />
              </Field>
              <Field label="Time limit (minutes)" hint={`Empty: ${defaultTimeout}.`}>
                <Input type="number" min={1} max={60} value={c.timeoutMinutes ?? ""} onChange={(e) => patch(i, { timeoutMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </Field>
            </div>
            <div className="k-field__label" id={`cmd-${i}-argv`}>
              Arguments, the program first
            </div>
            <div className="s-argv" role="group" aria-labelledby={`cmd-${i}-argv`}>
              {c.argv.map((a, k) => (
                <span key={k} className="s-argv__item">
                  <Input type="text" value={a} onChange={(e) => setArg(i, k, e.target.value)} aria-label={`Command ${i + 1} argument ${k + 1}`} />
                  {c.argv.length > 1 && (
                    <Button size="small" variant="quiet" aria-label={`Remove argument ${k + 1} of command ${i + 1}`} title="Remove this argument" onClick={() => patch(i, { argv: c.argv.filter((_, l) => l !== k) })}>
                      ×
                    </Button>
                  )}
                </span>
              ))}
              <Button size="small" disabled={c.argv.length >= 32} onClick={() => patch(i, { argv: [...c.argv, ""] })}>
                + argument
              </Button>
            </div>
            {why && <p className="s-error">{why}</p>}
            <Actions>
              <Button size="small" variant="quiet" disabled={i === 0} onClick={() => move(i, -1)}>
                Up
              </Button>
              <Button size="small" variant="quiet" disabled={i === commands.length - 1} onClick={() => move(i, 1)}>
                Down
              </Button>
              <Button size="small" variant="danger" onClick={() => onChange(commands.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </Actions>
          </fieldset>
        );
      })}
      <Actions>
        <Button size="small" disabled={commands.length >= MAX_CHECK_COMMANDS} onClick={add}>
          Add a command
        </Button>
        {!hasRebuild && (
          <Button size="small" disabled={prepares >= MAX_PREPARE_COMMANDS || commands.length >= MAX_CHECK_COMMANDS} title="Installs run with every install hook off; this step runs the install scripts afterwards, offline." onClick={addInstallScripts}>
            Add an offline step that runs install scripts
          </Button>
        )}
      </Actions>
    </div>
  );
}

// ---------- Advanced › Checks sandbox ----------

export type SandboxDraft = { sandbox: ChecksConfig["sandbox"]; prepareNetwork: boolean; commandTimeout: string; runTimeout: string; maxConcurrent: string; inputs: string; passEnv: string };

export function liveSandbox(state: State): SandboxDraft {
  const c = state.project.checks;
  return {
    sandbox: c.sandbox,
    prepareNetwork: c.prepareNetwork,
    commandTimeout: String(c.commandTimeoutMinutes),
    runTimeout: String(c.runTimeoutMinutes),
    maxConcurrent: String(c.maxConcurrent),
    inputs: c.protectedInputs.join("\n"),
    passEnv: c.passEnv.join(", "),
  };
}

function sandboxPatch(v: SandboxDraft): Partial<Omit<ChecksConfig, "rev">> {
  return {
    sandbox: v.sandbox,
    prepareNetwork: v.prepareNetwork,
    commandTimeoutMinutes: Number(v.commandTimeout),
    runTimeoutMinutes: Number(v.runTimeout),
    maxConcurrent: Number(v.maxConcurrent),
    protectedInputs: v.inputs.split("\n").map((x) => x.trim()).filter(Boolean),
    passEnv: v.passEnv.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
  };
}

export function sandboxErrors(v: SandboxDraft) {
  return {
    commandTimeout: intIn(v.commandTimeout, 1, 60) === undefined ? "Between 1 and 60 minutes." : undefined,
    runTimeout: intIn(v.runTimeout, 1, 120) === undefined ? "Between 1 and 120 minutes." : undefined,
    maxConcurrent: intIn(v.maxConcurrent, 1, 3) === undefined ? "Between 1 and 3." : undefined,
  };
}

/** Why the sandbox settings cannot be saved with today's commands (validateChecks), or undefined. */
export function sandboxProblem(state: State, v: SandboxDraft): string | undefined {
  if (Object.values(sandboxErrors(v)).some(Boolean)) return undefined;
  return validateChecks({ ...configWith(state.project.checks, sandboxPatch(v)), rev: state.project.checks.rev }, { acknowledged: true });
}

export function sandboxSteps(state: State, v: SandboxDraft, changed: ReadonlySet<keyof SandboxDraft>, send: Send): (() => Promise<SendResult> | null)[] {
  if (!changed.size) return [];
  return [() => send("setChecks", saveArgs(configWith(state.project.checks, sandboxPatch(v))))];
}

export function SandboxCard({ v, set, confirm }: { v: SandboxDraft; set: (p: Partial<SandboxDraft>) => void; confirm: Confirm }) {
  const { state, send, disabled } = useStore();
  const cfg = state.project.checks;
  const health = state.project.checksHealth;
  const errors = sandboxErrors(v);
  const problem = sandboxProblem(state, v);
  const chooseSandbox = async (sandbox: ChecksConfig["sandbox"]) => {
    if (sandbox === "none" && v.sandbox !== "none" && !(await confirm(CONFIRM_NO_SANDBOX))) return;
    set({ sandbox });
  };
  return (
    <SettingsCard
      id="sandbox"
      title="Checks sandbox"
      help={`Where and how the check commands run. Saving a change here stops check runs in progress; they run again with the new settings (now r${cfg.rev}).`}
      actions={
        <Button size="small" disabled={disabled || !cfg.enabled} disabledReason={!cfg.enabled ? "Checks are off." : undefined} onClick={() => void send("recheckChecks", {})}>
          Check again
        </Button>
      }
    >
      <div className="s-status">
        {health ? (
          <>
            <StatePill tone={health.status === "ready" ? "done" : health.status === "unavailable" ? "fail" : "neutral"}>{health.status === "ready" ? "Ready" : health.status === "unavailable" ? "Unavailable" : "Not verified"}</StatePill>
            <span className="muted">
              {health.sandbox === "codex" ? "Codex sandbox" : "no sandbox"}, checked <span title={fmtTime(health.checkedAt)}>{relTime(health.checkedAt)}</span>
              {health.recheck ? "; a new check is queued" : ""}
            </span>
          </>
        ) : (
          <span className="muted">Not checked yet; check steps wait until it is ready.</span>
        )}
      </div>
      {health && <p className="s-note">{health.detail}</p>}
      {health?.probes && (
        <p className="s-note">
          Writes outside the run's directories: {health.probes.writeOutside} · this machine's loopback: {health.probes.loopback ?? "not probed"} · network: {health.probes.network}
        </p>
      )}
      <fieldset className="s-choices s-gap">
        <legend className="k-field__label">Sandbox</legend>
        <Choice
          name="checks-sandbox"
          checked={v.sandbox === "codex"}
          onChange={() => void chooseSandbox("codex")}
          label="Codex sandbox (recommended)"
          description="Each command runs in the pinned Codex app-server's sandbox under a private, never signed-in home: no network, and writes only inside the copy of the change. While its probe fails, check steps wait; nothing falls back to no sandbox."
        />
        <Choice name="checks-sandbox" checked={v.sandbox === "none"} onChange={() => void chooseSandbox("none")} label="Run without a sandbox" description="Only if the sandbox cannot work on this computer. Every check then runs with your permissions." />
      </fieldset>
      {v.sandbox === "none" && (
        <Banner tone="fail" className="s-gap">
          No sandbox: code an agent wrote can read and write anywhere you can and reach the network. Every such run is labelled "no sandbox".
        </Banner>
      )}
      <Checkbox
        className="s-gap"
        label="Installs may use the network for dependency downloads"
        hint="npm, pnpm and yarn installs only, with every hook that could run repository code off (--ignore-scripts and the like, set again by the service). Other setup commands run offline."
        checked={v.prepareNetwork}
        onChange={(e) => set({ prepareNetwork: e.target.checked })}
      />
      <div className="s-fields">
        <Field label="Minutes per command" error={errors.commandTimeout}>
          <Input type="number" min={1} max={60} value={v.commandTimeout} onChange={(e) => set({ commandTimeout: e.target.value })} />
        </Field>
        <Field label="Minutes per run" error={errors.runTimeout}>
          <Input type="number" min={1} max={120} value={v.runTimeout} onChange={(e) => set({ runTimeout: e.target.value })} />
        </Field>
        <Field label="Runs at once" error={errors.maxConcurrent}>
          <Input type="number" min={1} max={3} value={v.maxConcurrent} onChange={(e) => set({ maxConcurrent: e.target.value })} />
        </Field>
      </div>
      <Field label="Protected check inputs (one pattern per line)" hint="A change that edits these files the checks depend on gets a finding you decide: a passing result may then mean less than before.">
        <Textarea className="s-mono" rows={5} value={v.inputs} onChange={(e) => set({ inputs: e.target.value })} />
      </Field>
      <Field
        label="Environment variables to pass through (names, comma-separated)"
        hint="Commands get a fixed allowlist (PATH, HOME, toolchain homes) plus these. Names that look like a secret (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH) never pass, nor do NODE_OPTIONS and SSH_AUTH_SOCK."
      >
        <Input type="text" className="s-mono" placeholder="none" value={v.passEnv} onChange={(e) => set({ passEnv: e.target.value })} />
      </Field>
      {problem && <Banner tone="fail">{problem}</Banner>}
      <p className="s-note">
        Results are bound to the exact commit and to the settings revision they ran with. Codex: repository instruction files are suppressed for every app-server the service starts (<span className="s-mono">project_doc_max_bytes=0</span>; not verified yet).
      </p>
    </SettingsCard>
  );
}
