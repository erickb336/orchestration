import { useState } from "react";
import * as M from "../domain/model";
import { PROVIDERS, ROLES, type WorkflowTemplate } from "../domain/types";
import { BUILT_IN_TEMPLATES, isModifiedBuiltIn } from "../domain/templates";
import { PipelineEditor } from "./PipelineEditor";
import { PROTOTYPE_CAPABILITIES, type CapabilityMap } from "../runtime/adapter";
import { useStore } from "./store";
import { ModelPicker, ROLE_LABEL } from "./common";

const CAP_LABEL: Record<keyof CapabilityMap, string> = {
  start: "Start",
  streamEvents: "Stream events",
  steer: "Live steering",
  interrupt: "Interrupt",
  resume: "Resume",
  usageReporting: "Usage reporting",
  childAgentTracking: "Child-agent tracking",
};

export function Settings() {
  const { state, apply } = useStore();
  const p = state.project;
  const [repo, setRepo] = useState(p.repoPath);
  const [limit, setLimit] = useState(String(p.workerLimit));
  return (
    <>
      <h1>Settings</h1>
      <div className="grid-2">
        <div>
          <section className="card" aria-labelledby="proj-h">
            <h2 id="proj-h">Project</h2>
            <label className="field">
              <span>Managed repository path</span>
              <div className="row">
                <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} style={{ flex: 1 }} />
                <button disabled={repo === p.repoPath} onClick={() => apply((s, now) => M.setRepoPath(s, repo, now))}>
                  Save
                </button>
              </div>
            </label>
            <label className="field">
              <span>Total worker limit</span>
              <div className="row">
                <input type="number" min={1} max={8} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: "5rem" }} />
                <button disabled={Number(limit) === p.workerLimit} onClick={() => apply((s, now) => M.setWorkerLimit(s, Number(limit), now))}>
                  Save
                </button>
              </div>
            </label>
          </section>

          <section className="card" aria-labelledby="defaults-h">
            <h2 id="defaults-h">Model defaults</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Changes apply to steps not yet dispatched that you haven't pinned. Runs already dispatched keep the configuration they started with.
            </p>
            <dl className="kv">
              <dt>Project default</dt>
              <dd>
                <ModelPicker state={state} label="Project default model" value={p.defaultSelection} onChange={(v) => v && apply((s, now) => M.setProjectDefault(s, v, now))} />
              </dd>
              {ROLES.map((role) => (
                <div key={role} style={{ display: "contents" }}>
                  <dt>{ROLE_LABEL[role]}</dt>
                  <dd>
                    <ModelPicker
                      state={state}
                      label={`Default for ${ROLE_LABEL[role]}`}
                      value={p.roleDefaults[role] ?? null}
                      allowInherit
                      inheritLabel="Use project default"
                      onChange={(v) => apply((s, now) => M.setRoleDefault(s, role, v, now))}
                    />
                  </dd>
                </div>
              ))}
              <dt>Lead ownership</dt>
              <dd>
                <span className="muted">The Lead default applies to lead-owned steps such as verification. Switching the scheduling lead (checkpoint and lease transfer) arrives in Milestone 4.</span>
              </dd>
            </dl>
          </section>
          <Templates />
        </div>

        <div>
          <section className="card" aria-labelledby="prov-h">
            <h2 id="prov-h">Providers</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              No provider is connected in this prototype. Capabilities are what the simulation models, not verified runtime behavior. Model lists are a sample catalog.
            </p>
            {PROVIDERS.map((prov) => {
              const info = PROTOTYPE_CAPABILITIES[prov];
              const enabled = p.enabledProviders.includes(prov);
              return (
                <div key={prov} style={{ marginBottom: "1rem" }}>
                  <label className="row">
                    <input type="checkbox" checked={enabled} onChange={(e) => apply((s, now) => M.setProviderEnabled(s, prov, e.target.checked, now))} />
                    <strong>{M.providerLabel(prov)}</strong>
                    <span className="chip">not connected</span>
                  </label>
                  <div className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.4rem" }}>
                    {info.adapter}
                  </div>
                  <table>
                    <tbody>
                      {(Object.keys(CAP_LABEL) as (keyof CapabilityMap)[]).map((k) => (
                        <tr key={k}>
                          <td>{CAP_LABEL[k]}</td>
                          <td>
                            <span className="chip">{info.capabilities[k]}</span>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>Sample models</td>
                        <td className="mono">{p.catalog[prov].map((m) => m.id).join(", ")}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </>
  );
}

function Templates() {
  const { state, apply } = useStore();
  // baseRev: the template revision the draft started from; null for a new template.
  const [draft, setDraft] = useState<{ tpl: WorkflowTemplate; baseRev: number | null } | null>(null);
  const editing = draft?.tpl ?? null;
  const setEditing = (tpl: WorkflowTemplate) => setDraft((d) => (d ? { ...d, tpl } : d));
  const templates = state.project.templates;
  const missingBuiltIns = BUILT_IN_TEMPLATES.filter((b) => !templates.some((t) => t.id === b.id));

  if (editing) {
    return (
      <section className="card" aria-labelledby="tpl-h">
        <h2 id="tpl-h">{draft!.baseRev !== null ? `Edit template: ${editing.name}` : "New template"}</h2>
        <PipelineEditor
          initial={editing.steps}
          saveLabel="Save template"
          requireReason={false}
          header={
            <>
              <label className="field">
                <span>Name</span>
                <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
              <label className="field">
                <span>When to use it</span>
                <input type="text" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </label>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Templates describe kinds of work, not a specific app. Saving never changes existing task pipelines.
              </p>
            </>
          }
          onSave={(steps) => {
            const ok = apply((s, now) => M.saveTemplate(s, { ...editing, steps }, draft!.baseRev, now));
            if (ok) setDraft(null);
            return ok;
          }}
          onCancel={() => setDraft(null)}
        />
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="tpl-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="tpl-h">Workflow templates</h2>
        <button
          className="small"
          onClick={() =>
            setDraft({
              baseRev: null,
              tpl: {
              id: `custom-${Date.now().toString(36)}`,
              name: "",
              description: "",
              builtIn: false,
              rev: 0,
              steps: [{ id: "S1", purpose: "", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }],
              },
            })
          }
        >
          New template
        </button>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Starting pipelines for any project goal. A task's pipeline can be replaced from a template while editing it.
      </p>
      {templates.length === 0 && <p className="muted">No templates.</p>}
      <ul className="events">
        {templates.map((t) => (
          <li key={t.id} style={{ gridTemplateColumns: "1fr auto" }}>
            <span>
              <strong>{t.name}</strong> {t.builtIn && <span className="chip">{isModifiedBuiltIn(t) ? "built-in, edited" : "built-in"}</span>}
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {t.description}
              </div>
              <div className="mono muted" style={{ fontSize: "0.78rem" }}>
                {t.steps.map((st) => `${st.id} ${st.purpose}${st.runIf?.length ? " (if findings)" : ""}`).join(" → ")}
              </div>
            </span>
            <span className="row" style={{ alignItems: "flex-start" }}>
              <button className="small" onClick={() => setDraft({ tpl: structuredClone(t), baseRev: t.rev })}>
                Edit
              </button>
              <button className="small" onClick={() => setDraft({ tpl: { ...structuredClone(t), id: `custom-${Date.now().toString(36)}`, name: `${t.name} copy`, builtIn: false, rev: 0 }, baseRev: null })}>
                Duplicate
              </button>
              {isModifiedBuiltIn(t) && (
                <button
                  className="small"
                  onClick={() => {
                    const b = BUILT_IN_TEMPLATES.find((x) => x.id === t.id)!;
                    if (confirm(`Reset "${t.name}" to the built-in version?`)) apply((s, now) => M.saveTemplate(s, structuredClone(b), t.rev, now));
                  }}
                >
                  Reset
                </button>
              )}
              <button
                className="small danger"
                onClick={() => {
                  if (confirm(`Delete the "${t.name}" template? Task pipelines already created from it are unchanged.`)) apply((s, now) => M.deleteTemplate(s, t.id, now));
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {missingBuiltIns.length > 0 && (
        <button className="small" style={{ marginTop: "0.5rem" }} onClick={() => apply((s, now) => missingBuiltIns.reduce((acc, b) => M.saveTemplate(acc, structuredClone(b), null, now), s))}>
          Restore {missingBuiltIns.length} deleted built-in template(s)
        </button>
      )}
    </section>
  );
}
