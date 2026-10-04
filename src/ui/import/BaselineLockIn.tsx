// Baseline (ORC-032, screen 4), `#/vision/baseline`: the baseline Lock in (C4). One screen says what it puts into force
// (every part of the import, as the code is today), the facts that follow your answers, the changes to design that stay
// out of it (C5), what stays open, the budgets, and the lead's draft of the vision to accept (C10). Only you lock in:
// the Lock in names the summary this screen showed, and when it changes while you read, the screen shows the new one
// and clears your agreement. Words: importView.ts.

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as M from "../../domain/model";
import { summaryDigest, type SummarySeen } from "../../domain/studio/blueprint";
import { baselineBlocker, baselineSummary, importStatus } from "../../domain/studio/import";
import { fmtUsd, importSpend } from "../../domain/spend";
import { Banner, Button, ButtonLink, Card, Checkbox, Chip, EmptyState, SimulatedChip } from "../kit";
import { useStore } from "../store";
import { ImportBudgetStop } from "./ImportPanel";
import { baselineFacts, baselineRows, changeLine, keptRules, openChanges, openQuestions, productName, summaryChanged } from "./importView";
import "./import.css";

/** The summary the screen shows, as the Lock in names it. */
function seenNow(s: Parameters<typeof baselineSummary>[0]): SummarySeen {
  const summary = baselineSummary(s);
  return { draftRev: summary.draftRev, summaryDigest: summaryDigest(summary) };
}

export function BaselineLockIn() {
  const { state, send, disabled } = useStore();
  const status = importStatus(state);
  const now = status === "review" ? seenNow(state) : undefined;
  const [seen, setSeen] = useState<SummarySeen | undefined>(now);
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof summaryChanged>>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  /** You pressed Accept the vision here: the next change of the summary is yours. */
  const own = useRef(false);
  // The summary changed: show the new one, and clear the agreement, with why (summaryChanged).
  useEffect(() => {
    if (!now || busy || done) return;
    if (!seen) return setSeen(now);
    if (now.summaryDigest === seen.summaryDigest && now.draftRev === seen.draftRev) return;
    setNote(summaryChanged({ own: own.current, agreed }));
    own.current = false;
    setSeen(now);
    setAgreed(false);
  }, [now?.summaryDigest, now?.draftRev, seen, busy, done]);

  const header = (title: string) => (
    <header>
      <p className="small muted no-margin">
        <a href="#/vision">Vision</a> › Lock in
      </p>
      <h1 className="no-margin">{title}</h1>
    </header>
  );
  if (done || status === "locked-in")
    return (
      <div className="k-stack imp-page">
        {header("Lock in 1 · the baseline")}
        <Banner
          tone="done"
          title="Locked in, as Lock in 1: the baseline."
          actions={
            <>
              <ButtonLink size="small" variant="primary" href="#/results/design">
                Open Design and reality
              </ButtonLink>
              <ButtonLink size="small" variant="quiet" href="#/vision">
                Open Vision
              </ButtonLink>
            </>
          }
        >
          What {productName(state)} does today is in force and built. The factory has nothing to build until you change the design.
        </Banner>
      </div>
    );
  if (status !== "review" || !seen)
    return (
      <div className="k-stack imp-page">
        {header("The baseline")}
        <EmptyState title={status === "reading" ? "The import is still reading." : status === "stopped" ? "The import stopped." : "There is no import to lock in."}>{status === "reading" ? "The baseline is ready to lock in once round 0 opens for your answers." : "Start an import in Settings › Project."}</EmptyState>
      </div>
    );

  const submit = async () => {
    if (!agreed || busy || seen.summaryDigest !== now?.summaryDigest) return;
    setBusy(true);
    const r = await send("lockInBaseline", { draftRev: seen.draftRev, summaryDigest: seen.summaryDigest });
    if (r.ok) setDone(true);
    setBusy(false);
  };
  const acceptVision = async (args: { draftId: string; expectedRev: number }) => {
    own.current = true;
    if (!(await send("acceptVisionDraft", args)).ok) own.current = false;
  };
  return <BaselineSummary header={header} note={note} agreed={agreed} onAgree={(v) => (setAgreed(v), setNote(undefined))} busy={busy} blocker={disabled ? "The service is offline." : baselineBlocker(state)} onLockIn={() => void submit()} onAcceptVision={(a) => void acceptVision(a)} />;
}

interface SummaryProps {
  header: (t: string) => ReactNode;
  /** Why the agreement was cleared: the summary changed. */
  note: ReturnType<typeof summaryChanged>;
  agreed: boolean;
  onAgree: (v: boolean) => void;
  busy: boolean;
  blocker: string | undefined;
  onLockIn: () => void;
  onAcceptVision: (a: { draftId: string; expectedRev: number }) => void;
}

