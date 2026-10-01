// ORC-013: review coverage. A clean code review must list exactly the changed files it judged; the
// service compares that list with the changed-path set it recorded before the run. Pure.

import type { Attempt, PathCoverage } from "./types";

/** Above this many changed files the review is "unproven": too large to show it was all reviewed. */
export const MAX_PROVEN_PATHS = 300;
/** How many changed paths the attempt records (the total is kept separately). */
export const MAX_SCOPE_PATHS = 500;
/** How many reported paths are read. */
export const MAX_REVIEWED_PATHS = 600;
/** How many missing or extra paths a coverage record lists. */
export const MAX_LISTED = 50;

/**
 * A repository-relative path as the service compares it: trimmed, without a leading "./" and with no
 * repeated slashes. Undefined when it is absolute, has a ".." segment, is empty or holds a NUL
 * character. Compared exactly (case-sensitive). A backslash is a character of the name, never a
 * separator (review 1, finding 2): the service runs on macOS and Linux, where git reports "/".
 */
export function normalizePath(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.includes("\0") || raw.length > 300) return undefined;
  let p = raw.trim().replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.startsWith("/") || /^[A-Za-z]:\//.test(p)) return undefined;
  if (p.split("/").some((seg) => seg === "..")) return undefined;
  return p;
}

export const notRequired = (): PathCoverage => ({ state: "not-required", changed: 0, reviewed: 0, missing: [], extra: [] });

/**
 * Compare the reported paths with the recorded changed-path set. No scope: nothing was under review,
 * so coverage is not required. Too many changed files: unproven. Otherwise complete or incomplete,
 * with the missing and extra files (at most 50 each).
 */
export function coverageOf(scope: Attempt["scope"] | undefined, reported: string[]): PathCoverage {
  if (!scope) return notRequired();
  const reviewed = new Set<string>();
  for (const r of reported) {
    const p = normalizePath(r);
    if (p) reviewed.add(p);
  }
  const base = { from: scope.from, to: scope.to, changed: scope.total, reviewed: reviewed.size };
  if (scope.total > MAX_PROVEN_PATHS || scope.total > scope.paths.length) return { state: "unproven", ...base, missing: [], extra: [] };
  const changed = new Set(scope.paths);
  const missing = scope.paths.filter((p) => !reviewed.has(p));
  const extra = [...reviewed].filter((p) => !changed.has(p));
  return { state: missing.length || extra.length ? "incomplete" : "complete", ...base, missing: missing.slice(0, MAX_LISTED), extra: extra.slice(0, MAX_LISTED) };
}

/** "did not account for 2 changed files (a.ts, b.ts)" / "listed 1 file that did not change (c.ts)". */
export function gapText(c: Pick<PathCoverage, "missing" | "extra" | "changed" | "reviewed">): string {
  const parts: string[] = [];
  const missingCount = Math.max(c.missing.length, c.changed - c.reviewed + c.extra.length);
  if (c.missing.length) parts.push(`did not account for ${missingCount} changed file${missingCount === 1 ? "" : "s"} (${c.missing.slice(0, 10).join(", ")}${missingCount > 10 ? ", …" : ""})`);
  if (c.extra.length) parts.push(`listed ${c.extra.length} file${c.extra.length === 1 ? "" : "s"} that did not change (${c.extra.slice(0, 10).join(", ")}${c.extra.length > 10 ? ", …" : ""})`);
  return parts.join(" and ") || "did not account for every changed file";
}

/** Only complete coverage (or a review that had nothing to cover) can count as clean evidence. */
export const coverageCounts = (c: PathCoverage | undefined): boolean => !!c && (c.state === "complete" || c.state === "not-required");

/** "Covered 12 of 12 changed files" / "Did not cover 2: a.ts, b.ts" / "Too large to show it was all reviewed (412 files)". */
export function coverageLabel(c: PathCoverage): string {
  switch (c.state) {
    case "complete":
      return `Covered ${c.changed} of ${c.changed} changed file${c.changed === 1 ? "" : "s"}`;
    case "incomplete":
      return c.missing.length ? `Did not cover ${c.missing.length}: ${c.missing.slice(0, 5).join(", ")}${c.missing.length > 5 ? ", …" : ""}` : `Listed ${c.extra.length} file${c.extra.length === 1 ? "" : "s"} that did not change`;
    case "unproven":
      return `Too large to show it was all reviewed (${c.changed} files)`;
    case "not-required":
      return "No changed-file list was recorded for this review";
  }
}
