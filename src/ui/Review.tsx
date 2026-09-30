// The Review page. "Needs you": pull requests waiting for your merge or your attention. "Waiting":
// pull requests the app is still opening or whose checks are running. "Landed": work that already
// landed, to look over whenever you like. The landed list never blocks anything, and an item becomes
// "reviewed" only through Mark reviewed, never by opening it.

import { useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { Task } from "../domain/types";
import { LandedChips, LandedSection, PrChip, PrPanel } from "./Delivery";
import { fmtTime, relTime } from "./common";
import { useStore } from "./store";

type Filter = "unreviewed" | "all" | "sent-back";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "unreviewed", label: "Not reviewed" },
  { id: "all", label: "All" },
  { id: "sent-back", label: "Sent back" },
];
/** markLandedReviewed takes at most this many items per request. */
const BULK_LIMIT = 100;

export function Review() {
  const { state, service, send, disabled } = useStore();
  const [filter, setFilter] = useState<Filter>("unreviewed");
  const [open, setOpen] = useState<string | null>(null);
  const landed = D.landedTasks(state);
  const unreviewed = landed.filter((t) => t.integration!.landed!.status === "unreviewed");
  const match = (t: Task) => {
    const l = t.integration!.landed!;
    return filter === "all" || (filter === "unreviewed" ? l.status === "unreviewed" : l.followUps.length > 0);
  };
  const shown = landed.filter(match);
  const mode = D.deliveryMode(state);
  const bulk = unreviewed.slice(0, BULK_LIMIT);
  const now = Date.now();
  const gh = state.project.github;
  const tracked = D.trackedPrTasks(state);
  const closed = state.tasks.filter((t) => D.livePr(t)?.phase === "closed" && !t.integration?.landed);
  const needs = tracked.filter((t) => t.integration!.pr!.attention || D.prReady(state, t, now));
  const waiting = tracked.filter((t) => !needs.includes(t));
  const showGitHub = mode === "pr" || tracked.length > 0;

  return (
    <>
      <h1>Review</h1>
      {showGitHub && gh?.problem && (
        <div className="banner danger" role="alert">
          <strong>GitHub delivery is stopped.</strong> {gh.problem.message}{" "}
          <span className="muted">
            Since {fmtTime(gh.problem.since)}; it is checked again by itself.
          </span>{" "}
          <button className="small" disabled={disabled || !!gh.recheck} onClick={() => void send("recheckGitHub")}>
            {gh.recheck ? "Checking…" : "Check again"}
          </button>
        </div>
      )}
      {showGitHub && state.project.hold && (
        <div className="banner neutral" role="status">
          Paused: watching GitHub only; nothing will be pushed, opened, merged or commented.
        </div>
      )}
      {showGitHub && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {gh?.simulated
            ? "Pull requests here are simulated: nothing is sent to GitHub."
            : "Pull-request delivery is not verified against GitHub yet. The app opens and watches pull requests only while this service is running."}
          {gh?.observedAt ? ` GitHub was last read ${relTime(gh.observedAt)}.` : ""}
        </p>
      )}

      {showGitHub && (
        <>
          <h2>Needs you{needs.length ? ` (${needs.length})` : ""}</h2>
          {needs.length === 0 && (
            <section className="card">
              <p className="muted" style={{ margin: 0 }}>
                No pull request is waiting for you.
              </p>
            </section>
          )}
          {needs.map((t) => (
            <section className="card" key={t.id} aria-labelledby={`pr-${t.id}`}>
              <h3 id={`pr-${t.id}`} style={{ marginTop: 0 }}>
                <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title}
              </h3>
              <PrPanel state={state} task={t} />
            </section>
          ))}

          {(waiting.length > 0 || closed.length > 0) && <h2>Waiting</h2>}
          {waiting.length > 0 && (
            <section className="card">
              <ul className="plain">
                {waiting.map((t) => {
                  const expanded = open === `pr:${t.id}`;
                  return (
                    <li key={t.id} style={{ padding: "0.3rem 0" }}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <span>
                          <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title}
                        </span>
                        <span className="row">
                          <PrChip state={state} task={t} />
                          <button className="small" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : `pr:${t.id}`)}>
                            {expanded ? "Hide" : "Details"}
                          </button>
                        </span>
                      </div>
                      {expanded && (
                        <div style={{ marginTop: "0.6rem" }}>
                          <PrPanel state={state} task={t} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {closed.length > 0 && (
            <section className="card">
              <p className="muted" style={{ marginTop: 0 }}>
                Closed without merging. A closed pull request is never reopened; delivering again opens a new one.
              </p>
              <ul className="plain">
                {closed.map((t) => (
                  <li key={t.id} className="row" style={{ justifyContent: "space-between", padding: "0.3rem 0" }}>
                    <span>
                      <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title}
                    </span>
                    <span className="row">
                      <PrChip state={state} task={t} />
                      {mode === "pr" && (
                        <button className="small" disabled={disabled} onClick={() => void send("redeliver", { taskIds: [t.id] })}>
                          Deliver again
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <h2>Landed</h2>
      <p className="muted">
        Work that already landed. Look it over whenever you like: this list never delays a task or a delivery, and an item counts as reviewed only when you mark it.
      </p>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id === "unreviewed" ? ` (${unreviewed.length})` : f.id === "all" ? ` (${landed.length})` : ""}
            </button>
          ))}
        </div>
        {bulk.length > 1 && (
          <button
            disabled={disabled}
            onClick={() => {
              if (confirm(`Mark ${bulk.length} landed item${bulk.length === 1 ? "" : "s"} as reviewed?`)) void send("markLandedReviewed", { taskIds: bulk.map((t) => t.id), reviewed: true });
            }}
          >
            Mark {bulk.length === unreviewed.length ? "all" : "first"} {bulk.length} reviewed
          </button>
        )}
      </div>

      {shown.length === 0 && (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            {landed.length > 0
              ? filter === "unreviewed"
                ? "Everything that landed has been reviewed."
                : "Nothing has been sent back."
              : service.runtime === "fake" && mode !== "pr"
                ? "Nothing has landed. The simulated runtime delivers work only as simulated pull requests (Settings → Delivery), so this list stays empty."
                : mode === "local"
                  ? `Nothing has landed yet. Finished work appears here after it is delivered to ${state.project.autonomy.autoDeliver.branch}.`
                  : mode === "pr"
                    ? `Nothing has landed yet. Finished work appears here after its pull request merges into ${state.project.prDelivery.base}.`
                    : "Nothing has landed yet. Work appears here after it is delivered to your branch; delivery is off (Settings)."}
          </p>
        </section>
      )}
      {shown.map((t) => {
        const l = t.integration!.landed!;
        const expanded = open === t.id;
        return (
          <section className="card" key={t.id} aria-labelledby={`landed-${t.id}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 id={`landed-${t.id}`} style={{ margin: 0 }}>
                <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title}
              </h3>
              <span className="row">
                <LandedChips landed={l} />
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  {l.target} · {relTime(l.at)}
                </span>
              </span>
            </div>
            <div className="controls" style={{ marginTop: "0.5rem" }}>
              <button aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.id)}>
                {expanded ? "Hide details" : "Show details"}
              </button>
              {!expanded && l.status === "unreviewed" && (
                <button disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [t.id], reviewed: true })}>
                  Mark reviewed
                </button>
              )}
            </div>
            {expanded && (
              <div style={{ marginTop: "0.8rem" }}>
                <LandedSection state={state} task={t} />
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
