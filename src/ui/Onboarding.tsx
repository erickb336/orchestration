import * as M from "../domain/model";
import { PROVIDERS } from "../domain/types";
import { useStore } from "./store";
import { PREF_INVOLVEMENT_CHOSEN, PREF_ONBOARDING_DISMISSED, PREF_STAGE_CHOSEN, usePref } from "./common";
import { Button, Chip } from "./kit";
import { useLeadContext } from "./LeadDrawer";
import { stageStepDone, startNowBlocker } from "./stageChoice";

function scrollToHeading(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * ORC-012: the first choice: shape the vision with the lead first, or start building now (the usual
 * behaviour). Review 6: an empty project of your own starts by shaping, so "Start building now" is a
 * real Start building. ORC-014 review 10: the step is done once you chose: "Shape" counts as chosen while
 * already shaping, and "Start building now" asks for a vision first, with the way there. ORC-025 (H5):
 * "Start building now" is offered only while shaping; on a project that is already building it did nothing.
 */
function StageChoice({ onChosen }: { onChosen: () => void }) {
  const { state, send, disabled } = useStore();
  const shaping = state.project.stage === "shaping";
  const why = startNowBlocker(state);
  return (
    <span className="k-actions">
      <Button
        size="small"
        disabled={disabled}
        onClick={async () => {
          if (shaping) return onChosen();
          const r = await send("startShaping");
          if (r.ok) onChosen();
        }}
      >
        {shaping ? "Keep shaping the vision with the lead" : "Shape the vision with the lead first"}
      </Button>
      {shaping && (
        <Button
          size="small"
          disabled={disabled}
          title={why}
          onClick={async () => {
            if (why) return scrollToHeading("shape-h");
            const r = await send("startBuilding");
            if (r.ok) onChosen();
          }}
        >
          Start building now
        </Button>
      )}
      {shaping && why && (
        <span className="muted small">
          {why}{" "}
          <Button size="small" variant="quiet" onClick={() => scrollToHeading("shape-h")}>
            Go to vision
          </Button>
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

/** First-run checklist on Home. Shown only while something is missing, and hideable per browser. */
export function Onboarding() {
  const { state, service, send, disabled } = useStore();
  const lead = useLeadContext();
  const [dismissed, setDismissed] = usePref(PREF_ONBOARDING_DISMISSED);
  const [involvementChosen] = usePref(PREF_INVOLVEMENT_CHOSEN);
  const [stageChosen, setStageChosen] = usePref(PREF_STAGE_CHOSEN);
  if (dismissed === "1") return null;

  const hide = (
    <Button size="small" variant="quiet" onClick={() => setDismissed("1")}>
      Hide
    </Button>
  );
  const shaping = state.project.stage === "shaping";

  if (service.runtime !== "real") {
    // ORC-025 (H5): one line. The demo bar says what is simulated; this says how to use your own repository, and offers the shaping stage once.
    return (
      <p className="try-shaping" aria-label="About the sample project">
        <span>
          This is the sample project. For your own repository, start the service with <code>ORCHESTRATION_RUNTIME=real npm start</code>.
        </span>
        {!shaping && stageChosen !== "1" && (
          <Button
            size="small"
            variant="quiet"
            disabled={disabled}
            title="Try the shaping stage: the lead asks questions and drafts the vision; nothing new starts until you start building again"
            onClick={async () => {
              const r = await send("startShaping");
              if (r.ok) setStageChosen("1");
            }}
          >
            Shape the vision with the lead first
          </Button>
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
      label: shaping ? "Shape the vision with the lead, then accept a draft" : "Write your vision",
      done: vision.text.trim().length > 0,
      action: (
        <Button size="small" variant="quiet" onClick={() => scrollToHeading(shaping ? "shape-h" : "vision-history")}>
          Go to vision
        </Button>
      ),
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
    // ORC-013: once a repository is set, the service can run its checks on every change.
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
