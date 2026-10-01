import * as M from "../domain/model";
import { PROVIDERS } from "../domain/types";
import { useStore } from "./store";
import { PREF_INVOLVEMENT_CHOSEN, PREF_ONBOARDING_DISMISSED, PREF_STAGE_CHOSEN, usePref } from "./common";
import { stageStepDone, startNowBlocker } from "./stageChoice";

function scrollToHeading(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * ORC-012: the first choice: shape the vision with the lead first, or start building now (the usual
 * behaviour). Review 6: an empty project of your own starts by shaping, so "Start building now" is a
 * real Start building. ORC-014 review 10: the step is done once you chose: "Shape" counts as chosen while
 * already shaping, and "Start building now" asks for a vision first, with the way there.
 */
function StageChoice({ onChosen }: { onChosen: () => void }) {
  const { state, send, disabled } = useStore();
  const shaping = state.project.stage === "shaping";
  const why = startNowBlocker(state);
  const visionHeading = shaping ? "shape-h" : "vision-h";
  return (
    <span className="row" style={{ gap: "0.4rem" }}>
      <button
        className="small"
        disabled={disabled}
        onClick={async () => {
          if (shaping) return onChosen();
          const r = await send("startShaping");
          if (r.ok) onChosen();
        }}
      >
        {shaping ? "Keep shaping the vision with the lead" : "Shape the vision with the lead first"}
      </button>
      <button
        className="small"
        disabled={disabled}
        title={why}
        onClick={async () => {
          if (why) return scrollToHeading(visionHeading);
          if (shaping) {
            const r = await send("startBuilding");
            if (!r.ok) return;
          }
          onChosen();
        }}
      >
        Start building now
      </button>
      {why && (
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          {why}{" "}
          <button type="button" className="link" style={{ fontSize: "0.82rem" }} onClick={() => scrollToHeading(visionHeading)}>
            Go to vision
          </button>
        </span>
      )}
    </span>
  );
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
  const [stageChosen, setStageChosen] = usePref(PREF_STAGE_CHOSEN);
  if (dismissed === "1") return null;

  const hide = (
    <button className="small" onClick={() => setDismissed("1")}>
      Hide
    </button>
  );
  const shaping = state.project.stage === "shaping";

  if (service.runtime !== "real") {
    // ORC-017 §3.5: the demo bar and the tour explain the sample project; what stays here is the way to your own repository and the shaping choice.
    return (
      <p className="try-shaping" aria-label="About the sample project">
        <span>
          Your own repository: start the service with <code>ORCHESTRATION_RUNTIME=real npm start</code>.
        </span>
        {!shaping && stageChosen !== "1" && (
          <>
            <span>Or try shaping the vision with the (simulated) lead first:</span> <StageChoice onChosen={() => setStageChosen("1")} />
          </>
        )}
        {hide}
      </p>
    );
  }

  const vision = M.currentVision(state);
  const health = (p: (typeof PROVIDERS)[number]) => service.providers[p]?.health?.status;
  const anyProvider = PROVIDERS.some((p) => health(p) === "ready");
  const steps: Step[] = [
    {
      id: "stage",
      label: "Choose how to begin: shape the vision with the lead first, or start building now",
      done: stageStepDone(state, stageChosen),
      detail: shaping ? "Shaping: the lead answers you and drafts the vision; nothing runs until you start building." : undefined,
      action: <StageChoice onChosen={() => setStageChosen("1")} />,
    },
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
      label: shaping ? "Shape the vision with the lead, then accept a draft" : "Write your vision",
      done: vision.text.trim().length > 0,
      action: (
        <button className="link" onClick={() => scrollToHeading(shaping ? "shape-h" : "vision-h")}>
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
          <button className="link" onClick={() => scrollToHeading("lead-inline")}>
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
    // ORC-013: once a repository is set, the service can run its checks on every change.
    ...(service.repo?.ok
      ? [
          {
            id: "checks",
            label: "Turn on checks (recommended): the service runs your repository's tests and build on every change, in a sandbox",
            done: !!state.project.checks?.enabled,
            action: <a href="#/settings">Settings → Checks</a>,
          } satisfies Step,
        ]
      : []),
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
