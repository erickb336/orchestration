// ORC-025 pass 3 (P1, P7): a done task's result, once: what landed with the review verdict, Mark as seen and
// Send back; the pull request while it is on its way (when it needs you it sits under Needs you instead);
// or, for a task with nothing to merge, what its last step produced.

import * as M from "../../domain/model";
import type { Artifact, State, Task } from "../../domain/types";
import { LandedChips, LandedSection, PrPanel } from "../Delivery";
import { relTime } from "../common";
import { Card } from "../kit";

/** The accepted outputs of the task's last finished step: the brief, the report, the verification. */
export function finalOutputs(state: State, task: Task): Artifact[] {
  const last = [...task.steps].reverse().find((st) => st.state === "done");
  if (!last) return [];
  return last.outputs.map((o) => M.acceptedOutput(state, task, last.id, o.name)).filter((a): a is Artifact => !!a);
}

const KIND_WORD: Record<Artifact["kind"], string> = {
  brief: "The brief",
  design: "The design",
  plan: "The plan",
  "code-change": "The change",
  "review-findings": "The review",
  verification: "Verified",
  report: "The report",
  handoff: "Handoff",
  breakdown: "The breakdown",
  "check-results": "Checks",
};

export function ResultCard({ state, task, prAtTop }: { state: State; task: Task; prAtTop: boolean }) {
  if (task.lifecycle !== "done") return null;
  const integ = task.integration;
  const landed = integ?.landed;
  const pr = integ?.pr;
  const outputs = finalOutputs(state, task)
    .filter((a) => a.kind !== "code-change" && a.kind !== "check-results")
    .map((a) => (
      <p key={a.id} className="t-needs__text">
        <strong>{KIND_WORD[a.kind]}:</strong> {a.summary}
      </p>
    ));
  return (
    <Card title="Result" actions={landed && <LandedChips landed={landed} />}>
      <div className="k-stack k-stack--tight">
        {landed && (
          <LandedSection state={state} task={task}>
            {outputs}
          </LandedSection>
        )}
        {pr && !landed && !prAtTop && <PrPanel state={state} task={task} />}
        {pr && !landed && prAtTop && <p className="meta muted">The pull request waits for you under Needs you, above.</p>}
        {!pr && !landed && integ?.status === "pending" && <p className="meta">{integ.message ? `Integration is waiting: ${integ.message}. It retries by itself.` : "Waiting for integration."}</p>}
        {!pr && !landed && integ?.status === "integrated" && (
          <p className="meta">
            On the integration branch{integ.ref ? ": " : "."}
            {integ.ref && <span className="mono">{integ.ref}</span>}
            {integ.at && <span className="muted"> · {relTime(integ.at)}</span>}
            {integ.delivered?.status === "delivered" && <span> · Landed on your branch: {integ.delivered.message}</span>}
          </p>
        )}
        {!pr && !landed && integ?.status === "not-needed" && <p className="meta muted">{task.legacySpecUnavailable ? "Imported as done; its original spec and changes are not recorded here." : "Nothing to merge: no code changed."}</p>}
        {!landed && outputs}
        <p className="small muted">The spec is read-only now; Create follow-up starts a new task from it.</p>
      </div>
    </Card>
  );
}
