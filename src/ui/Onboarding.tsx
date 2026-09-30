import * as M from "../domain/model";
import { PROVIDERS } from "../domain/types";
import { useStore } from "./store";
import { PREF_INVOLVEMENT_CHOSEN, PREF_ONBOARDING_DISMISSED, usePref } from "./common";

function scrollToHeading(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

interface Step {
  id: string;
  label: string;
  done: boolean;
  detail?: React.ReactNode;
  action: React.ReactNode;
}

/** First-run checklist on the Overview. Shown only while something is missing, and hideable per browser. */
export function Onboarding() {
  const { state, service } = useStore();
  const [dismissed, setDismissed] = usePref(PREF_ONBOARDING_DISMISSED);
  const [involvementChosen] = usePref(PREF_INVOLVEMENT_CHOSEN);
  if (dismissed === "1") return null;

  const hide = (
    <button className="small" onClick={() => setDismissed("1")}>
      Hide
    </button>
  );

  if (service.runtime !== "real") {
    return (
      <section className="card onboarding" aria-labelledby="onboard-h">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="onboard-h" style={{ margin: 0 }}>
            This is the sample project
          </h2>
          {hide}
        </div>
        <p style={{ margin: "0.4rem 0 0" }}>
          Everything here is simulated sample data; no agents run and nothing touches your code. To work on your own repository, stop the service and start it with{" "}
          <code>ORCHESTRATION_RUNTIME=real npm start</code>. You will then be guided through connecting a repository, Claude or Codex, and your vision.
        </p>
      </section>
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
      detail: service.repo?.ok ? (
        <span className="mono">{state.project.repoPath}</span>
      ) : (
        service.repo?.reason
      ),
      action: <a href="#/settings">Open Settings</a>,
    },
    {
      id: "providers",
      label: "Make Claude or Codex ready (either is enough)",
      done: anyProvider,
      detail: (
        <span className="row" style={{ gap: "0.35rem" }}>
          {PROVIDERS.map((p) => {
            const h = health(p);
            return (
              <span key={p} className={h === "ready" ? "chip done" : "chip"}>
                {M.providerLabel(p)}: {h === "ready" ? "ready" : h === "not-configured" ? "not configured" : h === "unavailable" ? "unavailable" : "checking…"}
              </span>
            );
          })}
        </span>
      ),
      action: <a href="#/settings">Check providers</a>,
    },
    {
      id: "vision",
      label: "Write your vision",
      done: vision.text.trim().length > 0,
      action: (
        <button className="link" onClick={() => scrollToHeading("vision-h")}>
          Go to vision
        </button>
      ),
    },
    {
      id: "first",
      label: "Give the lead its first direction or create a task",
      done: state.tasks.length > 0 || state.conversation.length > 0,
      action: (
        <span className="row" style={{ gap: "0.6rem" }}>
          <button className="link" onClick={() => scrollToHeading("lead-h")}>
            Message the lead
          </button>
          <a href="#/tasks">Tasks</a>
        </span>
      ),
    },
    {
      id: "involvement",
      label: "Choose how involved you want to be (Autopilot runs end to end)",
      done: state.project.autonomy.enabled || involvementChosen === "1",
      action: <a href="#/settings">Choose</a>,
    },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;

  return (
    <section className="card onboarding" aria-labelledby="onboard-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="onboard-h" style={{ margin: 0 }}>
          Get started
        </h2>
        <span className="row" style={{ gap: "0.5rem" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
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