function BaselineSummary({ header, note, agreed, onAgree, busy, blocker, onLockIn, onAcceptVision }: SummaryProps) {
  const { state } = useStore();
  const imp = state.studio.import!;
  const name = productName(state);
  const rows = baselineRows(state);
  const facts = baselineFacts(state);
  const kept = keptRules(state);
  const changes = openChanges(state);
  const open = openQuestions(state);
  const sp = importSpend(state);
  const simulated = state.studio.runs.some((r) => r.importStep && r.simulated);
  return (
    <div className="k-stack imp-page">
      {header("Lock in 1 · the baseline")}
      <p className="small muted no-margin">
        What Vision will say {name} is today, at commit {imp.commit.slice(0, 7)}. {simulated && <SimulatedChip />}
      </p>
      <ImportBudgetStop />
      <div className="imp-cols">
        <Card title={`${rows.length} parts become the baseline: in force and built`} className="imp-bcard">
          <ul className="imp-facts">
            {facts.map((f) => (
              <li key={f.bold}>
                <span>
                  <b>{f.bold}</b>
                  {f.rest}
                </span>
              </li>
            ))}
          </ul>
          <section aria-labelledby="imp-b-parts">
            <h3 id="imp-b-parts">The parts</h3>
            <ul className="imp-lockrows" aria-label="The parts">
              {rows.map((r) => (
                <li key={r.id}>
                  <Chip tone="done">Baseline</Chip>
                  <span>
                    <b>
                      {r.title} v{r.version}
                    </b>{" "}
                    <span className="muted">({r.facts})</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {kept.length > 0 && (
            <section aria-labelledby="imp-b-kept">
              <h3 id="imp-b-kept">Kept as you answered</h3>
              <p className="small muted no-margin">No test proves these yet, or two sources disagreed.</p>
              <ul className="imp-lockrows" aria-label="Kept as you answered">
                {kept.map((k) => (
                  <li key={k.rule.id}>
                    <Chip>{k.chip}</Chip>
                    <span>
                      {k.rule.text} <span className="muted">({k.was})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {changes.length > 0 && (
            <section aria-labelledby="imp-b-changes">
              <h3 id="imp-b-changes">Changes to design, not the baseline</h3>
              <p className="small muted no-margin">The baseline keeps what {name} does today. The lead's next round designs each change, and it goes through your next Lock in.</p>
              <ul className="imp-lockrows" aria-label="Changes to design">
                {changes.map((c) => (
                  <li key={JSON.stringify(c.on)}>
                    <Chip tone="you">Change</Chip>
                    <span>{changeLine(state, c)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="imp-b-open">
            <h3 id="imp-b-open">What stays open</h3>
            {open.length ? (
              <ul className="imp-lockrows" aria-label="What stays open">
                {open.map((rule) => (
                  <li key={rule.id}>
                    <Chip tone="you">Open</Chip>
                    <span>{rule.area}: not answered. It goes in as the code has it, marked "not confirmed". The question stays in Vision.</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted no-margin">Nothing. You answered every question.</p>
            )}
          </section>
          <section aria-labelledby="imp-b-budgets">
            <h3 id="imp-b-budgets">The budgets</h3>
            <ul className="imp-dots small">
              <li>
                Import: {fmtUsd(sp.usd)} spent of {fmtUsd(imp.budgetUsd)}. The estimate was {fmtUsd(imp.estimate.usd[0])}–{fmtUsd(imp.estimate.usd[1])}. The Lock in ends the import.
              </li>
              <li>Building: the import spends nothing from it.</li>
            </ul>
          </section>
        </Card>
        <div className="k-stack">
          <Card title="After the Lock in" as="h3">
            <ul className="imp-dots small">
              <li>Vision shows round 0 as Lock in 1: the baseline.</li>
              <li>Results › Design and reality shows each part. A part is "built and verified" when every rule has a passing test and, for a recorded part, its recording has no failure. Else it is "built, not verified".</li>
              <li>To change {name}, ask the lead for a round. Your first change starts the factory, through Start the factory; later changes are change orders.</li>
              <li>The baseline stays on this computer. No file in your repository changes.</li>
            </ul>
          </Card>
          <VisionDraftCard onAccept={onAcceptVision} />
        </div>
      </div>
      <Card title="Your agreement" className="imp-agree">
        {note && (
          <Banner tone={note.tone} title={note.title}>
            {note.text}
          </Banner>
        )}
        <Checkbox label={`I have reviewed the baseline. It is what ${name} does today, with my answers.`} checked={agreed} onChange={(e) => onAgree(e.target.checked)} disabled={!!blocker} />
        <div className="k-actions">
          <Button variant="primary" disabled={!agreed || !!blocker} disabledReason={blocker ?? (!agreed ? "Tick the box first: your agreement is recorded with this summary." : undefined)} showReason loading={busy} onClick={onLockIn}>
            {busy ? "Locking in…" : "Lock in the baseline"}
          </Button>
          <ButtonLink variant="quiet" href="#/vision">
            Not yet
          </ButtonLink>
        </div>
        <p className="small muted no-margin">Only you can lock in. The Lock in records who agreed, when, and what this screen showed.</p>
      </Card>
    </div>
  );
}

/** The lead's draft of the vision, "what it is today" (C10): accept it, or see the vision in force. */
function VisionDraftCard({ onAccept }: { onAccept: (a: { draftId: string; expectedRev: number }) => void }) {
  const { state, disabled } = useStore();
  const draft = M.openVisionDraft(state);
  const vision = M.currentVision(state);
  const name = productName(state);
  return (
    <Card title={`The vision: what ${name} is today`} as="h3">
      {draft ? (
        <>
          <p className="small no-margin imp-pre">{draft.text}</p>
          <p className="micro muted no-margin">The lead's draft{draft.simulated ? " (simulated)" : ""}. Start the factory needs a vision text.</p>
          <div className="k-actions">
            <Button size="small" disabled={disabled} onClick={() => onAccept({ draftId: draft.id, expectedRev: vision.rev })}>
              Accept the vision
            </Button>
            <ButtonLink size="small" variant="quiet" href="#/vision">
              Edit it in Vision
            </ButtonLink>
          </div>
        </>
      ) : vision.text.trim() ? (
        <>
          <p className="small no-margin imp-pre">{vision.text}</p>
          <p className="micro muted no-margin">In force: vision r{vision.rev}.</p>
        </>
      ) : (
        <p className="small muted no-margin">The lead drafts it with the round's message. You can also write it in Vision. Start the factory needs it; the baseline does not.</p>
      )}
    </Card>
  );
}
