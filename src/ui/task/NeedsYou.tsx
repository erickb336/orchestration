// Everything the task needs from you, once, at the top of the page, each with the buttons
// that settle it: a pull request to merge or keep, failing final checks, findings to decide, a PE objection to
// overrule (with your reason), an approach to choose, the go-ahead.

import { useState } from "react";
import * as M from "../../domain/model";
import type { State, Task } from "../../domain/types";
import { PrPanel } from "../Delivery";
import { DecisionControls, FindingText } from "../Findings";
import { Actions, Button, Card, Chip, Field, Input, Row, Rows } from "../kit";
import { useStore } from "../store";
import { OverruleForm } from "../settings/OverrulesCard";
import { OVERRULE_OTHERWISE } from "../settings/overrules";
import { needsYouCount, needsYouItems, type NeedsYouItem } from "./needsYouItems";
import { specWrittenByYou } from "./Purpose";

export const NEEDS_YOU_ID = "needs-you";

export function NeedsYouCard({ state, task, items, onCompare }: { state: State; task: Task; items: NeedsYouItem[]; onCompare: () => void }) {
  if (!items.length) return null;
  return (
    <Card id={NEEDS_YOU_ID} title="Needs you" count={needsYouCount(items)} countTone="you">
      <div className="t-needs">
        {items.map((it) => {
          switch (it.kind) {
            case "pr":
              return (
                <div key="pr" className="t-needs__item">
                  <p className="t-what">{it.ready ? "Ready to merge:" : "Decide on the pull request:"}</p>
                  <PrPanel state={state} task={task} />
                </div>
              );
            case "final-checks":
              return (
                <div key={it.stepId} className="t-needs__item">
                  <p className="t-what">Checks failed on the final change:</p>
                  <p className="t-needs__text">{it.reason}</p>
                  {it.decision ? (
                    <>
                      {it.decision.routedTo === "lead" && <p className="t-decision__state">The lead is deciding whether to add a fix round; only you can accept failing checks.</p>}
                      <DecisionControls decision={it.decision} />
                    </>
                  ) : (
                    <p className="t-decision__state">The decision is recorded on the output (Details › Outputs).</p>
                  )}
                </div>
              );
            case "decisions":
              return (
                <div key="decisions" className="t-needs__item">
                  <p className="t-what">{it.decisions.length === 1 ? "Decide a finding:" : `Decide ${it.decisions.length} findings:`}</p>
                  {it.decisions.map((d) => (
                    <div key={d.id} className="t-decision">
                      <FindingText finding={d.finding} />
                      {d.suggestion && <p className="t-decision__state">The lead suggests: fix — {d.suggestion.why}</p>}
                      <DecisionControls decision={d} />
                    </div>
                  ))}
                  <p className="t-decision__state">The repair fixes what you decide "Fix" and what the reviewer marked auto-fix.</p>
                </div>
              );
            case "pe":
              return (
                <div key="pe" className="t-needs__item">
                  <p className="t-what">{it.holds[0].kind === "objects" ? "Answer the PE's objection:" : "Decide without the PE's review:"}</p>
                  {it.holds.map((h) => (
                    <OverruleForm key={h.stepId ?? "spec"} hold={h} />
                  ))}
                  <p className="t-decision__state">{OVERRULE_OTHERWISE}</p>
                </div>
              );
            case "choose":
              return <ChooseAndStart key="choose" task={task} onCompare={onCompare} />;
            case "go-ahead":
              return (
                <div key="go-ahead" className="t-needs__item">
                  <p className="t-what">Waiting for your go-ahead:</p>
                  <p className="t-needs__text">Nothing starts on this task until you press Start.</p>
                  <StartButton task={task} />
                </div>
              );
          }
        })}
      </div>
    </Card>
  );
}

function StartButton({ task }: { task: Task }) {
  const { send, disabled } = useStore();
  return (
    <Button variant="primary" disabled={disabled} onClick={() => void send("startHeldTask", { taskId: task.id })} title="Your go-ahead: the task starts as soon as an agent is free">
      Start
    </Button>
  );
}

/** The spec's options as rows with Choose, the reason a choice against the recommendation needs, then Start. */
function ChooseAndStart({ task, onCompare }: { task: Task; onCompare: () => void }) {
  const spec = M.currentSpec(task);
  const c = spec.content;
  return (
    <div className="t-needs__item">
      <p className="t-what">Choose an approach, then start:</p>
      {c.uncertainty && <p className="t-needs__text">{c.uncertainty}</p>}
      <OptionChoice task={task} />
      <Actions>
        <StartButton task={task} />
        <Button variant="quiet" onClick={onCompare}>
          Compare the tradeoffs
        </Button>
      </Actions>
    </div>
  );
}

/** The options of a spec, one row each, with Choose on those not selected. Choosing against the recommendation asks why. */
export function OptionChoice({ task }: { task: Task }) {
  const { send, disabled } = useStore();
  const spec = M.currentSpec(task);
  const c = spec.content;
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="t-choice">
      <Rows label={`Options of ${task.id}`}>
        {c.options.map((o) => (
          <Row
            key={o.id}
            as="li"
            title={
              <>
                {o.id}: {o.name}
                {o.id === c.recommendedOptionId && (
                  <>
                    {" "}
                    <Chip>{specWrittenByYou(task) ? "your spec" : "recommended by the lead"}</Chip>
                  </>
                )}
                {o.id === c.selectedOptionId && (
                  <>
                    {" "}
                    <Chip tone="done">selected</Chip>
                  </>
                )}
              </>
            }
            meta={o.approach}
            actions={
              o.id !== c.selectedOptionId && (
                <Button size="small" disabled={disabled} onClick={() => setChoosing(o.id)}>
                  Choose {o.id}
                </Button>
              )
            }
          />
        ))}
      </Rows>
      {choosing && (
        <form
          className="t-panel"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            setSaving(true);
            const r =
              choosing === c.recommendedOptionId
                ? await send("editSpec", { taskId: task.id, expectedRev: spec.rev, content: { ...structuredClone(c), selectedOptionId: choosing }, reason: `User restored recommended option ${choosing}` })
                : await send("overrideSelection", { taskId: task.id, expectedRev: spec.rev, optionId: choosing, reason });
            setSaving(false);
            if (r.ok) {
              setChoosing(null);
              setReason("");
            }
          }}
        >
          {choosing !== c.recommendedOptionId && (
            <Field label={`Why choose ${choosing} over the lead's recommendation?`} hint="Kept in the decision record.">
              <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
            </Field>
          )}
          {task.lifecycle === "active" && <p className="muted meta">Saving creates a new revision and stops runs on the current revision first.</p>}
          <Actions>
            <Button type="submit" variant="primary" disabled={disabled || saving} loading={saving}>
              Select option {choosing}
            </Button>
            <Button variant="quiet" onClick={() => setChoosing(null)}>
              Cancel
            </Button>
          </Actions>
        </form>
      )}
    </div>
  );
}

export { needsYouItems };
