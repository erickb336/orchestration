// ORC-013: structured review findings and the decisions on them. Read-only views over domain state
// plus the explicit decision controls (Fix, Accept as is, Follow up, Reopen, Send to the lead / me).
// Nothing here decides anything by itself: every change is a named command the service applies.

import { useState } from "react";
import { checkLogUrl } from "../api";
import { coverageLabel } from "../domain/coverage";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { Artifact, CheckRunRecord, Finding, FindingDecision, PathCoverage, State } from "../domain/types";
import { relTime } from "./common";
import { useStore } from "./store";

const ACTION_LABEL: Record<Finding["action"], string> = { "auto-fix": "auto-fix", "ask-user": "a person decides", "no-op": "information" };

/** "error", "warning", "info" as a chip, and what the finding asks for. */
export function FindingChips({ finding }: { finding: Finding }) {
  return (
    <>
      <span className={`chip severity-${finding.severity}`}>{finding.severity}</span>{" "}
      <span className={`chip action-${finding.action}`} title={finding.defaulted ? "The reviewer left the action or severity out, so the service chose this default" : undefined}>
        {ACTION_LABEL[finding.action]}
        {finding.defaulted ? " (defaulted)" : ""}
      </span>
    </>
  );
}

/** Where a decision stands, in one line. */
function decisionState(d: FindingDecision): string {
  if (d.suggestion && d.status === "open") return `The lead suggests: fix — ${d.suggestion.why}`;
  if (d.status === "open") return d.routedTo === "lead" ? "The lead decides" : "Needs you: decide";
  const by = d.decidedBy === "carried" ? `same as ${d.carriedFrom ?? "an earlier round"}` : d.decidedBy === "lead" ? "by the lead" : "by you";
  if (d.status === "superseded") return `No longer open${d.why ? `: ${d.why}` : ""}`;
  const what = d.status === "fix" ? (d.kind === "final-checks" ? "Fix round added" : "Fix") : d.status === "accept" ? (d.kind === "final-checks" ? "Failing checks accepted" : "Accepted as is") : `Followed up as ${d.followUpTaskId ?? "a separate task"}`;
  return `${what} (${by}${d.decidedAt ? `, ${relTime(d.decidedAt)}` : ""})${d.why ? `: ${d.why}` : ""}`;
}

/** The decision controls for one finding. Every button is one command; a note is optional. */
export function DecisionControls({ decision: d }: { decision: FindingDecision }) {
  const { state, send, disabled } = useStore();
  const [note, setNote] = useState("");
  const decide = (decision: "fix" | "accept" | "follow-up" | "reopen") => void send("decideFinding", { decisionId: d.id, decision, ...(note.trim() ? { note: note.trim() } : {}) });
  const open = d.status === "open";
  // Review 1 (10): nothing on a cancelled or finished task can be decided any more.
  const lifecycle = state.tasks.find((t) => t.id === d.taskId)?.lifecycle;
  const off = disabled || lifecycle === "cancelled" || lifecycle === "done";
  if (d.status === "superseded") return <span className="muted">No longer open{d.why ? `: ${d.why}` : ""}.</span>;
  // ORC-013 §6.7: failing final checks take a repair round (at most two), or the user's acceptance; never a follow-up.
  const final = d.kind === "final-checks";
  const rounds = state.tasks.find((t) => t.id === d.taskId)?.checkRounds ?? 0;
  return (
    <div className="decision-controls row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
      {open ? (
        <>
          <button className="small primary" disabled={off || (final && rounds >= 2)} onClick={() => decide("fix")} title={final ? `A coder fixes the failing checks, a reviewer reads the fix, and the checks run again (round ${Math.min(rounds + 1, 2)} of 2)` : "The next repair fixes it"}>
            {final ? `Add a fix round (${Math.min(rounds + 1, 2)} of 2)` : "Fix"}
          </button>
          <button className="small" disabled={off} onClick={() => (final ? confirm("Accept the failing checks and let the task finish? The landed work is flagged as accepted with failing checks. Only you can do this.") && decide("accept") : decide("accept"))} title={final ? "Only you can accept failing checks; the landed item is flagged" : "Leave it as it is; later repairs and reviews treat it as settled"}>
            {final ? "Accept failing checks" : "Accept as is"}
          </button>
          {!final && (
            <button className="small" disabled={off} onClick={() => decide("follow-up")} title="A new task of yours, seeded from the finding; it waits for your go-ahead">
              Follow up
            </button>
          )}
          <button className="small" disabled={off} onClick={() => void send("routeDecision", { decisionId: d.id, to: d.routedTo === "lead" ? "user" : "lead" })}>
            {d.routedTo === "lead" ? "Send to me" : "Send to the lead"}
          </button>
        </>
      ) : (
        !final && (
          <button className="small" disabled={off} onClick={() => decide("reopen")} title={d.usedBy.length ? "A repair already used this decision; the change applies to later repairs" : "Decide again"}>
            Reopen
          </button>
        )
      )}
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label={`Note for ${d.id}`} maxLength={F.MAX_DECISION_WHY} style={{ width: "14rem" }} />
    </div>
  );
}

