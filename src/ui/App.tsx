// The shell: the demo bar with its Simulation menu, and the header: the project's menu (named by the project; it
// pauses and resumes), Home · Vision · Tasks · Results · Settings with the two places' states in their items (Home says
// where the factory stands, Vision whether a draft waits; ORC-030 a-header-phone), and "Message the lead" (the one
// primary action). One row on a desktop, two on a phone. The lead drawer opens from the header on every page. The
// kit's ConfirmProvider and ToastRegion are mounted once here, so every screen can confirm in page and show one toast.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as M from "../domain/model";
import { factoryPlace, projectPause, visionPlace } from "../domain/places";
import { StoreContext, useServiceContext, useServiceStore, useStore } from "./store";
import { Board } from "./Board";
import { TaskDetail } from "./TaskDetail";
import { Overview } from "./Overview";
import { Activity } from "./Activity";
import { Review } from "./Review";
import { Settings } from "./Settings";
import { PREF_LEAD_SEEN, endArrival, relTime, usePref } from "./common";
import { LeadDrawer, LeadDrawerContext, type LeadContext } from "./LeadDrawer";
import { messageStatusText } from "./notes";
import { useBrowserNotifications } from "./notifications";
import { agentsStopping, agentsWorking, liveIndicatorText, prsNeedingYou, unreadLeadReplies } from "./progress";
import { factoryPlaceState, importPlaces, visionPlaceState, type PlaceState } from "./placesView";
import { resultsHref } from "./resultsView";
import { parseRoute, tabOf } from "./route";
import { ShapingBanner } from "./Shaping";
import { SIM_MENU_BUTTON_ID, TourButton, useFirstRunTour } from "./Tour";
import { Gallery } from "./kit/Gallery";
import { ChangeOrderPage } from "./changeOrder/ChangeOrder";
import { PreflightPage } from "./preflight/Preflight";
import { LockInPage } from "./studio/LockIn";
import { BaselineLockIn } from "./import/BaselineLockIn";
import { importScreen } from "./import/importView";
import { Reality } from "./studio/Reality";
import { Studio } from "./studio/Studio";
import { waitingForYourMark } from "./studio/studioView";
import { Banner, Button, ConfirmProvider, ToastRegion, placeInWindow, useConfirm } from "./kit";
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
  // After the new route's screens took their effects (children first): a move that none took ends here.
  useEffect(endArrival, [route]);
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
      <Header tab={tab} leadOpen={leadOpen} onLead={() => (leadOpen ? closeLead() : openLead())} />
      {/* There is no stage chip. While shaping, the banner says so on every page; Home shows the shaping panel, the board its own banner, and the studio is Vision itself. */}
      {route.page !== "tasks" && route.page !== "overview" && route.page !== "vision" && route.page !== "lock-in" && route.page !== "baseline" && route.page !== "preflight" && (
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
        {route.page === "baseline" && <BaselineLockIn />}
        {route.page === "preflight" && <PreflightPage />}
        {route.page === "reality" && <Reality />}
        {route.page === "change-order" && <ChangeOrderPage key={route.rev} rev={route.rev} />}
      </main>
      {leadOpen && <LeadDrawer onClose={closeLead} />}
      <ToastRegion toast={notice ? { tone: notice.kind === "error" ? "fail" : "neutral", onDismiss: () => setNotice(null), children: notice.message } : null} />
    </LeadDrawerContext.Provider>
  );
}

/**
 * The header. One row on a desktop: the brand, the project's menu, the places, Message the lead. Two on a phone: the
 * project's menu and Message the lead, then the places, each with its state under its name (ORC-030 a-header-phone).
 * There is no row of pills: Home says where the factory stands, Vision whether a draft waits.
 */
export function Header({ tab, leadOpen, onLead }: { tab: string; leadOpen: boolean; onLead: () => void }) {
  const { state } = useStore();
  return (
    <header className="top">
      <div className="brand">
        <span className="brand__name">Orchestrator</span>
        <ProjectMenu />
      </div>
      <nav className="tabs" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.page} href={t.page === "review" ? resultsHref(state) : t.href} aria-current={tab === t.page ? "page" : undefined} data-tour={"tour" in t ? t.tour : undefined}>
            <span className="tab__name">
              {t.label}
              {t.page === "review" && <ResultsBadge />}
              {t.page === "vision" && <VisionBadge />}
            </span>
            {t.page === "overview" && <FactoryState />}
            {t.page === "vision" && <VisionState />}
          </a>
        ))}
      </nav>
      <div className="right">
        <LeadButton open={leadOpen} onClick={onLead} />
      </div>
    </header>
  );
}

