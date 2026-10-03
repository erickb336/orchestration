// The shell: the demo bar with its Simulation menu, the header with Home · Vision · Tasks · Results · Settings, the
// two places (Vision and the Factory, each a link that says where it stands; ORC-029 pass 5), "Message the lead"
// (the one primary action) and the Project menu that pauses and resumes. The lead drawer opens from the header on every page. The kit's ConfirmProvider
// and ToastRegion are mounted once here, so every screen can confirm in page and show one toast.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as M from "../domain/model";
import { factoryPlace, visionPlace } from "../domain/places";
import { StoreContext, useServiceContext, useServiceStore, useStore } from "./store";
import { Board } from "./Board";
import { TaskDetail } from "./TaskDetail";
import { Overview } from "./Overview";
import { Activity } from "./Activity";
import { Review } from "./Review";
import { Settings } from "./Settings";
import { PREF_LEAD_SEEN, relTime, usePref } from "./common";
import { LeadDrawer, LeadDrawerContext, type LeadContext } from "./LeadDrawer";
import { messageStatusText } from "./notes";
import { useBrowserNotifications } from "./notifications";
import { agentsStopping, agentsWorking, liveIndicatorText, prsNeedingYou, unreadLeadReplies } from "./progress";
import { factoryPlaceWords, visionPlaceWords } from "./placesView";
import { parseRoute, tabOf } from "./route";
import { ShapingBanner } from "./Shaping";
import { SIM_MENU_BUTTON_ID, TourButton, useFirstRunTour } from "./Tour";
import { Gallery } from "./kit/Gallery";
import { LockInPage } from "./studio/LockIn";
import { Reality } from "./studio/Reality";
import { Studio } from "./studio/Studio";
import { waitingForYourMark } from "./studio/studioView";
import { Banner, Button, ConfirmProvider, StatePill, ToastRegion, useConfirm } from "./kit";
import { cx } from "./kit/cx";

/**
 * The tabs: the page each one opens, its label and its address. Home keeps `overview` and Results keeps `review` as
 * internal names. Activity is reached from Tasks. Vision (ORC-029 r12) is always here, in Vision and in Factory:
 * opening it is navigation only, and never stops or changes the factory.
 */
export const TABS = [
  { page: "overview", label: "Home", href: "#/overview" },
  { page: "vision", label: "Vision", href: "#/vision" },
  { page: "tasks", label: "Tasks", href: "#/tasks", tour: "tab-tasks" },
  { page: "review", label: "Results", href: "#/results", tour: "tab-results" },
  { page: "settings", label: "Settings", href: "#/settings" },
] as const;

/** The header's "Message the lead" button, where focus returns when the drawer closes. */
const LEAD_BUTTON_ID = "lead-button";

function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Re-render periodically so relative times stay truthful. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function App() {
  const store = useServiceStore();
  return (
    <ConfirmProvider>
      <StoreContext.Provider value={store}>
        <Gate />
      </StoreContext.Provider>
    </ConfirmProvider>
  );
}

/** Nothing to show until the service has answered once. */
function Gate() {
  const { state, loadFailed, retry } = useServiceContext();
  if (state) return <Shell />;
  return (
    <main>
      <section className="card connect" aria-live="polite">
        <h1>Orchestrator</h1>
        {loadFailed ? (
          <>
            <p>
              The Orchestrator service is not running. Start it with <code>npm run dev</code> (development) or <code>npm start</code>.
            </p>
            <Button variant="primary" onClick={retry}>
              Retry
            </Button>
          </>
        ) : (
          <p className="muted">Connecting to the Orchestrator service…</p>
        )}
      </section>
    </main>
  );
}