/** Every finding of a structured artifact, with its decision state and controls. */
export function FindingsList({ state, artifact, controls = true }: { state: State; artifact: Artifact; controls?: boolean }) {
  const open = state.tasks.find((t) => t.id === artifact.taskId)?.lifecycle;
  const editable = controls && open !== "done" && open !== "cancelled";
  if (!artifact.findings?.length) return <div className="muted" style={{ fontSize: "0.82rem" }}>No findings.</div>;
  return (
    <ul className="plain findings" style={{ marginTop: "0.3rem" }}>
      {artifact.findings.map((f) => {
        const d = F.decisionFor(state, artifact, f);
        return (
          <li key={f.id} className="finding" style={{ padding: "0.25rem 0" }}>
            <div>
              <span className="mono">{f.id}</span> <FindingChips finding={f} />{" "}
              {f.file && (
                <span className="mono" style={{ fontSize: "0.8rem" }}>
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </span>
              )}{" "}
              <strong style={{ fontWeight: 560 }}>{f.title}</strong>
            </div>
            {f.detail && <div style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>{f.detail}</div>}
            {f.why && (
              <div className="muted" style={{ fontSize: "0.82rem" }}>
                Why a person decides: {f.why}
              </div>
            )}
            {d && (
              <div className={`decision${d.status === "open" ? " open" : ""}`} style={{ fontSize: "0.85rem", marginTop: "0.15rem" }}>
                <span className="mono">{d.id}</span> {decisionState(d)}
                {d.suggestion && d.status === "open" && editable && (
                  <>
                    {" "}
                    <ApplySuggestion decision={d} />
                  </>
                )}
                {editable && <DecisionControls decision={d} />}
              </div>
            )}
            {!d && F.isBlocking(f) && f.action === "ask-user" && <div className="muted" style={{ fontSize: "0.82rem" }}>A person decides this one.</div>}
          </li>
        );
      })}
    </ul>
  );
}

function ApplySuggestion({ decision }: { decision: FindingDecision }) {
  const { send, disabled } = useStore();
  return (
    <button className="small primary" disabled={disabled} onClick={() => void send("decideFinding", { decisionId: decision.id, decision: "fix", note: decision.suggestion?.why })}>
      Apply
    </button>
  );
}

