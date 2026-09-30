import { useState } from "react";
import { nextStepId, upstreamOf, validatePipeline } from "../domain/pipeline";
import { ARTIFACT_KINDS, ROLES, type ArtifactKind, type InputRef, type RoleId, type StepDef, type WorkflowTemplate } from "../domain/types";
import { ROLE_LABEL } from "./common";

const refKey = (r: InputRef) => `${r.step}.${r.output}`;

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
  /** May be async; the save button stays disabled until it settles. */
  onSave: (defs: StepDef[], reason: string) => Promise<unknown> | void;
  onCancel: () => void;
}) {
  const [defs, setDefs] = useState<StepDef[]>(() => structuredClone(initial));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const issues = validatePipeline(defs);
  const errors = issues.filter((i) => i.severity === "error");

  const update = (i: number, patch: Partial<StepDef>) => setDefs((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
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
        .map((d) => ({
          ...d,
          dependsOn: d.dependsOn.filter((x) => x !== gone),
          inputs: d.inputs.filter((r) => r.step !== gone),
          runIf: d.runIf?.filter((r) => r.step !== gone),
        }));
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
                <select value={d.role} onChange={(e) => update(i, { role: e.target.value as RoleId })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

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
                  <button type="button" className="small" aria-label={`Remove ${d.id} output ${o.name}`} onClick={() => update(i, { outputs: d.outputs.filter((_, j) => j !== k) })}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="small" onClick={() => update(i, { outputs: [...d.outputs, { name: "", kind: "report" }] })}>
                Add output
              </button>
            </div>

            {available.some((r) => r.kind === "review-findings") && (
              <div className="field">
                <span>Run only if these reviews have open findings (otherwise skip)</span>
                <div className="row">
                  {available
                    .filter((r) => r.kind === "review-findings")
                    .map((r) => (
                      <label key={refKey(r)} className="row" style={{ gap: "0.25rem" }}>
                        <input type="checkbox" checked={(d.runIf ?? []).some((x) => refKey(x) === refKey(r))} onChange={(ev) => toggleRef("runIf", r, ev.target.checked)} />
                        <span className="mono">{refKey(r)}</span>
                      </label>
                    ))}
                </div>
              </div>
            )}

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