function Shell() {
  const route = useRoute();
  const { notice, setNotice, service } = useStore();
  // A task page belongs to Tasks.
  const tab = tabOf(route);
  const demo = service.runtime === "fake";
  useBrowserNotifications();
  // The first-run tour, demo only, once per browser.
  useFirstRunTour(demo, route.page === "overview");

  // The lead drawer. It stays open across routes, Home included.
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadCtx, setLeadCtx] = useState<LeadContext>({});
  const openLead = useCallback((ctx: LeadContext = {}) => {
    setLeadCtx(ctx);
    setLeadOpen(true);
  }, []);
  const closeLead = useCallback(() => {
    setLeadOpen(false);
    document.getElementById(LEAD_BUTTON_ID)?.focus();
  }, []);
  const clearContext = useCallback(() => setLeadCtx({}), []);
  const leadApi = useMemo(() => ({ open: leadOpen, context: leadCtx, openLead, closeLead, clearContext }), [leadOpen, leadCtx, openLead, closeLead, clearContext]);

  useEffect(() => {
    if (!notice || notice.kind === "stale") return;
    const id = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [notice, setNotice]);

  return (
    <LeadDrawerContext.Provider value={leadApi}>
      <SimBanner />
      <ConnectionBanner />
      <header className="top">
        <div className="brand">
          Orchestrator
          <ProjectName />
        </div>
        <nav className="tabs" aria-label="Main">
          {TABS.map((t) => (
            <a key={t.page} href={t.href} aria-current={tab === t.page ? "page" : undefined} data-tour={"tour" in t ? t.tour : undefined}>
              {t.label}
              {t.page === "review" && <ResultsBadge />}
              {t.page === "vision" && <VisionBadge />}
            </a>
          ))}
        </nav>
        <Places />
        <div className="right">
          <LeadButton open={leadOpen} onClick={() => (leadOpen ? closeLead() : openLead())} />
          <ProjectMenu />
        </div>
      </header>
      {/* There is no stage chip. While shaping, the banner says so on every page; Home shows the shaping panel, the board its own banner, and the studio is Vision itself. */}
      {route.page !== "tasks" && route.page !== "overview" && route.page !== "vision" && route.page !== "lock-in" && (
        <div className="shell-banner">
          <ShapingBanner />
        </div>
      )}
      <main className={cx(leadOpen && "with-lead", route.page === "vision" && "st-wide") || undefined}>
        {route.page === "overview" && <Overview />}
        {route.page === "tasks" && <Board />}
        {route.page === "task" && <TaskDetail key={route.id} id={route.id} />}
        {route.page === "review" && <Review />}
        {route.page === "activity" && <Activity />}
        {route.page === "settings" && <Settings />}
        {route.page === "kit" && <Gallery />}
        {route.page === "vision" && <Studio />}
        {route.page === "lock-in" && <LockInPage />}
        {route.page === "reality" && <Reality />}
      </main>
      {leadOpen && <LeadDrawer onClose={closeLead} />}
      <ToastRegion toast={notice ? { tone: notice.kind === "error" ? "fail" : "neutral", onDismiss: () => setNotice(null), children: notice.message } : null} />
    </LeadDrawerContext.Provider>
  );
}

/**
 * A small menu on a button: a native details/summary, so it is keyboard-operable as is. It closes on a click
 * outside, on Escape (focus returns to the button), and when an item calls `close`.
 */
