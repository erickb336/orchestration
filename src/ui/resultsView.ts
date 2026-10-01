// ORC-025 pass 4 (R1, R3): the Results page's words and lists, apart from React. Which pull requests wait for you
// and which are on their way, the New / All / Sent back filter, when the bulk "Mark all as seen" appears, the
// agent reviews of a landed item in one line, and what the page says when nothing has landed.

import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { Landed, ProviderId, RoleId, State, Task } from "../domain/types";
import { prsNeedingYou } from "./progress";
import { stepName } from "./task/stepWords";

// ---------- pull requests ----------

export interface PrLists {
  /** Pull requests stopped on a problem nobody is fixing: they need your decision. */
  problems: Task[];
  /** Pull requests ready for your Merge. */
  ready: Task[];
  /** Pull requests the app is still opening, reviewing, fixing or merging: nothing to do for you. */
  onTheirWay: Task[];
  /** Pull requests closed without merging, whose work has not landed. */
  closed: Task[];
}

/** The pull requests of the Results page. The first two are what the Results badge counts (prsNeedingYou). */
export function prLists(state: State, nowMs = Date.now()): PrLists {
  const waiting = prsNeedingYou(state, nowMs);
  const problems = waiting.filter((t) => {
    const pr = t.integration!.pr!;
    return !!pr.attention && !D.openRepair(state, pr);
  });
  const ready = waiting.filter((t) => !problems.includes(t));
  const onTheirWay = D.trackedPrTasks(state).filter((t) => !waiting.includes(t));
  const closed = state.tasks.filter((t) => D.livePr(t)?.phase === "closed" && !t.integration?.landed);
  return { problems, ready, onTheirWay, closed };
}

// ---------- landed items ----------

export type ResultsFilter = "new" | "all" | "sent-back";

export const FILTER_LABEL: Record<ResultsFilter, string> = { new: "New", all: "All", "sent-back": "Sent back" };

/** The card's title follows the filter, so it never calls a seen item new. */
export const FILTER_TITLE: Record<ResultsFilter, string> = { new: "New results", all: "Everything that landed", "sent-back": "Sent back" };

/** New: not marked as seen. Sent back: a fix or a revert was asked for. All: everything that landed. */
export function matchesFilter(landed: Landed, filter: ResultsFilter): boolean {
  if (filter === "all") return true;
  if (filter === "new") return landed.status === "unreviewed";
  return landed.status === "sent-back" || landed.followUps.length > 0;
}

/** The bulk "Mark all as seen" earns its place only past a handful of new items (R3). */
export const BULK_FROM = 4;
export const showBulk = (newCount: number) => newCount >= BULK_FROM;
/** markLandedReviewed takes at most this many items per request. */
export const BULK_LIMIT = 100;

/** "Mark all 5 as seen", or "Mark the first 100 as seen" past the limit. */
export function bulkLabel(newCount: number): string {
  const n = Math.min(newCount, BULK_LIMIT);
  return n === newCount ? `Mark all ${n} as seen` : `Mark the first ${n} as seen`;
}

interface ReviewLike {
  role: RoleId;
  purpose: string;
  openFindings: number;
  provider?: ProviderId;
  editedByUser: boolean;
}

/**
 * The agent reviews of a landed item in one line: "Code review by Claude: no open findings · Security review by
 * Claude: 1 open finding". When a role reviewed more than once, its last round speaks for it.
 */
export function reviewsLine(reviews: ReviewLike[]): string {
  if (!reviews.length) return "No agent review ran on this task.";
  const byRole = new Map<RoleId, ReviewLike>();
  for (const r of reviews) byRole.set(r.role, r);
  return [...byRole.values()]
    .map((r) => {
      const who = r.editedByUser ? " (edited by you)" : r.provider ? ` by ${M.providerLabel(r.provider)}` : "";
      const found = r.openFindings ? `${r.openFindings} open finding${r.openFindings === 1 ? "" : "s"}` : "no open findings";
      return `${stepName(r)}${who}: ${found}`;
    })
    .join(" · ");
}

/** What the landed list says when it is empty, by filter and by how work is delivered. */
export function emptyText(state: State, filter: ResultsFilter, runtime: string): { title: string; text?: string } {
  if (D.landedTasks(state).length > 0) {
    return filter === "new" ? { title: "No new results.", text: "You have seen everything that landed." } : { title: "Nothing has been sent back." };
  }
  const mode = D.deliveryMode(state);
  if (runtime === "fake" && mode !== "pr") return { title: "Nothing has landed.", text: "The demo delivers work only as simulated pull requests (Settings → Delivery), so this list stays empty." };
  if (mode === "local") return { title: "Nothing has landed yet.", text: `Finished work appears here after it is delivered to ${state.project.autonomy.autoDeliver.branch}.` };
  if (mode === "pr") return { title: "Nothing has landed yet.", text: `Finished work appears here after its pull request merges into ${state.project.prDelivery.base}.` };
  return { title: "Nothing has landed yet.", text: "Work appears here after it is delivered to your branch; delivery is off (Settings)." };
}
