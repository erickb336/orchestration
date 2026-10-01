// ORC-013: structured review findings and the decisions on them. Read-only views over domain state
// plus the explicit decision controls (Fix, Accept as is, Follow up, Reopen, Send to the lead / me).
// Nothing here decides anything by itself: every change is a named command the service applies.
// ORC-025 pass 3 (P2): a decision that needs you is taken at the top of the task page; the output's list
// shows the same finding with a link there instead of a second set of buttons.

import { useState } from "react";
import { checkLogUrl } from "../api";
import { coverageLabel } from "../domain/coverage";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { Artifact, CheckRunRecord, Finding, FindingDecision, PathCoverage, State } from "../domain/types";
import { relTime } from "./common";
import { Button, Chip, Input, SimulatedChip, useConfirm, type Tone } from "./kit";
import { useStore } from "./store";
import { CONFIRM } from "./task/confirms";

const ACTION_LABEL: Record<Finding["action"], string> = { "auto-fix": "auto-fix", "ask-user": "a person decides", "no-op": "information" };
const SEVERITY_TONE: Record<Finding["severity"], Tone> = { error: "fail", warning: "you", info: "neutral" };

/** "error", "warning", "info" as a chip, and what the finding asks for. */
export function FindingChips({ finding }: { finding: Finding }) {
  return (
    <>
      <Chip tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Chip>
      <Chip tone={finding.action === "ask-user" ? "you" : "neutral"} strong={finding.action === "auto-fix"} title={finding.defaulted ? "The reviewer left the action or severity out, so the service chose this default" : undefined}>
        {ACTION_LABEL[finding.action]}
        {finding.defaulted ? " (defaulted)" : ""}
      </Chip>
    </>
  );
}

/** Where a decision stands, in one line. */
export function decisionState(d: FindingDecision): string {
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
  const confirm = useConfirm();
  const [note, setNote] = useState("");
  const decide = (decision: "fix" | "accept" | "follow-up" | "reopen") => void send("decideFinding", { decisionId: d.id, decision, ...(note.trim() ? { note: note.trim() } : {}) });
  const open = d.status === "open";
  // Review 1 (10): nothing on a cancelled or finished task can be decided any more.
  const lifecycle = state.tasks.find((t) => t.id === d.taskId)?.lifecycle;
  const off = disabled || lifecycle === "cancelled" || lifecycle === "done";
  if (d.status === "superseded") return <span className="muted small">No longer open{d.why ? `: ${d.why}` : ""}.</span>;
  // ORC-013 §6.7: failing final checks take a repair round (at most two), or the user's acceptance; never a follow-up.
  const final = d.kind === "final-checks";
  const rounds = state.tasks.find((t) => t.id === d.taskId)?.checkRounds ?? 0;
  return (
    <div className="t-decision__controls">
      {open ? (
        <>
          <Button size="small" variant="primary" disabled={off || (final && rounds >= 2)} onClick={() => decide("fix")} title={final ? `A coder fixes the failing checks, a reviewer reads the fix, and the checks run again (round ${Math.min(rounds + 1, 2)} of 2)` : "The next repair fixes it"}>
            {final ? `Add a fix round (${Math.min(rounds + 1, 2)} of 2)` : "Fix"}
          </Button>
          <Button
            size="small"
            disabled={off}
            onClick={async () => {
              if (final && !(await confirm(CONFIRM.acceptFailingChecks()))) return;
              decide("accept");
            }}
            title={final ? "Only you can accept failing checks; the landed item is flagged" : "Leave it as it is; later repairs and reviews treat it as settled"}
          >
            {final ? "Accept failing checks" : "Accept as is"}
          </Button>
          {!final && (
            <Button size="small" disabled={off} onClick={() => decide("follow-up")} title="A new task of yours, seeded from the finding; it waits for your go-ahead">
              Follow up
            </Button>
          )}
          <Button size="small" variant="quiet" disabled={off} onClick={() => void send("routeDecision", { decisionId: d.id, to: d.routedTo === "lead" ? "user" : "lead" })}>
            {d.routedTo === "lead" ? "Send to me" : "Send to the lead"}
          </Button>
        </>
      ) : (
        !final && (
          <Button size="small" variant="quiet" disabled={off} onClick={() => decide("reopen")} title={d.usedBy.length ? "A repair already used this decision; the change applies to later repairs" : "Decide again"}>
            Reopen
          </Button>
        )
      )}
      {open && <Input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label={`Note for ${d.id}`} maxLength={F.MAX_DECISION_WHY} />}
    </div>
  );
}

type FindingWords = Pick<Finding, "severity" | "title" | "detail" | "file" | "line" | "why"> & Partial<Pick<Finding, "id" | "action" | "defaulted">>;

/** One finding's words: its title, where it is, what is wrong and why a person decides. A decision's copy of a finding has no action; then only the severity is shown. */
export function FindingText({ finding: f, showId }: { finding: FindingWords; showId?: boolean }) {
  return (
    <>
      <p className="t-decision__title">{f.title}</p>
      <div className="t-decision__meta">
        {showId && f.id && <span className="mono">{f.id}</span>}
        {f.action ? <FindingChips finding={f as Finding} /> : <Chip tone={SEVERITY_TONE[f.severity]}>{f.severity}</Chip>}
        {f.file && (
          <span className="mono">
            {f.file}
            {f.line ? `:${f.line}` : ""}
          </span>
        )}
      </div>
      {f.detail && <p className="t-needs__text">{f.detail}</p>}
      {f.why && <p className="t-decision__state">Why a person decides: {f.why}</p>}
    </>
  );
}

