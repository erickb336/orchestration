// Settings → Checks (ORC-013 §12): the project's own check commands, run by the service in the Codex
// sandbox on a throwaway copy of each change. Off until the user turns it on; the commands are the
// user's settings and nothing an agent writes can change them. The sandbox's health is shown as the
// service observed it; running without a sandbox is a separate, explicit choice with its own warning.

import { useEffect, useState } from "react";
import type { CheckSuggestions } from "../api";
import { CHECK_PROGRAMS, MAX_CHECK_COMMANDS, MAX_PREPARE_COMMANDS, validateChecks, validateCommand } from "../domain/checks";
import type { CheckCommand, ChecksConfig } from "../domain/types";
import { fmtTime, relTime } from "./common";
import { useStore } from "./store";

type Draft = Omit<ChecksConfig, "rev">;

const ON_TEXT =
  "Turn checks on?\n\nChecks run the repository's own code on this computer: its test scripts, its build, and whatever those start, including code agents wrote.\n\nThe Codex sandbox blocks writes outside a temporary copy of the change, and blocks the network for everything except npm, pnpm and yarn dependency downloads, which run with every install hook off. It does not stop that code from reading your files.\n\nTurn checks on only for repositories whose agents' work you are willing to run.";
const NO_SANDBOX_TEXT =
  "Run checks without a sandbox?\n\nEvery check will run with your permissions: it can read and write anywhere you can and reach the network. Code an agent wrote will run that way. The app never chooses this by itself; every such run is labelled as unsandboxed.\n\nChoose this only if the Codex sandbox cannot work on this computer and you accept the risk.";

const fromConfig = (c: ChecksConfig): Draft => ({
  enabled: c.enabled,
  commands: c.commands.map((x) => ({ ...x, argv: [...x.argv] })),
  sandbox: c.sandbox,
  prepareNetwork: c.prepareNetwork,
  commandTimeoutMinutes: c.commandTimeoutMinutes,
  runTimeoutMinutes: c.runTimeoutMinutes,
  maxConcurrent: c.maxConcurrent,
  protectedInputs: [...c.protectedInputs],
  passEnv: [...c.passEnv],
});