/**
 * A small menu on a button: a native details/summary, so it is keyboard-operable as is. It closes on a click
 * outside, on Escape (focus returns to the button), and when an item calls `close`. Its list stays inside the window.
 */
function Menu({ label, name = label, id, className, title, children }: { label: string; name?: string; id?: string; className?: string; title?: string; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pop = useRef<HTMLDivElement>(null);
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
    // Placed as soon as it opens (a mutation is seen before the page is drawn; the toggle event comes later), and again
    // when the window's width changes while it is open.
    const place = () => {
      if (el.open && pop.current) placeInWindow(pop.current);
    };
    const opened = new MutationObserver(place);
    opened.observe(el, { attributes: true, attributeFilter: ["open"] });
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      opened.disconnect();
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, []);
  return (
    <details ref={ref} className={cx("menu", className)}>
      <summary id={id} className="menu__btn" title={title}>
        <span className="menu__label">{label}</span>
        <span className="menu__caret" aria-hidden="true" />
      </summary>
      <div ref={pop} className="menu__pop" role="group" aria-label={name}>
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
  // While the import reads or waits for its review (ORC-032), its parts are answered there, not marked.
  const n = importScreen(state) === "none" ? waitingForYourMark(state).length : 0;
  if (n === 0) return null;
  const text = `${n} artifact${n === 1 ? "" : "s"} waiting for your mark`;
  return (
    <span className="badge-new tab-badge" title={text} aria-label={text}>
      {n}
    </span>
  );
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
 * A place's state in its menu item (ORC-030 a-header-phone): a dot in the state's colour (pulsing while agents work,
 * two bars while paused) and the words; on a desktop after the item's name, on a phone under it, in fewer words.
 */
export function PlaceStateText({ s }: { s: PlaceState }) {
  return (
    <span className={cx("tab-state", `tab-state--${s.tone}`, s.pulse && "tab-state--pulse")} title={s.title}>
      <span className="tab-state__sep" aria-hidden="true">
        ·
      </span>
      {s.paused ? (
        <svg className="tab-state__pause" viewBox="0 0 8 9" aria-hidden="true" focusable="false">
          <rect x="0.5" y="0.5" width="2.4" height="8" rx="0.6" fill="currentColor" />
          <rect x="5.1" y="0.5" width="2.4" height="8" rx="0.6" fill="currentColor" />
        </svg>
      ) : (
        <span className="tab-state__dot" aria-hidden="true" />
      )}
      <span className={cx("tab-state__text", s.short && "tab-state__text--long")}>{s.text}</span>
      {s.short && <span className="tab-state__text tab-state__text--short">{s.short}</span>}
    </span>
  );
}

/** The factory's state beside Home: running and how many agents work, pausing, paused, stopped at the budget, or not started. */
export function FactoryState() {
  const { state } = useStore();
  return <PlaceStateText s={importPlaces(state)?.home ?? factoryPlaceState(factoryPlace(state), liveIndicatorText(agentsWorking(state), agentsStopping(state)))} />;
}

/** Vision's state beside it: a draft and what it holds, or when the version in force was locked in. */
export function VisionState() {
  const { state } = useStore();
  const now = useNow();
  return <PlaceStateText s={importPlaces(state)?.vision ?? visionPlaceState(visionPlace(state), now)} />;
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
 * The project's menu, named by the project (ORC-030 a-header-phone: the name and the menu are one control). Pause
 * project and Resume project live here. The menu says truthfully when the project is paused or pausing, as Home's
 * state does (one source, `projectPause`): "Project paused" only once every run acknowledged the stop, "Pausing…"
 * until then. The change of state is announced.
 */
export function ProjectMenu() {
  const { state, send, disabled } = useStore();
  const hold = state.project.hold;
  // Every run the pause stopped counts (the lead's and the studio's too): the Factory place reads the same fact.
  const pause = projectPause(state);
  const stopping = pause?.state === "pausing" ? pause.stopping : 0;
  const status = pause ? (stopping ? `Pausing… ${stopping} run${stopping === 1 ? "" : "s"} still stopping` : "Project paused") : undefined;
  return (
    <>
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
      <Menu label={state.project.name} name="Project" className="project-menu" title={`${state.project.name}: pause or resume the project`}>
        {(close) => (
          <>
            <p className="menu__note menu__name">{state.project.name}</p>
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
            <p className="menu__note">{hold ? "Agents start again when you resume." : "Every run and the lead are asked to stop; nothing starts until you resume. Home says paused once every run has stopped."}</p>
          </>
        )}
      </Menu>
    </>
  );
}
