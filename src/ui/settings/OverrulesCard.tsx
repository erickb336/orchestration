// Overrules (ORC-029 pass 6): the owner overrules a PE objection that holds work in the factory, with a reason (the
// command overrulePeReview, recorded). The form acts at once and is used in two places: Settings › Quality ›
// Overrules, which lists every hold, and the task page's Needs you. In Vision, the studio has its own overrule. The
// words are in overrules.ts.

import { useState } from "react";
import { Button, Field, Textarea } from "../kit";
import { useStore } from "../store";
import { OVERRULE_OTHERWISE, overruleProblem, overruleRequest, peHolds, type PeHold } from "./overrules";
import { SettingsCard } from "./parts";
import "./settings.css";

/** One hold: what the PE says, your reason, and the button. Shows the domain's refusal of the reason before it is sent. */
export function OverruleForm({ hold, showWhat = true }: { hold: PeHold; showWhat?: boolean }) {
  const { send, disabled } = useStore();
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = why ? overruleProblem(why) : undefined;
  const submit = async () => {
    if (overruleProblem(why)) return;
    setBusy(true);
    const r = overruleRequest(hold, why);
    const res = await send(r.name, r.args);
    setBusy(false);
    if (res.ok) setWhy("");
  };
  return (
    <div className="s-overrule">
      {showWhat && <p className="s-list__title">{hold.what}</p>}
      <p className="s-note">{hold.says}</p>
      <Field label="Your reason" error={problem}>
        <Textarea value={why} rows={2} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <Button variant="primary" size="small" disabled={disabled || busy || !!overruleProblem(why)} onClick={() => void submit()}>
        {hold.button}
      </Button>
    </div>
  );
}

export function OverrulesCard() {
  const { state } = useStore();
  const holds = peHolds(state);
  return (
    <SettingsCard id="overrules" title="Overrules" help={`Where a PE objection holds work in the factory, you can overrule it, with your reason. Overrule acts at once. ${OVERRULE_OTHERWISE}`}>
      {holds.length ? (
        holds.map((h) => <OverruleForm key={`${h.taskId} ${h.stepId ?? ""}`} hold={h} />)
      ) : (
        <p className="s-note">No PE objection holds work now. In Vision, overrule an objection in the studio.</p>
      )}
    </SettingsCard>
  );
}