/**
 * Every finding of a structured artifact, with its decision state and controls. With `decideAbove`, an open
 * decision that is yours points there ("Decide above") instead of carrying its buttons a second time.
 */
export function FindingsList({ state, artifact, controls = true, decideAbove }: { state: State; artifact: Artifact; controls?: boolean; decideAbove?: () => void }) {
  const open = state.tasks.find((t) => t.id === artifact.taskId)?.lifecycle;
  const editable = controls && open !== "done" && open !== "cancelled";
  if (!artifact.findings?.length) return <div className="muted small">No findings.</div>;
  return (
    <div className="t-decision__list">
      {artifact.findings.map((f) => {
        const d = F.decisionFor(state, artifact, f);
        const above = !!decideAbove && d?.status === "open" && d.routedTo === "user";
        return (
          <div key={f.id} className="t-decision">
            <FindingText finding={f} showId />
            {d && (
              <p className="t-decision__state">
                {decisionState(d)}
                {above && (
                  <>
                    {" "}
                    ·{" "}
                    <Button size="small" variant="quiet" onClick={decideAbove}>
                      Decide above
                    </Button>
                  </>
                )}
              </p>
            )}
            {d && editable && !above && (
              <>
                {d.suggestion && d.status === "open" && <ApplySuggestion decision={d} />}
                <DecisionControls decision={d} />
              </>
            )}
            {!d && F.isBlocking(f) && f.action === "ask-user" && <p className="t-decision__state">A person decides this one.</p>}
          </div>
        );
      })}
    </div>
  );
}

function ApplySuggestion({ decision }: { decision: FindingDecision }) {
  const { send, disabled } = useStore();
  return (
    <Button size="small" variant="primary" disabled={disabled} onClick={() => void send("decideFinding", { decisionId: decision.id, decision: "fix", note: decision.suggestion?.why })}>
      Apply the lead's suggestion
    </Button>
  );
}

const STATUS_MARK: Record<CheckRunRecord["results"][number]["status"], string> = { passed: "✓", failed: "✗", "timed-out": "✗", "not-run": "–" };
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** ORC-013: one row per command of a check run: status, exit code, duration, the excerpt and the full log; how it ran. */
export function CheckResults({ run, attemptId }: { run: CheckRunRecord; attemptId: string }) {
  const { service } = useStore();
  const how = [run.sandbox === "codex" ? "sandboxed" : "no sandbox", ...(run.reusedFrom ? [`same result as ${run.reusedFrom} (not run again)`] : [])];
  return (
    <div className="check-results">
      <div className="muted small t-list__head">
        <span>
          Commit <span className="mono">{run.sha.slice(0, 12)}</span> · settings r{run.configRev} · {how.join(" · ")}
        </span>
        {run.simulated && <SimulatedChip />}
        {run.sandbox === "none" && <Chip tone="fail">ran without a sandbox</Chip>}
        {run.touchedInputs.length ? <span>edits protected check inputs: {run.touchedInputs.join(", ")}</span> : null}
      </div>
      <ul className="plain">
        {run.results.map((r) => (
          <li key={r.id} className={`check-row ${r.status}`}>
            <span className="check-mark" aria-hidden="true">
              {STATUS_MARK[r.status]}
            </span>
            <span>
              <strong>{r.label}</strong> <Chip>{r.kind}</Chip> {r.status === "not-run" ? "not run" : r.status === "timed-out" ? `timed out after ${seconds(r.durationMs)}` : `${r.status}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}, ${seconds(r.durationMs)}`}
              {r.log && service.runtime === "real" && !run.simulated ? (
                <>
                  {" · "}
                  <a href={checkLogUrl(attemptId, r.id)} target="_blank" rel="noreferrer">
                    Full log
                  </a>
                </>
              ) : null}
              {r.excerpt && (
                <details className="how">
                  <summary>Output{r.truncated ? " (excerpt)" : ""}</summary>
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
  const tone: Tone = coverage.state === "complete" ? "done" : coverage.state === "incomplete" ? "fail" : "neutral";
  const title = coverage.to ? `Diff ${coverage.from?.slice(0, 12) ?? "?"}..${coverage.to.slice(0, 12)}` : undefined;
  return (
    <Chip tone={tone} title={title}>
      {coverageLabel(coverage)}
    </Chip>
  );
}

/** Decisions routed to the user, across tasks or for one task, with their controls; and what the lead is deciding. */
export function DecisionQueue({ state, taskId, showLead = true }: { state: State; taskId?: string; showLead?: boolean }) {
  const mine = F.openDecisions(state, "user").filter((d) => !taskId || d.taskId === taskId);
  const lead = F.openDecisions(state, "lead").filter((d) => !taskId || d.taskId === taskId);
  if (!mine.length && !(showLead && lead.length)) return null;
  return (
    <div className="decision-queue">
      {mine.map((d) => {
        const t = state.tasks.find((x) => x.id === d.taskId);
        return (
          <div key={d.id} className="t-decision">
            {!taskId && t && (
              <p className="t-what">
                <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title}
              </p>
            )}
            <FindingText finding={d.finding} />
            {d.suggestion && (
              <p className="t-decision__state">
                The lead suggests: fix — {d.suggestion.why} <ApplySuggestion decision={d} />
              </p>
            )}
            <DecisionControls decision={d} />
          </div>
        );
      })}
      {showLead && lead.length > 0 && (
        <p className="muted small">
          The lead is deciding {lead.length} finding{lead.length === 1 ? "" : "s"}
          {taskId ? "" : ` on ${[...new Set(lead.map((d) => d.taskId))].join(", ")}`}. You can take any of them over from the task page.
        </p>
      )}
    </div>
  );
}
