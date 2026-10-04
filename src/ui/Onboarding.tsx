import * as M from "../domain/model";
import { PROVIDERS } from "../domain/types";
import { useStore } from "./store";
import { PREF_INVOLVEMENT_CHOSEN, PREF_ONBOARDING_DISMISSED, usePref } from "./common";
import { Button, Chip } from "./kit";
import { useLeadContext } from "./LeadDrawer";

interface Step {
  id: string;
  label: string;
  done: boolean;
  detail?: React.ReactNode;
  action: React.ReactNode;
}

/** First-run checklist on Home. Shown only while something is missing, and hideable per browser. */
export function Onboarding() {
  const { state, service } = useStore();
  const lead = useLeadContext();
  const [dismissed, setDismissed] = usePref(PREF_ONBOARDING_DISMISSED);
  const [involvementChosen] = usePref(PREF_INVOLVEMENT_CHOSEN);
  if (dismissed === "1") return null;

  const hide = (
    <Button size="small" variant="quiet" onClick={() => setDismissed("1")}>
      Hide
    </Button>
  );
  const shaping = state.project.stage === "shaping";

  if (service.runtime !== "real") {
    // One line. The demo bar says what is simulated; this says how to use your own repository.
    return (
      <p className="try-shaping" aria-label="About the sample project">
        <span>
          This is the sample project. For your own repository, start the service with <code>ORCHESTRATION_RUNTIME=real npm start</code>.
        </span>
        {hide}
      </p>
    );
  }

  const vision = M.currentVision(state);
  const health = (p: (typeof PROVIDERS)[number]) => service.providers[p]?.health?.status;
  const anyProvider = PROVIDERS.some((p) => health(p) === "ready");
  const steps: Step[] = [
    {
      id: "repo",
      label: "Connect your repository",
      done: !!service.repo?.ok,
      detail: service.repo?.ok ? <span className="mono">{state.project.repoPath}</span> : service.repo?.reason,
      action: <a href="#/settings/project/repository">Open Settings</a>,
    },
    {
      id: "providers",
      label: "Make Claude or Codex ready (either is enough)",
      done: anyProvider,
      detail: (
        <span className="k-actions">
          {PROVIDERS.map((p) => {
            const h = health(p);
            return (
              <Chip key={p} tone={h === "ready" ? "done" : "neutral"}>
                {M.providerLabel(p)}: {h === "ready" ? "ready" : h === "not-configured" ? "not configured" : h === "unavailable" ? "unavailable" : "checking…"}
              </Chip>
            );
          })}
        </span>
      ),
      action: <a href="#/settings/agents/providers">Check providers</a>,
    },
    {
      id: "vision",
      label: shaping ? "Draft the vision with the lead, then accept it" : "Write your vision",
      done: vision.text.trim().length > 0,
      // The vision text lives in Vision (ORC-030 C1).
      action: <a href="#/vision">Open Vision</a>,
    },
    {
      id: "first",
      label: "Give the lead its first direction or create a task",
      done: state.tasks.length > 0 || state.conversation.length > 0,
      action: (
        <span className="k-actions">
          <Button size="small" variant="quiet" onClick={() => lead.openLead()}>
            Message the lead
          </Button>
          <a href="#/tasks">Tasks</a>
        </span>
      ),
    },
    {
      id: "involvement",
      label: "Choose how involved you want to be (Autopilot runs end to end)",
      done: state.project.autonomy.enabled || involvementChosen === "1",
      action: <a href="#/settings/working-style/involvement">Choose</a>,
    },
    // Once a repository is set, the service can run its checks on every change.
    ...(service.repo?.ok
      ? [
          {
            id: "checks",
            label: "Turn on checks (recommended): the service runs your repository's tests and build on every change, in a sandbox",
            done: !!state.project.checks?.enabled,
            action: <a href="#/settings/quality/checks">Settings → Checks</a>,
          } satisfies Step,
        ]
      : []),
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;

  return (
    <section className="card onboarding" aria-labelledby="onboard-h">
      <div className="row space-between">
        <h2 id="onboard-h" className="no-margin">
          Get started
        </h2>
        <span className="k-actions">
          <span className="muted small">
            {steps.length - remaining} of {steps.length} done
          </span>
          {hide}
        </span>
      </div>
      <ol className="checklist">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? "done" : undefined}>
            <span className="check" aria-hidden="true">
              {s.done ? "✓" : ""}
            </span>
            <span>
              <span className="label">
                {s.label}
                <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
              </span>
              {s.detail && <div className="muted detail">{s.detail}</div>}
            </span>
            {!s.done && <span className="action">{s.action}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
