// Settings › Working style: how involved you are (one card, the numbers each mode really
// sets, Fine-tune inside it), what the lead may do when you message it, who decides findings, and notifications.
// Everything here waits for Save.

import { useState } from "react";
import * as D from "../../domain/delivery";
import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import { STEERING_MODES, type Autonomy, type Project, type SteeringMode } from "../../domain/types";
import { Banner, Checkbox, Chip, Disclosure, Field, Input, Select } from "../kit";
import { PREF_INVOLVEMENT_CHOSEN, PREF_NOTIFY, fmtTime, involvementOf, relTime, usePref, type Involvement } from "../common";
import { disableNotifications, enableNotifications, notificationsSupported } from "../notifications";
import { AUTOPILOT_NUMBERS, involvementText, proposalsLine, type PlanNumbers } from "../settingsText";
import { useStore } from "../store";
import { intIn, sendInOrder, useDraft } from "./draft";
import { Choice, SettingsCard, SettingsSection } from "./parts";
import type { SectionId } from "./sections";

type Mode = Involvement;

type WorkingStyleDraft = {
  mode: Mode;
  interval: string;
  perCycle: string;
  maxOpen: string;
  retries: string;
  hoursOn: boolean;
  start: string;
  end: string;
  /** The branch Autopilot delivers to when delivery is off (it turns local delivery on). */
  branch: string;
  steering: SteeringMode;
  triage: Project["triage"]["askUserBy"];
  notify: boolean;
};

const MODE_LABEL: Record<Exclude<Mode, "custom">, string> = { autopilot: "Autopilot", checkin: "Check-in", manual: "Manual" };
const MODES = ["autopilot", "checkin", "manual"] as const;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const STEERING_CHOICES: Record<SteeringMode, { label: string; detail: string }> = {
  apply: { label: "Apply changes, each with Undo", detail: "The lead changes the focus, reorders and defers work, and drops its own unstarted proposals. Every change is listed under its reply with Undo." },
  "apply-own": { label: "Apply to its own proposals; suggest for my tasks", detail: "Tasks you created only get suggestions, with Apply and Dismiss. The lead's own proposals change right away." },
  suggest: { label: "Only suggest", detail: "Nothing changes until you press Apply on a suggestion." },
};

