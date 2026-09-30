import { useState } from "react";
import { nextStepId, upstreamOf, validatePipeline } from "../domain/pipeline";
import * as M from "../domain/model";
import { ARTIFACT_KINDS, PROVIDERS, STEP_ROLES, type ArtifactKind, type InputRef, type ProviderId, type RoleId, type StepDef, type WorkflowTemplate } from "../domain/types";
import { ROLE_LABEL } from "./common";

const refKey = (r: InputRef) => `${r.step}.${r.output}`;
/** Kinds a step may be conditioned on (ORC-013: check results as well as review findings). */
const CONDITION_KINDS = new Set<ArtifactKind>(["review-findings", "check-results"]);

/**
 * Draft editor for an ordered step list. Dependencies may only point to earlier steps; inputs and
 * run-if conditions may only reference outputs of upstream steps. Used for task pipelines and templates.
 */
export function PipelineEditor({
  initial,
  reservedIds = [],
  templates,
  saveLabel,
  saveBlocked,
  requireReason,
  header,
  warning,
  reviewTarget,
  checkTarget,
  checksEnabled,
  onSave,
  onCancel,
}: {
  initial: StepDef[];
  /** IDs this pipeline has ever used; new steps never reuse them. */
  reservedIds?: string[];
  templates?: WorkflowTemplate[];
  saveLabel: string;
  /** When set, saving is disabled and this reason is shown. */
  saveBlocked?: string;
  requireReason: boolean;
  header?: React.ReactNode;
  warning?: React.ReactNode;
  /** The task is a dedicated review of a pull request: the service hands its reviewer the change. */
  reviewTarget?: boolean;
  /** ORC-013: the task is a dedicated check run of a pull request's change: its Checks step reads no change. */
  checkTarget?: boolean;
  /** ORC-013: whether the project's checks are on; off, every Checks step is skipped, labelled. */
  checksEnabled?: boolean;
  /** May be async; the save button stays disabled until it settles. */
  onSave: (defs: StepDef[], reason: string) => Promise<unknown> | void;
  onCancel: () => void;
}) {
  const [defs, setDefs] = useState<StepDef[]>(() => structuredClone(initial));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const issues = validatePipeline(defs, { reviewTarget, checkTarget });
  const errors = issues.filter((i) => i.severity === "error");

  const update = (i: number, patch: Partial<StepDef>) => setDefs((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  /** ORC-013: a step that becomes a Checks step produces check results and nothing else; leaving the role drops its check settings. */
  const setRole = (i: number, role: RoleId) =>
    setDefs((ds) =>
      ds.map((d, j) => {
        if (j !== i) return d;
        if (role === "checks") return { ...d, role, outputs: [{ name: "checks", kind: "check-results" as const }], checks: d.checks ?? { onFail: "findings" as const } };
        const next: StepDef = { ...d, role };
        delete next.checks;
        if (next.outputs.some((o) => o.kind === "check-results")) next.outputs = next.outputs.filter((o) => o.kind !== "check-results");
        return next;
      }),
    );
  /** Set or clear an optional field (cleared fields are removed, not left as undefined). */
  const setOpt = <K extends "iterate" | "parallel" | "waitForChildren">(i: number, key: K, value: StepDef[K] | undefined) =>
    setDefs((ds) =>
      ds.map((d, j) => {
        if (j !== i) return d;
        const next = { ...d };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      }),
    );
  const move = (i: number, dir: -1 | 1) =>
    setDefs((ds) => {
      const next = [...ds];
      const [x] = next.splice(i, 1);
      next.splice(i + dir, 0, x);
      return next;
    });
  const remove = (i: number) =>
    setDefs((ds) => {
      const gone = ds[i].id;
      // Drop references to the removed step so the draft stays close to valid.
      return ds
        .filter((_, j) => j !== i)
        .map((d) => {
          const next: StepDef = {
            ...d,
            dependsOn: d.dependsOn.filter((x) => x !== gone),
            inputs: d.inputs.filter((r) => r.step !== gone),
            runIf: d.runIf?.filter((r) => r.step !== gone),
          };
          // A loop that started at the removed step loses its start; repeat must be set again.
          if (next.iterate?.from === gone) delete next.iterate;
          return next;
        });
    });
  const add = () =>
    setDefs((ds) => {
      const last = ds[ds.length - 1];
      return [...ds, { id: nextStepId(ds, [...reservedIds, ...initial.map((d) => d.id)]), purpose: "", role: "coder" as RoleId, dependsOn: last ? [last.id] : [], inputs: [], outputs: [{ name: "output", kind: "report" as ArtifactKind }] }];
    });

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (errors.length || saveBlocked || saving) return;
        setSaving(true);
        try {
          await onSave(defs, reason);
        } finally {
          setSaving(false);
        }
      }}
    >
      {header}
      {warning}
      {templates && templates.length > 0 && (
        <label className="row" style={{ gap: "0.4rem" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Replace draft with template
          </span>
          <select
            value=""
            onChange={(e) => {
              const tpl = templates.find((t) => t.id === e.target.value);
              if (tpl && confirm(`Replace the draft with the "${tpl.name}" template? Steps with matching IDs keep their model pins when saved.`)) setDefs(structuredClone(tpl.steps));
            }}
          >
            <option value="">Choose…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {defs.map((d, i) => {
        const earlier = defs.slice(0, i);
        const up = upstreamOf(defs.slice(0, i + 1), d.id);
        const available = earlier.filter((e) => up.has(e.id)).flatMap((e) => e.outputs.map((o) => ({ step: e.id, output: o.name, kind: o.kind })));
        const stepIssues = issues.filter((x) => x.step === d.id);
        const toggleRef = (field: "inputs" | "runIf", r: InputRef, on: boolean) => {
          const cur = d[field] ?? [];
          update(i, { [field]: on ? [...cur, r] : cur.filter((x) => refKey(x) !== refKey(r)) });
        };
        return (
          <fieldset key={d.id} className="option-edit">
            <legend>
              <span className="mono">{d.id}</span> {d.purpose || "New step"}
            </legend>
            <div className="grid">
              <label className="field">
                <span>Purpose</span>
                <input type="text" value={d.purpose} onChange={(e) => update(i, { purpose: e.target.value })} />
              </label>
              <label className="field">
                <span>Role</span>
                <select value={d.role} onChange={(e) => setRole(i, e.target.value as RoleId)}>
                  {STEP_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r === "checks" ? "Checks (run by the service)" : ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {d.role === "checks" && (
              <div className="field">
                <span>When checks fail</span>
                <div className="row">
                  <select aria-label={`${d.id} when checks fail`} value={d.checks?.onFail ?? "findings"} onChange={(e) => update(i, { checks: { ...(d.checks ?? {}), onFail: e.target.value as "findings" | "block" } })}>
                    <option value="findings">Findings for the repair step</option>
                    <option value="block">Stop and ask for a decision</option>
                  </select>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    Run by the service on the code change it reads; no provider or model. {checksEnabled ? "Checks are on for this project." : "Checks are off for this project, so this step is skipped, labelled, until they are turned on."}
                  </span>
                </div>
              </div>
            )}

            <div className="field">
              <span>Runs after</span>
              {earlier.length === 0 ? (
                <span className="muted">First step</span>
              ) : (
                <div className="row">
                  {earlier.map((e) => (
                    <label key={e.id} className="row" style={{ gap: "0.25rem" }}>
                      <input
                        type="checkbox"
                        checked={d.dependsOn.includes(e.id)}
                        onChange={(ev) => update(i, { dependsOn: ev.target.checked ? [...d.dependsOn, e.id] : d.dependsOn.filter((x) => x !== e.id) })}
                      />
                      {e.id}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <span>Reads (context passed to this step)</span>
              {available.length === 0 ? (
                <span className="muted">No upstream outputs. Add a dependency to read another step's work.</span>
              ) : (
                <div className="row">
                  {available.map((r) => (
                    <label key={refKey(r)} className="row" style={{ gap: "0.25rem" }}>
                      <input type="checkbox" checked={d.inputs.some((x) => refKey(x) === refKey(r))} onChange={(ev) => toggleRef("inputs", r, ev.target.checked)} />
                      <span className="mono">{refKey(r)}</span>
                      <span className="chip">{r.kind}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <span>Produces</span>
              {d.outputs.map((o, k) => (
                <div key={k} className="row" style={{ marginBottom: "0.3rem" }}>
                  <input
                    type="text"
                    aria-label={`${d.id} output ${k + 1} name`}
                    value={o.name}
                    style={{ width: "10rem" }}
                    onChange={(e) => update(i, { outputs: d.outputs.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })}
                  />
                  <select aria-label={`${d.id} output ${k + 1} kind`} value={o.kind} onChange={(e) => update(i, { outputs: d.outputs.map((x, j) => (j === k ? { ...x, kind: e.target.value as ArtifactKind } : x)) })}>
                    {ARTIFACT_KINDS.map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </select>
                  {o.kind === "breakdown" && (
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      Each listed item becomes a child task.
                    </span>
                  )}
                  <button type="button" className="small" aria-label={`Remove ${d.id} output ${o.name}`} onClick={() => update(i, { outputs: d.outputs.filter((_, j) => j !== k) })}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="small" onClick={() => update(i, { outputs: [...d.outputs, { name: "", kind: "report" }] })}>
                Add output
              </button>
            </div>

            {available.some((r) => CONDITION_KINDS.has(r.kind)) && d.role !== "checks" && (
              <div className="field">
                <span>Run only if these reviews or check results have findings to fix (otherwise skip)</span>
                <div className="row">
                  {available
                    .filter((r) => CONDITION_KINDS.has(r.kind))
                    .map((r) => (
                      <label key={refKey(r)} className="row" style={{ gap: "0.25rem" }}>
                        <input type="checkbox" checked={(d.runIf ?? []).some((x) => refKey(x) === refKey(r))} onChange={(ev) => toggleRef("runIf", r, ev.target.checked)} />
                        <span className="mono">{refKey(r)}</span>
                      </label>
                    ))}
                </div>
              </div>
            )}

            <label className="row" style={{ gap: "0.35rem", marginBottom: "0.6rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={!!d.gate}
                onChange={(ev) =>
                  setDefs((ds) =>
                    ds.map((x, j) => {
                      if (j !== i) return x;
                      const next = { ...x };
                      if (ev.target.checked) next.gate = true;
                      else delete next.gate;
                      return next;
                    }),
                  )
                }
              />
              Pause for review after this step
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                (you can read or edit its artifacts before the next step starts)
              </span>
            </label>

            <FanOutFields defs={defs} index={i} setOpt={setOpt} />

            {stepIssues.length > 0 && (
              <ul className="plain" style={{ fontSize: "0.85rem" }}>
                {stepIssues.map((x, k) => (
                  <li key={k} style={{ color: x.severity === "error" ? "var(--s-blocked)" : "var(--muted)" }}>
                    {x.severity === "error" ? "Error: " : "Note: "}
                    {x.message}
                  </li>
                ))}
              </ul>
            )}

            <div className="row">
              <button type="button" className="small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${d.id} up`}>
                Move up
              </button>
              <button type="button" className="small" disabled={i === defs.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${d.id} down`}>
                Move down
              </button>
              <button type="button" className="small danger" onClick={() => remove(i)} aria-label={`Remove ${d.id}`}>
                Remove step
              </button>
            </div>
          </fieldset>
        );
      })}
      <button type="button" onClick={add}>
        Add step
      </button>

      {issues.filter((x) => !x.step).map((x, k) => (
        <p key={k} style={{ color: "var(--s-blocked)" }}>
          {x.message}
        </p>
      ))}

      <div className="sticky-actions">
        {requireReason && (
          <label className="field" style={{ flex: "1 1 18rem", margin: 0 }}>
            <span>Reason for this change (required)</span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
        )}
        <button type="submit" className="primary" disabled={errors.length > 0 || !!saveBlocked || saving} title={saveBlocked}>
          {saveLabel}
        </button>
        <button type="button" onClick={onCancel}>
          Discard
        </button>
        {errors.length > 0 && (
          <span style={{ color: "var(--s-blocked)", fontSize: "0.85rem" }}>
            {errors.length} error(s) to fix
          </span>
        )}
      </div>
    </form>
  );
}

const PARALLEL_COUNTS = [2, 3, 4, 5];

/** Per-step fan-out settings: parallel agents, repeat (loop), and waiting for child tasks. */
function FanOutFields({
  defs,
  index,
  setOpt,
}: {
  defs: StepDef[];
  index: number;
  setOpt: <K extends "iterate" | "parallel" | "waitForChildren">(i: number, key: K, value: StepDef[K] | undefined) => void;
}) {
  const d = defs[index];
  const loopTargets = defs.slice(0, index + 1);
  const isBreakdown = d.outputs.some((o) => o.kind === "breakdown");
  const expanded = !!d.copyOf; // already split into copies on a running task
  const isCopy = !!d.copyOf && d.copyOf !== d.id;
  const summary = [d.parallel && `parallel ×${d.parallel.count}`, d.iterate && `repeats ×${d.iterate.max}`, d.waitForChildren && "waits for child tasks"].filter(Boolean).join(" · ");
  const setParallel = (patch: Partial<NonNullable<StepDef["parallel"]>>) => {
    const cur = d.parallel ?? { count: 2, mode: "copies" as const };
    const next = { ...cur, ...patch };
    if (!next.providers?.length) delete next.providers;
    setOpt(index, "parallel", next);
  };
  const toggleProvider = (p: ProviderId, on: boolean) => {
    const cur = d.parallel?.providers ?? [];
    const set = on ? [...cur, p] : cur.filter((x) => x !== p);
    // Keep a stable order so round-robin assignment is predictable.
    setParallel({ providers: PROVIDERS.filter((x) => set.includes(x)) });
  };
  const iterateDefault = () => ({ from: d.runIf?.[0]?.step && loopTargets.some((x) => x.id === d.runIf![0].step) ? d.runIf[0].step : d.id, max: 3 });
  return (
    <details className="advanced" open={!!(d.parallel || d.iterate || d.waitForChildren || d.copyOf)} style={{ marginBottom: "0.6rem" }}>
      <summary style={{ fontSize: "0.9rem" }}>
        Parallel agents, repeat, child tasks{summary && <span className="muted"> · {summary}</span>}
      </summary>
      <div className="stack" style={{ padding: "0.5rem 0 0 0.2rem", fontSize: "0.9rem" }}>
        {isCopy ? (
          <p className="muted" style={{ margin: 0 }}>
            This step is a parallel copy of <span className="mono">{d.copyOf}</span>. Its settings follow that group.
          </p>
        ) : (
          <div className="field" style={{ margin: 0 }}>
            <span>Run as parallel agents</span>
            <div className="row">
              <select
                aria-label={`${d.id} parallel agents`}
                value={d.parallel ? String(d.parallel.count) : ""}
                disabled={expanded}
                onChange={(e) => (e.target.value ? setParallel({ count: Number(e.target.value) }) : setOpt(index, "parallel", undefined))}
              >
                <option value="">Off (one agent)</option>
                {PARALLEL_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n} agents
                  </option>
                ))}
              </select>
              {d.parallel && (
                <>
                  <label className="row" style={{ gap: "0.25rem" }}>
                    <input type="radio" name={`${d.id}-mode`} checked={d.parallel.mode === "copies"} disabled={expanded} onChange={() => setParallel({ mode: "copies" })} />
                    Copies
                  </label>
                  <label className="row" style={{ gap: "0.25rem" }}>
                    <input type="radio" name={`${d.id}-mode`} checked={d.parallel.mode === "best-of"} disabled={expanded} onChange={() => setParallel({ mode: "best-of" })} />
                    Best of {d.parallel.count}
                  </label>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    Providers:
                  </span>
                  {PROVIDERS.map((p) => (
                    <label key={p} className="row" style={{ gap: "0.25rem" }}>
                      <input type="checkbox" checked={!!d.parallel?.providers?.includes(p)} disabled={expanded} onChange={(e) => toggleProvider(p, e.target.checked)} />
                      {M.providerLabel(p)}
                    </label>
                  ))}
                </>
              )}
            </div>
            {d.parallel && (
              <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
                {d.parallel.mode === "copies"
                  ? "Copies: every agent's output goes forward; review findings are summed."
                  : "Best of N: agents work separately and a later step that reads this output must choose one; only the chosen work goes further."}{" "}
                {d.parallel.providers?.length
                  ? `Agents alternate between ${d.parallel.providers.map((p) => M.providerLabel(p)).join(" and ")}.`
                  : "Every agent uses this step's model."}
                {expanded && " Already split into agents on this task, so these settings no longer change."}
              </span>
            )}
          </div>
        )}

        <div className="field" style={{ margin: 0 }}>
          <label className="row" style={{ gap: "0.35rem" }}>
            <input type="checkbox" checked={!!d.iterate} onChange={(e) => setOpt(index, "iterate", e.target.checked ? iterateDefault() : undefined)} />
            Repeat
          </label>
          {d.iterate && (
            <>
              <div className="row">
                <label className="row" style={{ gap: "0.3rem" }}>
                  from
                  <select aria-label={`${d.id} repeat from`} value={d.iterate.from} onChange={(e) => setOpt(index, "iterate", { ...d.iterate!, from: e.target.value })}>
                    {!loopTargets.some((x) => x.id === d.iterate!.from) && <option value={d.iterate.from}>{d.iterate.from} (not earlier)</option>}
                    {loopTargets.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.id}
                        {x.id === d.id ? " (this step)" : ""} {x.purpose}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="row" style={{ gap: "0.3rem" }}>
                  up to
                  <input
                    type="number"
                    aria-label={`${d.id} repeat rounds`}
                    min={1}
                    max={10}
                    step={1}
                    value={Number.isFinite(d.iterate.max) ? d.iterate.max : ""}
                    style={{ width: "4rem" }}
                    onChange={(e) => setOpt(index, "iterate", { ...d.iterate!, max: e.target.value === "" ? NaN : Number(e.target.value) })}
                  />
                  rounds
                </label>
              </div>
              <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
                Repeats from {d.iterate.from} through this step until this step is skipped (e.g. no open findings) or {Number.isFinite(d.iterate.max) ? d.iterate.max : "N"} rounds
                {isBreakdown ? "; because this is a breakdown step, until it lists no more items." : "; for a breakdown step, until it lists no more items."}
              </span>
            </>
          )}
        </div>

        <label className="row" style={{ gap: "0.35rem" }}>
          <input type="checkbox" checked={!!d.waitForChildren} onChange={(e) => setOpt(index, "waitForChildren", e.target.checked ? true : undefined)} />
          Wait for child tasks
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            Use after a breakdown step: waits until every child task has finished.
          </span>
        </label>
      </div>
    </details>
  );
}