function Menu({ label, id, className, children }: { label: string; id?: string; className?: string; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = useCallback(() => {
    if (ref.current) ref.current.open = false;
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onPointer = (e: PointerEvent) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !el.open) return;
      el.open = false;
      el.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <details ref={ref} className={cx("menu", className)}>
      <summary id={id} className="menu__btn">
        {label}
        <span className="menu__caret" aria-hidden="true" />
      </summary>
      <div className="menu__pop" role="group" aria-label={label}>
        {children(close)}
      </div>
    </details>
  );
}

/**
 * The header's main action: it opens the lead drawer. A status dot (working, stopping, waiting, blocked) and a badge
 * for unread replies only. Its title says where your newest message stands, in the conversation's words.
 */
export function LeadButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const { state, service } = useStore();
  const [seenAt] = usePref(PREF_LEAD_SEEN);
  const now = useNow();
  const run = M.activeLeadRun(state);
  const pending = M.pendingMessages(state);
  const status = pending.length ? M.messageStatus(state, pending[pending.length - 1], { blocked: service.leadBlocked, nowMs: now }) : undefined;
  const unread = unreadLeadReplies(state, seenAt);
  const dot = status?.kind === "blocked" ? "blocked" : status?.kind === "stopping-planning" || status?.kind === "restarting" || run?.outcome === "stopping" ? "paused" : run ? "running" : pending.length ? "waiting" : undefined;
  const statusText = status ? messageStatusText(state, status) : "";
  const title = status ? (pending.length > 1 ? `${pending.length} messages waiting: ${statusText}` : statusText) : run ? "The lead is working" : "Message the lead";
  const unreadText = unread ? `${unread} new repl${unread === 1 ? "y" : "ies"}` : "";
  return (
    <Button id={LEAD_BUTTON_ID} variant="primary" className="lead-btn" onClick={onClick} aria-expanded={open} aria-haspopup="dialog" title={unreadText ? `${title} · ${unreadText}` : title} data-tour="lead">
      {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
      Message the lead
      {unread > 0 && (
        <span className="badge-new" aria-label={unreadText}>
          {unread}
        </span>
      )}
      {/* What the dot means, for readers who cannot see it; nothing when the lead is simply available. */}
      {(status || run) && <span className="sr-only">{title}</span>}
    </Button>
  );
}

/** The Results badge counts the pull requests that wait for you there, and nothing else. Persistent: it does not reset when the page is visited. */
export function ResultsBadge() {
  const { state } = useStore();
  const n = prsNeedingYou(state).length;
  if (n === 0) return null;
  const text = `${n} pull request${n === 1 ? "" : "s"} waiting for you`;
  return (
    <span className="badge-new tab-badge" title={text} aria-label={text}>
      {n}
    </span>
  );
}

/** The Vision badge counts the artifacts the PE has passed to you that you have not marked yet. Persistent, like Results'. */
export function VisionBadge() {
  const { state } = useStore();
  const n = waitingForYourMark(state).length;
  if (n === 0) return null;
  const text = `${n} artifact${n === 1 ? "" : "s"} waiting for your mark`;
  return (
    <span className="badge-new tab-badge" title={text} aria-label={text}>
      {n}
    </span>
  );
}

function ProjectName() {
  const { state } = useStore();
  return <small>{state.project.name}</small>;
}

/** The demo bar is one line, and the Simulation menu holds the clock, the tour and the reset. */
export function SimBanner() {
  const { state, service, setSim, step, reset, disabled } = useStore();
  const confirm = useConfirm();
  const { sim } = service;
  if (service.runtime === "real") {
    return (
      <div className="sim-banner live" role="note">
        <strong>LIVE EXECUTION</strong>
        <span>
          Claude and Codex agents run on this machine in isolated git worktrees and may incur usage costs.{" "}
          {state.project.prDelivery.enabled
            ? `Verified work is pushed to orchestration/* branches on ${state.project.prDelivery.remote} and opened as GitHub pull requests under your account; ${state.project.prDelivery.merge === "auto" ? "the app merges them itself after an independent review and passing required checks" : "you merge them"}.`
            : state.project.autonomy.autoDeliver.enabled
              ? `Verified work is delivered to ${state.project.autonomy.autoDeliver.branch} automatically (fast-forward only).`
              : "Results stay on orchestration/* branches until you merge them."}
        </span>
        {service.scheduler === "observer" && <span>(another service instance holds the scheduler)</span>}
      </div>
    );
  }
  return (
    <div className="sim-banner" role="note" data-tour="demo-bar">
      <strong>Demo</strong>
      <span className="sim-text">
        Simulated: no agents run and nothing leaves this computer.
        {service.scheduler === "observer" ? " (Another service instance holds the scheduler.)" : ""}
      </span>
      <Menu label="Simulation" id={SIM_MENU_BUTTON_ID} className="sim-menu">
        {(close) => (
          <>
            <Button size="small" variant="quiet" aria-pressed={sim.auto} disabled={disabled} onClick={() => void setSim({ auto: !sim.auto })}>
              {sim.auto ? "Pause simulation clock" : "Run simulation clock"}
            </Button>
            <Button size="small" variant="quiet" disabled={disabled || sim.auto} disabledReason={sim.auto ? "Pause the simulation clock to step manually" : undefined} onClick={() => void step()}>
              Step
            </Button>
            <TourButton onStart={close} />
            <Button
              size="small"
              variant="quiet"
              disabled={disabled}
              onClick={async () => {
                close();
                const ok = await confirm({ title: "Replace all data with the sample project?", text: "Every task, run and message in this service is replaced by the demo's sample project.", primaryLabel: "Replace" });
                if (ok) void reset();
              }}
            >
              Reset sample data
            </Button>
          </>
        )}
      </Menu>
    </div>
  );
}

/**
 * The two places, side by side on every screen (ORC-029 pass 5, screen 1): Vision says whether a draft waits for your
 * Lock in, and the Factory whether it runs and how many agents work. Each is a link: Vision opens the studio, the
 * Factory opens the tasks. The Factory's title keeps the live count of runs working and stopping.
 */
export function Places() {
  const { state } = useStore();
  const now = useNow();
  const vision = visionPlaceWords(visionPlace(state), now);
  const factory = factoryPlace(state);
  const words = factoryPlaceWords(factory, liveIndicatorText(agentsWorking(state), agentsStopping(state)));
  return (
    <nav className="places" aria-label="Vision and the factory">
      <StatePill tone={vision.tone} href="#/vision" title={vision.title}>
        {vision.text}
      </StatePill>
      <StatePill tone={words.tone} pulse={words.tone === "work"} paused={factory.state === "paused"} href="#/tasks" title={words.title}>
        {words.text}
      </StatePill>
    </nav>
  );
}

function ConnectionBanner() {
  const { status, confirmedAt, retry } = useStore();
  const now = useNow();
  if (status === "online") return null;
  if (status === "connecting")
    return (
      <div className="shell-banner">
        <Banner tone="info">Connecting to the service… controls are disabled until the live connection opens.</Banner>
      </div>
    );
  const since = confirmedAt ? relTime(new Date(confirmedAt).toISOString(), now) : "an earlier session";
  return (
    <div className="shell-banner">
      <Banner
        tone="fail"
        title="Service offline"
        actions={
          <Button size="small" onClick={retry}>
            Reconnect now
          </Button>
        }
      >
        Showing the last known state from {since}; controls are disabled until it reconnects.
      </Banner>
    </div>
  );
}

/**
 * Pause project and Resume project live in a small Project menu. The header still says truthfully when the
 * project is paused or pausing: "Paused" only once every run acknowledged the stop, "Pausing…" until then.
 */
export function ProjectMenu() {
  const { state, send, disabled } = useStore();
  const hold = state.project.hold;
  // A stopping lead run counts too: the pause is not confirmed until the lead acknowledges as well.
  const stopping = M.activeAttempts(state).filter((a) => a.outcome === "stopping").length + (M.activeLeadRun(state)?.outcome === "stopping" ? 1 : 0);
  const status = hold ? (stopping ? `Pausing… ${stopping} run${stopping === 1 ? "" : "s"} still stopping` : "Project paused") : undefined;
  return (
    <>
      <span aria-live="polite">
        {hold &&
          (stopping ? (
            <StatePill tone="work" pulse title={status}>
              Pausing…
            </StatePill>
          ) : (
            <StatePill tone="neutral" paused title={status}>
              Paused
            </StatePill>
          ))}
      </span>
      <Menu label="Project" className="project-menu">
        {(close) => (
          <>
            {status && <p className="menu__note">{status}</p>}
            {hold ? (
              <Button
                size="small"
                variant="quiet"
                disabled={disabled}
                onClick={() => {
                  close();
                  void send("resumeProject");
                }}
              >
                Resume project
              </Button>
            ) : (
              <Button
                size="small"
                variant="quiet"
                disabled={disabled}
                onClick={() => {
                  close();
                  void send("pauseProject");
                }}
              >
                Pause project
              </Button>
            )}
            <p className="menu__note">{hold ? "Agents start again when you resume." : "Every run and the lead are asked to stop; nothing starts until you resume. The pause shows as Paused once the runtime acknowledges."}</p>
          </>
        )}
      </Menu>
    </>
  );
}
