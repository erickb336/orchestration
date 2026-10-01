// The spec editor. Saving creates a new immutable revision against the revision the draft started from; a
// revision that lands meanwhile is shown as a conflict with what changed, never saved over silently.

import { useState } from "react";
import * as M from "../domain/model";
import { diffLines, specToLines } from "../domain/diff";
import type { SpecContent, SpecOption, Task } from "../domain/types";
import { Actions, Banner, Button, Field, Input, Select, Textarea, useConfirm } from "./kit";
import { newIdOf, useStore } from "./store";
import { CONFIRM } from "./task/confirms";

const lines = (xs: string[]) => xs.join("\n");
const unlines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

type TextKey = "title" | "area" | "whyNow" | "outcome" | "benefit" | "rationale" | "uncertainty" | "validationPlan" | "rollback";
type ListKey = "successCriteria" | "scopeIncluded" | "scopeExcluded" | "acceptance";

export function SpecEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const { state, send, disabled } = useStore();
  const confirm = useConfirm();
  const start = M.currentSpec(task);
  const [baseRev, setBaseRev] = useState(start.rev);
  const [draft, setDraft] = useState<SpecContent>(() => structuredClone(start.content));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const current = M.currentSpec(task);
  // While our own save is in flight the stream may deliver the revision it created; that is not a conflict.
  const stale = !saving && current.rev !== baseRev;
  const base = task.specs.find((r) => r.rev === baseRev);
  const upstream = stale && base ? diffLines(specToLines(base.content), specToLines(current.content)).filter((d) => d.kind !== "same") : [];
  const activeRuns = M.activeAttempts(state, task.id).length;
  const set = <K extends keyof SpecContent>(k: K, v: SpecContent[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setOpt = (i: number, patch: Partial<SpecOption>) => setDraft((d) => ({ ...d, options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const overriding = draft.selectedOptionId !== draft.recommendedOptionId;
  const dirty = base ? JSON.stringify(content()) !== JSON.stringify(base.content) : true;

  const text = (k: TextKey, label: string, multi = false) => (
    <Field key={k} label={label}>
      {multi ? <Textarea value={draft[k]} onChange={(e) => set(k, e.target.value)} /> : <Input type="text" value={draft[k]} onChange={(e) => set(k, e.target.value)} />}
    </Field>
  );
  const list = (k: ListKey, label: string) => (
    <Field key={k} label={`${label} (one per line)`}>
      <Textarea value={lines(draft[k])} onChange={(e) => set(k, e.target.value.split("\n"))} />
    </Field>
  );

  const closed = task.lifecycle === "done" || task.lifecycle === "cancelled";
  function content(): SpecContent {
    return {
      ...draft,
      successCriteria: unlines(lines(draft.successCriteria)),
      scopeIncluded: unlines(lines(draft.scopeIncluded)),
      scopeExcluded: unlines(lines(draft.scopeExcluded)),
      acceptance: unlines(lines(draft.acceptance)),
    };
  }
  // On failure (409 stale, 400 control error, offline) the draft stays open and a notice explains why.
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const r = await send("editSpec", { taskId: task.id, expectedRev: baseRev, content: content(), reason });
    setSaving(false);
    if (r.ok) onClose();
  };
  const saveAsFollowUp = async () => {
    if (saving) return;
    setSaving(true);
    const r = await send("createFollowUpWithSpec", {
      taskId: task.id,
      content: { ...content(), title: `Follow-up: ${draft.title}` },
      reason: reason || "Draft started before delivery",
    });
    setSaving(false);
    const newId = newIdOf(r);
    if (r.ok) onClose();
    if (newId) location.hash = `#/task/${encodeURIComponent(newId)}`;
  };
  const discard = async () => {
    if (!dirty || (await confirm(CONFIRM.discardDraft(baseRev)))) onClose();
  };

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-labelledby="edit-h"
    >
      <h2 id="edit-h">Edit spec</h2>
      <p className="meta muted">
        Your draft starts from r{baseRev} and saves as r{current.rev + 1}.
      </p>
      {stale && (
        <Banner
          tone="fail"
          title={`This spec changed to r${current.rev} while you were editing.`}
          actions={
            <>
              <Button size="small" onClick={() => setBaseRev(current.rev)}>
                Save over r{current.rev} anyway
              </Button>
              <Button
                size="small"
                variant="quiet"
                onClick={() => {
                  setDraft(structuredClone(current.content));
                  setBaseRev(current.rev);
                }}
              >
                Discard draft and load r{current.rev}
              </Button>
            </>
          }
        >
          Your draft is kept. Review the current revision first.
          {upstream.length > 0 && (
            <>
              <p>
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
        </Banner>
      )}
      {closed && (
        <Banner
          tone="fail"
          title={task.lifecycle === "done" ? "This task finished while you were editing." : "This task was cancelled while you were editing."}
          actions={
            task.lifecycle === "done" && (
              <Button size="small" disabled={disabled || saving} onClick={() => void saveAsFollowUp()}>
                Save draft as a follow-up task
              </Button>
            )
          }
        >
          {task.lifecycle === "done" ? "The finished spec stays read-only." : "Nothing runs on it again."}
        </Banner>
      )}
      {task.lifecycle === "active" && activeRuns > 0 && (
        <Banner tone="you">
          This task has {activeRuns} active run{activeRuns === 1 ? "" : "s"}. Saving freezes integration and stops {activeRuns === 1 ? "it" : "them"}; {activeRuns === 1 ? "its result" : "their results"} will not integrate, and completed steps will be revalidated against the new
          revision.
        </Banner>
      )}
      {task.hold && <Banner>This task is paused. Saving keeps it paused.</Banner>}

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
            <Field label="Name">
              <Input type="text" value={o.name} onChange={(e) => setOpt(i, { name: e.target.value })} />
            </Field>
            <Field label="Effort">
              <Input type="text" value={o.effort} onChange={(e) => setOpt(i, { effort: e.target.value })} />
            </Field>
            <Field label="Reversibility">
              <Input type="text" value={o.reversibility} onChange={(e) => setOpt(i, { reversibility: e.target.value })} />
            </Field>
          </div>
          <Field label="Approach">
            <Textarea value={o.approach} onChange={(e) => setOpt(i, { approach: e.target.value })} />
          </Field>
          <div className="grid">
            <Field label="Benefit">
              <Input type="text" value={o.benefit} onChange={(e) => setOpt(i, { benefit: e.target.value })} />
            </Field>
            <Field label="Costs and risks">
              <Input type="text" value={o.risks} onChange={(e) => setOpt(i, { risks: e.target.value })} />
            </Field>
          </div>
          <Actions>
            <label className="choice-radio">
              <input type="radio" name="selected" checked={draft.selectedOptionId === o.id} onChange={() => set("selectedOptionId", o.id)} />
              <span>Selected</span>
            </label>
            {o.id !== draft.recommendedOptionId && o.id !== draft.selectedOptionId && (
              <Button size="small" variant="danger" onClick={() => setDraft((d) => ({ ...d, options: d.options.filter((_, j) => j !== i) }))}>
                Remove option
              </Button>
            )}
          </Actions>
        </fieldset>
      ))}
      <Actions>
        <Button
          size="small"
          onClick={() => {
            const used = new Set(draft.options.map((o) => o.id));
            const id = "ABCDEFGH".split("").find((x) => !used.has(x)) ?? String(draft.options.length + 1);
            setDraft((d) => ({ ...d, options: [...d.options, { id, name: "", approach: "", benefit: "", effort: "", risks: "", reversibility: "" }] }));
          }}
        >
          Add option
        </Button>
      </Actions>

      {overriding && (
        <Field label={`Override reason (required: you selected ${draft.selectedOptionId}; the lead recommended ${draft.recommendedOptionId})`}>
          <Input type="text" value={draft.overrideReason} onChange={(e) => set("overrideReason", e.target.value)} required />
        </Field>
      )}
      {text("rationale", "Lead rationale", true)}
      {text("uncertainty", "Uncertainty and what would change the decision", true)}
      {list("acceptance", "Acceptance checks")}
      {text("validationPlan", "Validation plan", true)}
      {text("rollback", "Rollback / recovery")}
      <Field label="Effort" width="short">
        <Select
          value={draft.effort}
          onChange={(e) => set("effort", e.target.value as SpecContent["effort"])}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
        />
      </Field>

      <div className="sticky-actions">
        <Field label="Reason for this revision (required)" className="sticky-actions__reason">
          <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>
        <Button type="submit" variant="primary" disabled={disabled || saving || stale || closed} loading={saving}>
          Save as r{current.rev + 1}
        </Button>
        <Button variant="quiet" onClick={() => void discard()}>
          Discard draft
        </Button>
      </div>
    </form>
  );
}