const STATUS_MARK: Record<CheckRunRecord["results"][number]["status"], string> = { passed: "✓", failed: "✗", "timed-out": "✗", "not-run": "–" };
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** ORC-013: one row per command of a check run: status, exit code, duration, the excerpt and the full log; how it ran. */
export function CheckResults({ run, attemptId }: { run: CheckRunRecord; attemptId: string }) {
  const { service } = useStore();
  const how = [run.sandbox === "codex" ? "sandboxed" : "no sandbox", ...(run.simulated ? ["simulated"] : []), ...(run.reusedFrom ? [`same result as ${run.reusedFrom} (not run again)`] : [])];
  return (
    <div className="check-results" style={{ marginTop: "0.3rem" }}>
      <div className="muted" style={{ fontSize: "0.8rem" }}>
        Commit <span className="mono">{run.sha.slice(0, 12)}</span> · settings r{run.configRev} · {how.join(" · ")}
        {run.sandbox === "none" ? <span className="chip danger" style={{ marginLeft: "0.3rem" }}>ran without a sandbox</span> : null}
        {run.touchedInputs.length ? ` · edits protected check inputs: ${run.touchedInputs.join(", ")}` : ""}
      </div>
      <ul className="plain">
        {run.results.map((r) => (
          <li key={r.id} className={`check-row ${r.status}`}>
            <span className="check-mark" aria-hidden="true">
              {STATUS_MARK[r.status]}
            </span>
            <span>
              <strong style={{ fontWeight: 560 }}>{r.label}</strong> <span className="chip">{r.kind}</span> {r.status === "not-run" ? "not run" : r.status === "timed-out" ? `timed out after ${seconds(r.durationMs)}` : `${r.status}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}, ${seconds(r.durationMs)}`}
              {r.log && service.runtime === "real" && !run.simulated ? (
                <>
                  {" · "}
                  <a href={checkLogUrl(attemptId, r.id)} target="_blank" rel="noreferrer">
                    Full log
                  </a>
                </>
              ) : null}
              {r.excerpt && (
                <details>
                  <summary className="muted" style={{ fontSize: "0.8rem" }}>
                    Output{r.truncated ? " (excerpt)" : ""}
                  </summary>
                  <pre className="check-output">{r.excerpt}</pre>
                </details>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Covered 12 of 12 changed files" or "Did not cover 2: a.ts, b.ts", as a chip. */
export function CoverageChip({ coverage }: { coverage: PathCoverage }) {
  const cls = coverage.state === "complete" ? "chip done" : coverage.state === "incomplete" ? "chip danger" : "chip";
  const title = coverage.to ? `Diff ${coverage.from?.slice(0, 12) ?? "?"}..${coverage.to.slice(0, 12)}` : undefined;
  return (
    <span className={cls} title={title}>
      {coverageLabel(coverage)}
    </span>
  );
}

/** Decisions routed to the user, across tasks or for one task, with their controls; and what the lead is deciding. */
export function DecisionQueue({ state, taskId, showLead = true }: { state: State; taskId?: string; showLead?: boolean }) {
  const mine = F.openDecisions(state, "user").filter((d) => !taskId || d.taskId === taskId);
  const lead = F.openDecisions(state, "lead").filter((d) => !taskId || d.taskId === taskId);
  if (!mine.length && !(showLead && lead.length)) return null;
  return (
    <div className="stack decision-queue">
      {mine.map((d) => {
        const t = state.tasks.find((x) => x.id === d.taskId);
        const f = d.finding;
        return (
          <div key={d.id} className="decision open" style={{ padding: "0.35rem 0", borderBottom: "1px solid var(--border)" }}>
            <div>
              <span className="mono">{d.id}</span>{" "}
              {!taskId && t && (
                <>
                  <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title}{" "}
                </>
              )}
              <span className={`chip severity-${f.severity}`}>{f.severity}</span>{" "}
              {f.file && (
                <span className="mono" style={{ fontSize: "0.8rem" }}>
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </span>
              )}{" "}
              <strong style={{ fontWeight: 560 }}>{f.title}</strong>
            </div>
            {f.detail && <div style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>{f.detail}</div>}
            {f.why && (
              <div className="muted" style={{ fontSize: "0.82rem" }}>
                Why a person decides: {f.why}
              </div>
            )}
            {d.suggestion && (
              <div style={{ fontSize: "0.85rem" }}>
                The lead suggests: fix — {d.suggestion.why} <ApplySuggestion decision={d} />
              </div>
            )}
            <DecisionControls decision={d} />
          </div>
        );
      })}
      {showLead && lead.length > 0 && (
        <div className="muted" style={{ fontSize: "0.85rem" }}>
          The lead is deciding {lead.length} finding{lead.length === 1 ? "" : "s"}
          {taskId ? "" : ` on ${[...new Set(lead.map((d) => d.taskId))].join(", ")}`}. You can take any of them over from the task page.
        </div>
      )}
    </div>
  );
}
