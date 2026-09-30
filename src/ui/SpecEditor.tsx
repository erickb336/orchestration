import { useState } from "react";
import * as M from "../domain/model";
import { diffLines, specToLines } from "../domain/diff";
import type { SpecContent, SpecOption, Task } from "../domain/types";
import { useStore } from "./store";

const lines = (xs: string[]) => xs.join("\n");
const unlines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** Draft editor. Saving creates a new immutable revision against the revision the draft started from. */
export function SpecEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const { state, apply } = useStore();
  const start = M.currentSpec(task);
  const [baseRev, setBaseRev] = useState(start.rev);
  const [draft, setDraft] = useState<SpecContent>(() => structuredClone(start.content));
  const [reason, setReason] = useState("");
  const current = M.currentSpec(task);
  const stale = current.rev !== baseRev;
  const base = task.specs.find((r) => r.rev === baseRev);
  const upstream = stale && base ? diffLines(specToLines(base.content), specToLines(current.content)).filter((d) => d.kind !== "same") : [];
  const activeRuns = M.activeAttempts(state, task.id).length;
  const set = <K extends keyof SpecContent>(k: K, v: SpecContent[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setOpt = (i: number, patch: Partial<SpecOption>) => setDraft((d) => ({ ...d, options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const overriding = draft.selectedOptionId !== draft.recommendedOptionId;

  const text = (k: "title" | "area" | "whyNow" | "outcome" | "benefit" | "rationale" | "uncertainty" | "validationPlan" | "rollback", label: string, multi = false) => (
    <label className="field">
      <span>{label}</span>
      {multi ? <textarea value={draft[k]} onChange={(e) => set(k, e.target.value)} /> : <input type="text" value={draft[k]} onChange={(e) => set(k, e.target.value)} />}
    </label>
  );
  const list = (k: "successCriteria" | "scopeIncluded" | "scopeExcluded" | "acceptance", label: string) => (
    <label className="field">
      <span>{label} (one per line)</span>
      <textarea value={lines(draft[k])} onChange={(e) => set(k, e.target.value.split("\n"))} />
    </label>
  );

  const closed = task.lifecycle === "done" || task.lifecycle === "cancelled";
  const content = (): SpecContent => ({
    ...draft,
    successCriteria: unlines(lines(draft.successCriteria)),
    scopeIncluded: unlines(lines(draft.scopeIncluded)),
    scopeExcluded: unlines(lines(draft.scopeExcluded)),
    acceptance: unlines(lines(draft.acceptance)),
  });
  const save = () => {
    if (apply((s, now) => M.editSpec(s, task.id, baseRev, content(), reason, "user", now))) onClose();
  };
  const saveAsFollowUp = () => {
    let newId = "";
    const ok = apply((s, now) => {
      const r = M.createFollowUp(s, task.id, now);
      newId = r.newId;
      return M.editSpec(r.state, newId, 1, { ...content(), title: `Follow-up: ${draft.title}` }, reason || "Draft started before delivery", "user", now);
    });
    if (ok) {
      onClose();
      location.hash = `#/task/${newId}`;
    }
  };

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      aria-labelledby="edit-h"
    >
      <h2 id="edit-h">
        Edit spec — draft from r{baseRev}, saves as r{current.rev + 1}
      </h2>
      {stale && (
        <div className="banner danger" role="alert">
          This spec changed to r{current.rev} while you were editing. Your draft is kept. Review the current revision, then{" "}
          <button type="button" className="small" onClick={() => setBaseRev(current.rev)}>
            Save over r{current.rev} anyway
          </button>{" "}
          or{" "}
          <button
            type="button"
            className="small"
            onClick={() => {
              setDraft(structuredClone(current.content));
              setBaseRev(current.rev);
            }}
          >
            Discard draft and load r{current.rev}
          </button>
          {upstream.length > 0 && (
            <>
              <p style={{ margin: "0.6rem 0 0.3rem" }}>
                Changed in r{current.rev} ({current.author}: {current.reason}). Saving over it reverts these to your draft:
              </p>
              <div className="diff">
                {upstream.map((d, i) => (
                  <div key={i} className={d.kind}>
                    {d.text}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {closed && (
        <div className="banner danger" role="alert">
          {task.lifecycle === "done"
            ? "This task was delivered while you were editing. The delivered spec stays read-only. "
            : "This task was cancelled while you were editing. "}
          {task.lifecycle === "done" && (
            <button type="button" className="small" onClick={saveAsFollowUp}>
              Save draft as a follow-up task
            </button>
          )}
        </div>
      )}
      {task.lifecycle === "active" && activeRuns > 0 && (
        <div className="banner">
          This task has {activeRuns} active run(s). Saving freezes integration and stops them; their results will not integrate, and completed steps will be revalidated against the new revision.
        </div>
      )}
      {task.hold && <div className="banner neutral">This task is paused. Saving keeps it paused.</div>}

      {text("title", "Title")}
      {text("area", "Area")}
      {text("outcome", "Outcome", true)}
      {text("benefit", "Intended user benefit")}
      {text("whyNow", "Why now", true)}
      {list("successCriteria", "Success criteria")}
      {list("scopeIncluded", "In scope")}
      {list("scopeExcluded", "Out of scope")}

      <h3>Options</h3>
      {draft.options.map((o, i) => (
        <fieldset key={i} className="option-edit">
          <legend>
            Option {o.id}
            {o.id === draft.recommendedOptionId ? " — lead's recommendation" : ""}
          </legend>
          <div className="grid">
            <label className="field">
              <span>Name</span>
              <input type="text" value={o.name} onChange={(e) => setOpt(i, { name: e.target.value })} />
            </label>
            <label className="field">
              <span>Effort</span>
              <input type="text" value={o.effort} onChange={(e) => setOpt(i, { effort: e.target.value })} />
            </label>
            <label className="field">
              <span>Reversibility</span>
              <input type="text" value={o.reversibility} onChange={(e) => setOpt(i, { reversibility: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Approach</span>
            <textarea value={o.approach} onChange={(e) => setOpt(i, { approach: e.target.value })} />
          </label>
          <div className="grid">
            <label className="field">
              <span>Benefit</span>
              <input type="text" value={o.benefit} onChange={(e) => setOpt(i, { benefit: e.target.value })} />
            </label>
            <label className="field">
              <span>Costs and risks</span>
              <input type="text" value={o.risks} onChange={(e) => setOpt(i, { risks: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <label className="row" style={{ gap: "0.3rem" }}>
              <input type="radio" name="selected" checked={draft.selectedOptionId === o.id} onChange={() => set("selectedOptionId", o.id)} />
              Selected
            </label>
            {o.id !== draft.recommendedOptionId && o.id !== draft.selectedOptionId && (
              <button type="button" className="small danger" onClick={() => setDraft((d) => ({ ...d, options: d.options.filter((_, j) => j !== i) }))}>
                Remove option
              </button>
            )}
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        className="small"
        onClick={() => {
          const used = new Set(draft.options.map((o) => o.id));
          const id = "ABCDEFGH".split("").find((x) => !used.has(x)) ?? String(draft.options.length + 1);
          setDraft((d) => ({ ...d, options: [...d.options, { id, name: "", approach: "", benefit: "", effort: "", risks: "", reversibility: "" }] }));
        }}
      >
        Add option
      </button>

      {overriding && (
        <label className="field" style={{ marginTop: "0.8rem" }}>
          <span>Override reason (required: you selected {draft.selectedOptionId}; the lead recommended {draft.recommendedOptionId})</span>
          <input type="text" value={draft.overrideReason} onChange={(e) => set("overrideReason", e.target.value)} required />
        </label>
      )}
      <div style={{ marginTop: "0.8rem" }} />
      {text("rationale", "Lead rationale", true)}
      {text("uncertainty", "Uncertainty and what would change the decision", true)}
      {list("acceptance", "Acceptance checks")}
      {text("validationPlan", "Validation plan", true)}
      {text("rollback", "Rollback / recovery")}
      <label className="field">
        <span>Effort</span>
        <select value={draft.effort} onChange={(e) => set("effort", e.target.value as SpecContent["effort"])}>
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
        </select>
      </label>

      <div className="sticky-actions">
        <label className="field" style={{ flex: "1 1 20rem", margin: 0 }}>
          <span>Reason for this revision (required)</span>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </label>
        <button type="submit" className="primary" disabled={stale || closed}>
          Save as r{current.rev + 1}
        </button>
        <button type="button" onClick={onClose}>
          Discard draft
        </button>
      </div>
    </form>
  );
}