export function WorkingStyleSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, service, send } = useStore();
  const a = state.project.autonomy;
  const prMode = state.project.prDelivery.enabled;
  const deliveryMode = D.deliveryMode(state);
  const liveMode = involvementOf(a, prMode);
  const [notifyPref] = usePref(PREF_NOTIFY);
  const [, setChosen] = usePref(PREF_INVOLVEMENT_CHOSEN);
  const supported = notificationsSupported();
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);

  const liveNumbers = { interval: String(a.planningIntervalMinutes), perCycle: String(a.maxProposalsPerCycle), maxOpen: String(a.maxOpenProposals), retries: String(a.autoRetry) };
  const presetNumbers = { interval: String(AUTOPILOT_NUMBERS.interval), perCycle: String(AUTOPILOT_NUMBERS.perCycle), maxOpen: String(AUTOPILOT_NUMBERS.maxOpen), retries: String(AUTOPILOT_NUMBERS.retries) };
  const liveTriage = state.project.triage?.askUserBy ?? "user";
  const live: WorkingStyleDraft = {
    mode: liveMode,
    ...liveNumbers,
    hoursOn: a.operatingHours !== null,
    start: a.operatingHours?.start ?? "09:00",
    end: a.operatingHours?.end ?? "18:00",
    branch: a.autoDeliver.enabled ? a.autoDeliver.branch : (service.repo?.branch ?? a.autoDeliver.branch ?? "main"),
    steering: state.project.steeringMode,
    triage: liveTriage,
    notify: notifyPref === "1" && supported && Notification.permission === "granted",
  };
  const draft = useDraft(live);
  const v = draft.value;

  /** The numbers each mode would set: Autopilot its own (unless it is already on), the others today's. */
  const numbersFor = (m: Mode) => (m === "autopilot" && liveMode !== "autopilot" ? presetNumbers : liveNumbers);
  // Autopilot sends findings to the PE (within budget); moving to Check-in or Manual brings them back to you.
  const choose = (m: Exclude<Mode, "custom">) => draft.set({ mode: m, ...numbersFor(m), triage: m === liveMode ? liveTriage : m === "autopilot" ? "pe" : "user" });

  // What each mode's description says: the chosen one with the fields' numbers, the others with what choosing them sets.
  const hours = v.hoursOn ? { start: v.start, end: v.end } : null;
  const asNumbers = (n: typeof liveNumbers): PlanNumbers => ({ interval: Number(n.interval), perCycle: Number(n.perCycle), maxOpen: Number(n.maxOpen), retries: Number(n.retries), hours });
  const described = (m: Exclude<Mode, "custom">) => asNumbers(m === v.mode ? v : numbersFor(m));
  const needsBranch = !prMode && deliveryMode !== "local";
  const delivery = { mode: deliveryMode, branch: deliveryMode === "local" ? a.autoDeliver.branch : v.branch.trim() || "your branch", merge: state.project.prDelivery.merge };

  // Field checks, in the domain's ranges (setAutonomy refuses anything else).
  const errors = {
    interval: intIn(v.interval, 5, 1440) === undefined ? "Between 5 and 1440 minutes." : undefined,
    perCycle: intIn(v.perCycle, 1, 10) === undefined ? "Between 1 and 10." : undefined,
    maxOpen: intIn(v.maxOpen, 1, 50) === undefined ? "Between 1 and 50." : undefined,
    retries: intIn(v.retries, 0, 5) === undefined ? "Between 0 and 5." : undefined,
    hours: v.hoursOn && (!HHMM.test(v.start) || !HHMM.test(v.end)) ? "Give both times." : v.hoursOn && v.start === v.end ? "Start and end must differ." : undefined,
    branch: v.mode === "autopilot" && liveMode !== "autopilot" && needsBranch && !BRANCH.test(v.branch.trim()) ? "Name the branch to deliver to." : undefined,
  };
  const invalid = Object.values(errors).find(Boolean);

  const save = async (begin: () => void) => {
    begin();
    // Notifications first: the browser asks for permission only in answer to a click.
    if (draft.changed.has("notify")) {
      setNotifyMessage(null);
      if (!v.notify) disableNotifications();
      else {
        const r = await enableNotifications();
        if (r === "denied") setNotifyMessage("Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on again.");
        else if (r !== "granted") setNotifyMessage("Notifications were not allowed.");
      }
    }
    const planning = {
      planningIntervalMinutes: Number(v.interval),
      maxProposalsPerCycle: Number(v.perCycle),
      maxOpenProposals: Number(v.maxOpen),
      autoRetry: Number(v.retries),
      operatingHours: v.hoursOn ? { start: v.start, end: v.end } : null,
    };
    const next: Omit<Autonomy, "autoDeliver"> = {
      ...planning,
      enabled: v.mode === "manual" ? false : v.mode === "custom" ? a.enabled : true,
      holdLeadProposals: v.mode === "checkin" ? true : v.mode === "autopilot" ? false : a.holdLeadProposals,
    };
    const toAutopilot = v.mode === "autopilot" && liveMode !== "autopilot";
    const autonomyChanged = ["mode", "interval", "perCycle", "maxOpen", "retries", "hoursOn", "start", "end"].some((k) => draft.changed.has(k as keyof WorkingStyleDraft));
    // Autopilot is its own command (it also sends findings to the PE and may turn on local delivery); Fine-tune changes after it.
    const tunedAfterAutopilot =
      toAutopilot &&
      (Number(v.interval) !== AUTOPILOT_NUMBERS.interval || Number(v.perCycle) !== AUTOPILOT_NUMBERS.perCycle || Number(v.maxOpen) !== AUTOPILOT_NUMBERS.maxOpen || Number(v.retries) !== AUTOPILOT_NUMBERS.retries || JSON.stringify(planning.operatingHours) !== JSON.stringify(a.operatingHours));
    const triageAfter = toAutopilot ? "pe" : liveTriage;
    // setAutonomy keeps the delivery mode when autoDeliver is left out.
    const ok = await sendInOrder([
      () => (toAutopilot ? send("applyAutopilot", { branch: needsBranch ? v.branch.trim() : a.autoDeliver.branch }) : null),
      () => (toAutopilot ? (tunedAfterAutopilot ? send("setAutonomy", next) : null) : autonomyChanged ? send("setAutonomy", next) : null),
      () => (draft.changed.has("steering") ? send("setSteeringMode", { mode: v.steering }) : null),
      () => (v.triage !== triageAfter ? send("setTriageRouting", { askUserBy: v.triage }) : null),
    ]);
    if (ok && draft.changed.has("mode")) setChosen("1");
    return ok;
  };

  const openProposals = M.openLeadProposals(state).length;
  const deferredProposals = M.deferredLeadRoots(state).length;
  const lastPlanning = state.project.lastPlanningAt;
  const openDecisions = F.openDecisions(state).length;

  return (
    <SettingsSection id="working-style" title="Working style" help="How involved you are and what the lead may do on its own. Changes here wait for Save." current={current} draft={draft} invalid={invalid} onSave={save} onDirty={onDirty}>
      <SettingsCard id="involvement" title="How involved do you want to be?" help="You can pause, edit a spec or message the lead at any time, whichever you choose.">
        <fieldset className="s-choices">
          <legend className="sr-only">How involved you are</legend>
          {MODES.map((m) => (
            <Choice
              key={m}
              boxed
              name="involvement"
              checked={v.mode === m}
              onChange={() => choose(m)}
              label={MODE_LABEL[m]}
              aside={liveMode === m && v.mode !== m ? <Chip>Current</Chip> : undefined}
              description={involvementText(m, described(m), delivery)}
            >
              {m === "autopilot" && liveMode !== "autopilot" && needsBranch && (
                <Field label="Deliver to branch" hint="Autopilot turns on delivery to this branch of your repository; change it later in Project." error={errors.branch} width="medium">
                  <Input type="text" value={v.branch} onChange={(e) => draft.set({ branch: e.target.value })} required />
                </Field>
              )}
            </Choice>
          ))}
        </fieldset>
        {v.mode === "custom" && (
          <Banner tone="info" title="Your settings match none of these">
            The lead plans on its own, but finished work is not delivered. Choose one above, or turn on delivery in Project.
          </Banner>
        )}
        <Disclosure
          className="s-gap"
          label={
            <>
              <span className="s-disc-label">Fine-tune</span> <span className="s-disc-hint">· planning interval, tasks per plan, open proposals, working hours, retries</span>
            </>
          }
        >
          <p className="s-card-help">These apply while the lead plans on its own (Autopilot and Check-in). Choosing a mode above sets its own numbers again.</p>
          <div className="s-fields">
            <Field label="Plan every (minutes)" error={errors.interval}>
              <Input type="number" min={5} max={1440} value={v.interval} onChange={(e) => draft.set({ interval: e.target.value })} />
            </Field>
            <Field label="Tasks per plan" error={errors.perCycle}>
              <Input type="number" min={1} max={10} value={v.perCycle} onChange={(e) => draft.set({ perCycle: e.target.value })} />
            </Field>
            <Field label="Open lead proposals at most" error={errors.maxOpen}>
              <Input type="number" min={1} max={50} value={v.maxOpen} onChange={(e) => draft.set({ maxOpen: e.target.value })} />
            </Field>
            <Field label="Retries of a failed step" hint="0: a failed step always waits for you." error={errors.retries}>
              <Input type="number" min={0} max={5} value={v.retries} onChange={(e) => draft.set({ retries: e.target.value })} />
            </Field>
          </div>
          <div className="s-inline">
            <Checkbox label="Plan only between" checked={v.hoursOn} onChange={(e) => draft.set({ hoursOn: e.target.checked })} />
            <Input type="time" aria-label="Working hours start" value={v.start} disabled={!v.hoursOn} onChange={(e) => draft.set({ start: e.target.value })} />
            <span className="muted">and</span>
            <Input type="time" aria-label="Working hours end" value={v.end} disabled={!v.hoursOn} onChange={(e) => draft.set({ end: e.target.value })} />
            <span className="muted small">(this computer's time)</span>
          </div>
          {errors.hours && <p className="s-error">{errors.hours}</p>}
          <p className="s-note">
            {proposalsLine(openProposals, deferredProposals, a.maxOpenProposals)} Planning waits while the project is paused.{" "}
            {lastPlanning ? (
              <>
                Last plan: <span title={fmtTime(lastPlanning)}>{relTime(lastPlanning)}</span>.
              </>
            ) : (
              "No plan yet."
            )}
          </p>
        </Disclosure>
      </SettingsCard>

      <SettingsCard id="steering" title="When you message the lead" help="Whatever you choose, the lead never overrides what you set by hand and never edits specs, pipelines or settings.">
        <fieldset className="s-choices">
          <legend className="sr-only">What the lead may change when you message it</legend>
          {STEERING_MODES.map((m) => (
            <Choice key={m} name="steering-mode" checked={v.steering === m} onChange={() => draft.set({ steering: m })} label={STEERING_CHOICES[m].label} description={STEERING_CHOICES[m].detail} />
          ))}
        </fieldset>
        <Field
          className="s-gap"
          label="Findings that need a decision go to"
          width="medium"
          hint={`A reviewer asks for a decision when the smallest fix would widen the task. Autopilot sends them to the PE, which decides within your budgets; a call that would pass a budget comes to you. Check-in and Manual send them to you.${openDecisions === 1 ? " The one open now stays where it is." : openDecisions ? ` The ${openDecisions} open now stay where they are.` : ""}`}
        >
          <Select
            value={v.triage}
            onChange={(e) => draft.set({ triage: e.target.value as WorkingStyleDraft["triage"] })}
            options={[
              { value: "lead", label: "The lead" },
              { value: "pe", label: "The PE (for now, the lead decides for it)" },
              { value: "user", label: "Me" },
            ]}
          />
        </Field>
      </SettingsCard>

      <SettingsCard id="notifications" title="Notifications" help="Only while an Orchestrator page is open in this browser; clicking one opens the task.">
        <Checkbox
          label="Notify me in this browser when something needs me or a result lands"
          hint={supported ? undefined : "This browser does not support notifications."}
          checked={v.notify}
          disabled={!supported}
          onChange={(e) => draft.set({ notify: e.target.checked })}
        />
        {notifyMessage && <Banner tone="you">{notifyMessage}</Banner>}
      </SettingsCard>
    </SettingsSection>
  );
}