export function ChecksSettings() {
  const { state, service, send, disabled } = useStore();
  const cfg = state.project.checks;
  const health = state.project.checksHealth;
  const real = service.runtime === "real";
  const sampleBlocked = real && state.project.sample;
  const liveKey = JSON.stringify(cfg);
  const [draft, setDraft] = useState<Draft>(() => fromConfig(cfg));
  const [inputs, setInputs] = useState(cfg.protectedInputs.join("\n"));
  const [passEnv, setPassEnv] = useState(cfg.passEnv.join(", "));
  const [suggested, setSuggested] = useState<CheckSuggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // Follow the live settings when they change elsewhere (another tab, a saved edit).
  useEffect(() => {
    setDraft(fromConfig(cfg));
    setInputs(cfg.protectedInputs.join("\n"));
    setPassEnv(cfg.passEnv.join(", "));
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const next: Draft = {
    ...draft,
    protectedInputs: inputs.split("\n").map((x) => x.trim()).filter(Boolean),
    passEnv: passEnv.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
  };
  const changed = JSON.stringify({ ...next, rev: cfg.rev }) !== liveKey;
  const problem = validateChecks({ ...next, rev: cfg.rev }, { acknowledged: true });
  const checksInUse = next.commands.filter((c) => c.kind === "check").length;
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const patchCommand = (i: number, p: Partial<CheckCommand>) => setDraft((d) => ({ ...d, commands: d.commands.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  const setArg = (i: number, k: number, value: string) => setDraft((d) => ({ ...d, commands: d.commands.map((c, j) => (j === i ? { ...c, argv: c.argv.map((a, l) => (l === k ? value : a)) } : c)) }));
  const addArg = (i: number) => setDraft((d) => ({ ...d, commands: d.commands.map((c, j) => (j === i ? { ...c, argv: [...c.argv, ""] } : c)) }));
  const dropArg = (i: number, k: number) => setDraft((d) => ({ ...d, commands: d.commands.map((c, j) => (j === i && c.argv.length > 1 ? { ...c, argv: c.argv.filter((_, l) => l !== k) } : c)) }));
  const removeCommand = (i: number) => setDraft((d) => ({ ...d, commands: d.commands.filter((_, j) => j !== i) }));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const cs = [...d.commands];
      const [x] = cs.splice(i, 1);
      cs.splice(i + dir, 0, x);
      return { ...d, commands: cs };
    });
  const addCommand = () => {
    const used = new Set(draft.commands.map((c) => c.id));
    let n = draft.commands.length + 1;
    while (used.has(`check-${n}`)) n++;
    setDraft((d) => ({ ...d, commands: [...d.commands, { id: `check-${n}`, label: `Check ${n}`, kind: "check", argv: ["npm", "test"] }] }));
  };

  const save = async () => {
    if (next.enabled && !cfg.enabled && !confirm(ON_TEXT)) return;
    await send("setChecks", { config: next, ...(next.sandbox === "none" ? { acknowledgeUnsandboxed: true } : {}) });
  };
  const chooseSandbox = (sandbox: "codex" | "none") => {
    if (sandbox === "none" && draft.sandbox !== "none" && !confirm(NO_SANDBOX_TEXT)) return;
    patch({ sandbox });
  };
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

  const tone = !cfg.enabled ? "chip" : health?.status === "ready" ? "pill done" : health?.status === "unavailable" ? "pill blocked" : "pill paused";
  const statusText = !cfg.enabled ? "Off" : cfg.sandbox === "none" ? "On · no sandbox" : health?.status === "ready" ? "On · sandbox ready" : health?.status === "unavailable" ? "On · sandbox unavailable: check steps wait" : "On · sandbox not checked yet";

  return (
    <section className="card" aria-labelledby="checks-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="checks-h" style={{ margin: 0 }}>
          Checks (run by the service)
        </h2>
        <span className={tone}>{statusText}</span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
        The service runs these commands itself on a throwaway copy of each change: after a coder's work, before the review, and once more on the final change before the task finishes. A failing command becomes a finding the repair
        step fixes. If the final change still fails, the task waits for a decision; only you can accept failing checks. Agents never choose or change these commands.
      </p>
      <p style={{ fontSize: "0.85rem" }}>
        Checks run the repository's own code on this computer: its test scripts, its build, and whatever those start, including code agents wrote. With the Codex sandbox, that code cannot write outside a throwaway copy of the change and
        cannot use the network; the one exception is a dependency download by npm, pnpm or yarn, which runs with every install hook off, so no repository code runs while the network is on. The sandbox does not stop that code from
        reading your files. Turn checks on only for repositories whose agents' work you are willing to run.
      </p>
      {sampleBlocked && <div className="banner">This is the sample project: it has no repository, so its checks cannot be turned on. Start a project of your own in Settings → Project.</div>}
      {!real && <div className="banner neutral">Fake runtime: check runs are simulated. Nothing is run and nothing is spawned; the results say so.</div>}

      <fieldset className="plain-fieldset" disabled={disabled}>
        <label className="row field" style={{ gap: "0.4rem" }}>
          <input type="checkbox" checked={next.enabled} disabled={sampleBlocked} onChange={(e) => patch({ enabled: e.target.checked })} />
          <strong>Run the project's checks on every change</strong>
        </label>

        <h3 style={{ margin: "0.8rem 0 0.3rem" }}>Sandbox</h3>
        {cfg.enabled && (
          <div style={{ fontSize: "0.85rem", marginBottom: "0.4rem" }}>
            {health ? (
              <>
                <span className={health.status === "ready" ? "pill done" : health.status === "unavailable" ? "pill blocked" : "pill paused"}>{health.status === "ready" ? "Ready" : health.status === "unavailable" ? "Unavailable" : "Not verified"}</span>{" "}
                <span className="muted">
                  ({health.sandbox === "codex" ? "Codex sandbox" : "no sandbox"}, checked <span title={fmtTime(health.checkedAt)}>{relTime(health.checkedAt)}</span>
                  {health.recheck ? "; a new check is queued" : ""})
                </span>
                <div>{health.detail}</div>
                {health.probes && (
                  <div className="muted">
                    Writes outside the run's directories: {health.probes.writeOutside} · this machine's loopback: {health.probes.loopback ?? "not probed"} · network: {health.probes.network}
                  </div>
                )}
              </>
            ) : (
              <span className="muted">The sandbox has not been checked yet; check steps wait until it is ready.</span>
            )}{" "}
            <button className="small" disabled={disabled || !cfg.enabled} onClick={() => void send("recheckChecks", {})}>
              Check again
            </button>
          </div>
        )}
        <label className="row" style={{ gap: "0.35rem", alignItems: "flex-start" }}>
          <input type="radio" name="checks-sandbox" checked={next.sandbox === "codex"} onChange={() => chooseSandbox("codex")} style={{ marginTop: "0.3rem" }} />
          <span>
            <strong style={{ fontWeight: 560 }}>Codex sandbox (recommended)</strong>
            <span className="muted" style={{ display: "block", fontSize: "0.82rem" }}>
              Each command runs through the pinned Codex app-server's sandbox under a private, never signed-in home: no network, and writes only inside the copy of the change, its temp directory and a cache. The service probes the sandbox before
              any run; while the probe fails, check steps wait. Nothing falls back to running without a sandbox by itself.
            </span>
          </span>
        </label>
        <label className="row" style={{ gap: "0.35rem", alignItems: "flex-start", marginTop: "0.3rem" }}>
          <input type="radio" name="checks-sandbox" checked={next.sandbox === "none"} onChange={() => chooseSandbox("none")} style={{ marginTop: "0.3rem" }} />
          <span>
            <strong style={{ fontWeight: 560 }}>Run without a sandbox</strong>
            <span className="muted" style={{ display: "block", fontSize: "0.82rem" }}>
              Only if the sandbox cannot work on this computer. Every check then runs with your permissions.
            </span>
          </span>
        </label>
        {next.sandbox === "none" && <div className="banner danger">No sandbox: checks run with your permissions. Code an agent wrote can read and write anywhere you can and reach the network. Every such run is labelled "no sandbox".</div>}
        <label className="row" style={{ gap: "0.4rem", marginTop: "0.4rem", fontSize: "0.9rem" }}>
          <input type="checkbox" checked={next.prepareNetwork} onChange={(e) => patch({ prepareNetwork: e.target.checked })} />
          Prepare commands may use the network for dependency downloads
        </label>
        <p className="muted" style={{ fontSize: "0.82rem", margin: "0.2rem 0 0 1.5rem" }}>
          Downloads the network may be used for: npm, pnpm, yarn installs only; other setup commands run offline (prefetch what they need in your own environment). Such an install runs with every hook that could run repository code
          off: "--ignore-scripts" (npm, pnpm, yarn 1) or "--mode=skip-build" (yarn 2+), plus "--ignore-pnpmfile" for pnpm, all required on the command and set again by the service; yarn never runs the repository's own yarn
          copy or plugins, and is kept offline when .yarnrc.yml sets yarnPath or plugins. If your project needs its install scripts, add the offline step below: it runs them afterwards in the throwaway copy, with no network.
        </p>
        {!next.commands.some((c) => c.kind === "prepare" && c.argv[1] === "rebuild") && (
          <button
            className="small"
            style={{ marginLeft: "1.5rem", marginTop: "0.3rem" }}
            disabled={next.commands.filter((c) => c.kind === "prepare").length >= MAX_PREPARE_COMMANDS || next.commands.length >= MAX_CHECK_COMMANDS}
            onClick={() => {
              const pm = next.commands.find((c) => c.kind === "prepare" && ["npm", "pnpm", "yarn"].includes(c.argv[0]))?.argv[0] ?? "npm";
              let at = 0;
              next.commands.forEach((c, i) => {
                if (c.kind === "prepare") at = i + 1;
              });
              setDraft((d) => ({ ...d, commands: [...d.commands.slice(0, at), { id: "install-scripts", label: "Run install scripts (offline)", kind: "prepare", argv: [pm, "rebuild"] }, ...d.commands.slice(at)] }));
            }}
          >
            Add an offline step that runs install scripts
          </button>
        )}

        <div className="row" style={{ justifyContent: "space-between", marginTop: "0.9rem" }}>
          <h3 style={{ margin: 0 }}>Commands</h3>
          <span className="row" style={{ gap: "0.4rem" }}>
            <button className="small" disabled={suggesting || sampleBlocked} onClick={() => void suggest()}>
              {suggesting ? "Reading…" : "Suggest from the repository"}
            </button>
            <button className="small" disabled={next.commands.length >= MAX_CHECK_COMMANDS} onClick={addCommand}>
              Add a command
            </button>
          </span>
        </div>
        <p className="muted" style={{ fontSize: "0.82rem", margin: "0.25rem 0 0.5rem" }}>
          Each command is a list of arguments, never a shell line. Only these programs can run: {CHECK_PROGRAMS.join(", ")}. Package managers may only install, test or run a script; interpreters may not run inline code. Prepare commands run
          first (at most {MAX_PREPARE_COMMANDS}), then the checks, in this order. At most {MAX_CHECK_COMMANDS} in all.
        </p>
        {suggested && (
          <div className="banner neutral" style={{ marginBottom: "0.5rem" }}>
            {suggested.commands.length ? (
              <>
                <div>
                  Suggested from the repository at <span className="mono">{suggested.ref}</span>. Nothing is saved until you use them and save:
                </div>
                <ul className="plain" style={{ margin: "0.3rem 0" }}>
                  {suggested.commands.map((c) => (
                    <li key={c.id}>
                      <span className="chip">{c.kind}</span> <span className="mono">{c.argv.join(" ")}</span>
                    </li>
                  ))}
                </ul>
                <button
                  className="small primary"
                  onClick={() => {
                    patch({ commands: suggested.commands.map((c) => ({ ...c, argv: [...c.argv] })) });
                    setSuggested(null);
                  }}
                >
                  Use these
                </button>{" "}
                <button className="small" onClick={() => setSuggested(null)}>
                  Dismiss
                </button>
              </>
            ) : (
              <>{suggested.reason ?? "Nothing to suggest."}</>
            )}
          </div>
        )}
        {next.commands.length === 0 && <p className="muted">No commands yet. Checks do nothing until at least one check command is set.</p>}
        {next.commands.map((c, i) => {
          const why = validateCommand(c);
          return (
            <fieldset key={i} className="option-edit" style={{ margin: "0 0 0.5rem" }}>
              <legend>
                <span className="mono">{c.id || "(no id)"}</span> {c.label}
              </legend>
              <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <label className="field" style={{ margin: 0 }}>
                  <span>Id</span>
                  <input type="text" value={c.id} onChange={(e) => patchCommand(i, { id: e.target.value })} style={{ width: "9rem" }} aria-label={`Command ${i + 1} id`} />
                </label>
                <label className="field" style={{ margin: 0 }}>
                  <span>Label</span>
                  <input type="text" value={c.label} onChange={(e) => patchCommand(i, { label: e.target.value })} style={{ width: "11rem" }} aria-label={`Command ${i + 1} label`} />
                </label>
                <label className="field" style={{ margin: 0 }}>
                  <span>Kind</span>
                  <select value={c.kind} onChange={(e) => patchCommand(i, { kind: e.target.value as "prepare" | "check" })} aria-label={`Command ${i + 1} kind`}>
                    <option value="check">check</option>
                    <option value="prepare">prepare (install)</option>
                  </select>
                </label>
                <label className="field" style={{ margin: 0 }}>
                  <span>Time limit (min)</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={c.timeoutMinutes ?? ""}
                    placeholder={String(next.commandTimeoutMinutes)}
                    onChange={(e) => patchCommand(i, { timeoutMinutes: e.target.value === "" ? undefined : Number(e.target.value) })}
                    style={{ width: "5rem" }}
                    aria-label={`Command ${i + 1} time limit`}
                  />
                </label>
              </div>
              <div className="field" style={{ marginTop: "0.4rem" }}>
                <span>Arguments (the program first)</span>
                <div className="row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
                  {c.argv.map((a, k) => (
                    <span key={k} className="row" style={{ gap: "0.15rem" }}>
                      <input type="text" className="mono" value={a} onChange={(e) => setArg(i, k, e.target.value)} style={{ width: k === 0 ? "7rem" : "9rem" }} aria-label={`Command ${i + 1} argument ${k + 1}`} />
                      {c.argv.length > 1 && (
                        <button className="link" onClick={() => dropArg(i, k)} aria-label={`Remove argument ${k + 1} of command ${i + 1}`} title="Remove this argument">
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  <button className="small" onClick={() => addArg(i)} disabled={c.argv.length >= 32}>
                    + argument
                  </button>
                </div>
              </div>
              {why && <div style={{ color: "var(--s-blocked)", fontSize: "0.82rem" }}>{why}</div>}
              <div className="row" style={{ gap: "0.3rem", marginTop: "0.3rem" }}>
                <button className="small" onClick={() => move(i, -1)} disabled={i === 0}>
                  Up
                </button>
                <button className="small" onClick={() => move(i, 1)} disabled={i === next.commands.length - 1}>
                  Down
                </button>
                <button className="small danger" onClick={() => removeCommand(i)}>
                  Remove
                </button>
              </div>
            </fieldset>
          );
        })}

        <h3 style={{ margin: "0.8rem 0 0.3rem" }}>Limits</h3>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="field">
            <span>Time limit per command (minutes)</span>
            <input type="number" min={1} max={60} value={next.commandTimeoutMinutes} onChange={(e) => patch({ commandTimeoutMinutes: Number(e.target.value) })} style={{ width: "6rem" }} />
          </label>
          <label className="field">
            <span>Time limit per run (minutes)</span>
            <input type="number" min={1} max={120} value={next.runTimeoutMinutes} onChange={(e) => patch({ runTimeoutMinutes: Number(e.target.value) })} style={{ width: "6rem" }} />
          </label>
          <label className="field">
            <span>Runs at once</span>
            <input type="number" min={1} max={3} value={next.maxConcurrent} onChange={(e) => patch({ maxConcurrent: Number(e.target.value) })} style={{ width: "5rem" }} />
          </label>
        </div>

        <label className="field">
          <span>Protected check inputs (one pattern per line)</span>
          <textarea value={inputs} onChange={(e) => setInputs(e.target.value)} rows={4} className="mono" style={{ fontSize: "0.82rem" }} />
          <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
            A change that edits any of these (the files the checks depend on) gets a finding that needs a decision: a passing result may then mean less than before.
          </span>
        </label>
        <label className="field">
          <span>Environment variables to pass through (names, comma-separated)</span>
          <input type="text" value={passEnv} onChange={(e) => setPassEnv(e.target.value)} className="mono" placeholder="none" />
          <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
            Commands get an environment built from a fixed allowlist (PATH, HOME, language toolchain homes) plus these. Names that look like a secret (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH) never pass; neither do NODE_OPTIONS,
            SSH_AUTH_SOCK or any token variable.
          </span>
        </label>

        {problem && (
          <div className="banner danger" role="alert">
            {problem}
          </div>
        )}
        {next.enabled && checksInUse === 0 && !problem && <div className="banner">Checks are on with no check command: every Checks step is skipped, labelled, until one is added.</div>}
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button className="primary" disabled={disabled || !changed || !!problem || sampleBlocked} onClick={() => void save()}>
            Save checks{changed ? ` (settings r${cfg.rev + 1})` : ""}
          </button>
          {changed && (
            <button
              onClick={() => {
                setDraft(fromConfig(cfg));
                setInputs(cfg.protectedInputs.join("\n"));
                setPassEnv(cfg.passEnv.join(", "));
              }}
            >
              Discard changes
            </button>
          )}
        </div>
      </fieldset>
      <p className="muted" style={{ fontSize: "0.8rem", margin: "0.6rem 0 0" }}>
        Saving a change to the commands, sandbox, limits or inputs stops check runs in progress; they run again with the new settings. Results are bound to the exact commit and to the settings revision they ran with (now r{cfg.rev}). Codex:
        repository instruction files suppressed for every app-server the service starts (<span className="mono">project_doc_max_bytes=0</span>; not verified yet).
      </p>
    </section>
  );
}
