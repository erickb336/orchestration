// Details › Outputs: every step output, versioned, newest first, with its check results and findings, and
// the editor. A finding that needs you is decided under Needs you; here it is linked there.

import { useState } from "react";
import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import type { State, Task } from "../../domain/types";
import { relTime } from "../common";
import { CheckResults, CoverageChip, FindingsList } from "../Findings";
import { earlierFlowLabel } from "../flowView";
import { Actions, Button, Chip, Field, Input, Textarea } from "../kit";
import { useStore } from "../store";
import { BreakdownChildren } from "./Children";
import { isOpenTask } from "./needsYouItems";
import { stepName } from "./stepWords";

export function OutputsSection({ state, task, decideAbove }: { state: State; task: Task; decideAbove: () => void }) {
  const { service, disabled } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const arts = state.artifacts.filter((a) => a.taskId === task.id);
  const open = isOpenTask(task);
  const consumers = (id: string) => state.attempts.filter((a) => a.taskId === task.id && a.snapshot.inputs.some((i) => i.artifactId === id)).map((a) => a.id);
  const nameOf = (id: string) => {
    const st = task.steps.find((s) => s.id === id);
    return st ? stepName(st) : id;
  };
  return (
    <div className="k-stack k-stack--tight">
      <p className="small muted">
        Step outputs, versioned. Each version is kept as it was; editing one saves a new version that later steps use.{" "}
        {service.runtime === "real" ? "Code changes are commits on orchestration/* branches; nothing is merged for you." : "Contents are simulated."}
      </p>
      {!arts.length && <p className="muted">None yet.</p>}
      <ul className="t-list">
        {[...arts].reverse().map((a) => {
          const latest = M.latestArtifact(state, task, a.stepId, a.name);
          const used = consumers(a.id);
          const edited = a.author === "user";
          // Work from before the task's flow changed is the record; it is never edited or consumed again.
          const earlier = M.fromEarlierFlow(state, task, a);
          return (
            <li key={a.id}>
              <div className="t-list__head">
                <strong>
                  {nameOf(a.stepId)}: {a.name}
                </strong>
                <span className="mono muted small">
                  {a.stepId}.{a.name} v{a.version}
                </span>
                <Chip>{a.kind}</Chip>
                {edited && <Chip strong>edited by you</Chip>}
                {earlier && <Chip title="Made before the task's flow changed; kept for the record, not used by the new steps and not editable">{earlierFlowLabel(task, M.artifactPipelineRev(state, a))}</Chip>}
                {a.openFindings !== undefined && (
                  <Chip tone={(a.findings ? F.unresolved(state, a) : a.openFindings) ? "you" : "done"} title={a.findings ? "Unresolved: auto-fix findings, and ask-user findings not yet accepted or followed up" : undefined}>
                    {a.findings ? F.unresolved(state, a) : a.openFindings} open
                  </Chip>
                )}
                {a.pathCoverage && <CoverageChip coverage={a.pathCoverage} />}
              </div>
              <div className="t-list__body">
                <p className="t-needs__text">{a.summary}</p>
                {a.kind === "breakdown" && <BreakdownChildren state={state} task={task} artifact={a} />}
                {a.ref && <div className="mono small muted">{a.ref}</div>}
                {a.checkRun && <CheckResults run={a.checkRun} attemptId={a.attemptId} />}
                {a.findings && <FindingsList state={state} artifact={a} controls={latest?.id === a.id} decideAbove={decideAbove} />}
                {edited && a.editReason && <p className="small">Why you changed it: “{a.editReason}”</p>}
              </div>
              <div className="t-list__foot">
                {edited ? `edited ${relTime(a.createdAt)}` : `from ${a.attemptId}`}
                {used.length ? ` · read by ${used.join(", ")}` : " · not read by any run yet"}
                {latest && latest.version > a.version ? ` · superseded by v${latest.version}` : ""}
              </div>
              {open && !earlier && editingId !== a.id && (
                <Actions>
                  <Button size="small" variant="quiet" aria-label={`Edit ${a.stepId}.${a.name} v${a.version}`} disabled={disabled} onClick={() => setEditingId(a.id)}>
                    Edit
                  </Button>
                </Actions>
              )}
              {open && !earlier && editingId === a.id && <ArtifactEditor state={state} task={task} artifactId={a.id} onClose={() => setEditingId(null)} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Edit or replace one output; saving creates the next version and re-submits every step downstream. */
function ArtifactEditor({ state, task, artifactId, onClose }: { state: State; task: Task; artifactId: string; onClose: () => void }) {
  const { send, disabled } = useStore();
  const found = state.artifacts.find((x) => x.id === artifactId);
  const [summary, setSummary] = useState(found?.summary ?? "");
  const [findings, setFindings] = useState(String(found?.openFindings ?? 0));
  const [ref, setRef] = useState("");
  const [items, setItems] = useState(JSON.stringify(found?.items ?? [], null, 2));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  if (!found) return null;
  const base = found;
  const latest = M.latestArtifact(state, task, base.stepId, base.name) ?? base;
  // Structured findings are decided one by one; only the summary of such an artifact can be edited.
  const isFindings = base.kind === "review-findings" && !base.findings;
  const isStructured = base.kind === "review-findings" && !!base.findings;
  const isCode = base.kind === "code-change";
  const findingsOk = !isFindings || (/^\d+$/.test(findings.trim()) && Number(findings) >= 0);
  const isBreakdown = base.kind === "breakdown";
  let parsedItems: unknown[] | null = null;
  if (isBreakdown) {
    try {
      const v: unknown = JSON.parse(items);
      parsedItems = Array.isArray(v) ? v : null;
    } catch {
      parsedItems = null;
    }
  }
  const refOk = !isCode || !ref.trim() || /^[0-9a-f]{7,40}$/i.test(ref.trim());
  const canSave = !disabled && !saving && summary.trim() !== "" && reason.trim() !== "" && findingsOk && refOk && (!isBreakdown || parsedItems !== null);
  const readers = task.steps.filter((d) => d.inputs.some((r) => r.step === base.stepId && r.output === base.name)).map((d) => d.id);
  return (
    <form
      className="t-editor"
      aria-label={`Edit ${base.stepId}.${base.name}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSave) return;
        setSaving(true);
        const args: Record<string, unknown> = { artifactId, summary, reason };
        if (isFindings) args.openFindings = Number(findings);
        if (isCode && ref.trim()) args.ref = ref.trim();
        if (isBreakdown && parsedItems) args.items = parsedItems;
        const r = await send("editArtifact", args);
        setSaving(false);
        if (r.ok) onClose();
      }}
    >
      <p className="small muted">
        Saving creates v{latest.version + 1}; every later step that used this output re-runs on your version.
        {readers.length ? ` Read directly by ${readers.join(", ")}.` : ""}
        {latest.version > base.version ? ` You are starting from v${base.version}; the newest is v${latest.version}.` : ""}
      </p>
      <Field label={base.kind === "code-change" ? "Description of the change" : "Content"}>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} required rows={6} />
      </Field>
      {isFindings && (
        <Field label="Open findings" width="short" hint="Steps that run only when there are open findings use this number. Set 0 to let them skip.">
          <Input type="number" min={0} step={1} value={findings} onChange={(e) => setFindings(e.target.value)} required />
        </Field>
      )}
      {isStructured && <p className="small muted">The findings are listed one by one and carry over unchanged: decide each finding instead of editing a count.</p>}
      {isCode && (
        <Field
          label="Use this commit instead (optional)"
          width="medium"
          error={!refOk ? "Use a commit hash (7–40 hex characters)." : undefined}
          hint={
            <>
              Point it at your own commit to replace the agent's change. Leave empty to keep {base.ref ? <span className="mono">{base.ref}</span> : "the current reference"}.
            </>
          }
        >
          <Input type="text" className="mono" value={ref} placeholder={base.ref ?? "commit hash"} onChange={(e) => setRef(e.target.value)} />
        </Field>
      )}
      {isBreakdown && (
        <Field
          label="Work items (each becomes a child task)"
          error={parsedItems === null ? "Not a valid JSON list." : undefined}
          hint={
            <>
              A JSON list of {`{ "title", "outcome", "approach", "acceptance": [...], "flowId", "priority", "dependsOn": [index] }`}.{task.pendingBreakdowns?.length ? " Child tasks are created from this list when you resume." : ""}
            </>
          }
        >
          <Textarea className="mono" value={items} onChange={(e) => setItems(e.target.value)} />
        </Field>
      )}
      <Field label="Why (required; the next steps see this)">
        <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      <Actions>
        <Button type="submit" size="small" variant="primary" disabled={!canSave} loading={saving}>
          {saving ? "Saving…" : `Save as v${latest.version + 1}`}
        </Button>
        <Button size="small" variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}
