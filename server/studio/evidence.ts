// The "Capture evidence" step (ORC-029 pass 5; docs/design/ORC-029-pass5-design.md, "Evidence of what the factory
// built"). The service, never the builder, captures what the built code shows: the screens in Chromium and the CLIs
// with VHS, in the recorder's container (container.ts), on a copy of the task's change at its commit.
//
// The coder's capture plan (CAPTURE_PLAN, committed with the change, so the plan always matches the commit it
// describes and a repair can fix it) names, for each screen it built, the page path and the devices, and for each
// terminal demo or TUI, a VHS tape in the repository that runs the real command. It is an agent's output, so it is
// checked here, at the boundary, like the studio's manifests and tapes (artifacts.ts, terminal.ts): plain paths inside
// the repository, read through no link, within caps, and every tape under the tape rules.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { CAPTURE_DEVICES, type CaptureDevice, type CaptureItem } from "../../src/domain/studio/evidence";
import { isInsidePath } from "../../src/domain/studio/studio";
import { OUT } from "./container";
import { TAPE_CAP, validateTape } from "./terminal";

// ---------- the capture plan ----------

/** Where the coder writes the capture plan, relative to the repository's root. */
export const CAPTURE_PLAN = ".orchestrator/capture.json";
export const PLAN_CAP = 64 * 1024;
export const MAX_PLANNED_SCREENS = 12;
export const MAX_PLANNED_TERMINALS = 6;
const MAX_PAGE_PATH = 200;
/** A page path: absolute on the preview's origin, URL characters only, never "//" (another host). */
const PAGE_PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/;
/** A path segment: the studio's plain names (artifacts.ts). */
const SEGMENT = /^[A-Za-z0-9._ -]+$/;
const ITEM_ID = /^bi-\d{1,9}$/;

/** One screen to capture: its page on the preview, on each device. */
export interface PlannedScreen {
  itemId: string;
  path: string;
  devices: CaptureDevice[];
}

/** One terminal demo or TUI to record: its tape, checked, with every Output pointed into `/out/<itemId>/`. */
export interface PlannedTerminal {
  itemId: string;
  /** The tape's path in the repository. */
  tape: string;
  /** The tape's folder in the repository ("." at the root): VHS runs there. */
  folder: string;
  /** The checked tape that the container's VHS reads. */
  normalized: string;
  /** The declared outputs, relative to `/out/<itemId>/`. */
  outputs: Partial<Record<"gif" | "webm" | "txt", string>>;
}

export interface CheckedPlan {
  screens: PlannedScreen[];
  terminals: PlannedTerminal[];
  /** Items whose entry was refused, with why: the rest of the plan still runs. */
  refused: { itemId: string; error: string }[];
  /** Entries the run ignores, and why (an item the task does not cite, say). */
  notes: string[];
}

export type PlanRead = { ok: true; plan: CheckedPlan } | { ok: false; reason: "no-plan" | "invalid-plan"; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const show = (x: unknown) => {
  const t = typeof x === "string" ? x : JSON.stringify(x) ?? String(x);
  return JSON.stringify(t.length > 60 ? `${t.slice(0, 60)}…` : t);
};

/** A repository path the plan may name: relative, inside, plain names, of this extension. */
function repoPath(p: unknown, ext: string): string | undefined {
  if (typeof p !== "string" || p.length > 200 || !isInsidePath(p) || !p.split("/").every((x) => SEGMENT.test(x)) || !p.endsWith(ext)) return undefined;
  return p;
}

/**
 * Check the plan's text against the items the run captures. `readFile` reads a repository file (a tape, a sourced
 * tape) through no link, or undefined. `cliEntry`: the project's CLI entry; when set, a tape must type it, so that it
 * records the real command. The shape of the whole plan is all or nothing; a refused entry costs only its item.
 */
export function checkCapturePlan(text: string, items: readonly CaptureItem[], o: { readFile: (rel: string) => string | undefined; cliEntry?: string }): PlanRead {
  const bad = (error: string): PlanRead => ({ ok: false, reason: "invalid-plan", error: `${CAPTURE_PLAN}: ${error}` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not valid JSON");
  }
  if (!isObj(raw)) return bad("not a JSON object");
  const unknown = Object.keys(raw).filter((k) => k !== "screens" && k !== "terminals" && k !== "$comment");
  if (unknown.length) return bad(`unknown field ${show(unknown[0])} (the plan has "screens" and "terminals")`);
  const screens = raw.screens ?? [];
  const terminals = raw.terminals ?? [];
  if (!Array.isArray(screens) || screens.length > MAX_PLANNED_SCREENS) return bad(`"screens" is a list of at most ${MAX_PLANNED_SCREENS}`);
  if (!Array.isArray(terminals) || terminals.length > MAX_PLANNED_TERMINALS) return bad(`"terminals" is a list of at most ${MAX_PLANNED_TERMINALS}`);

  const plan: CheckedPlan = { screens: [], terminals: [], refused: [], notes: [] };
  const seen = new Set<string>();
  /** The item an entry names, when the run captures it with this kind of entry; else a note or an error. */
  const itemFor = (e: Record<string, unknown>, where: string, kinds: readonly string[]): CaptureItem | string | undefined => {
    if (typeof e.item !== "string" || !ITEM_ID.test(e.item)) return `${where}: "item" is a blueprint item id (bi-<n>), not ${show(e.item)}`;
    if (seen.has(e.item)) return `${where}: ${e.item} is planned twice`;
    seen.add(e.item);
    const item = items.find((i) => i.itemId === e.item);
    if (!item) {
      plan.notes.push(`The capture plan names ${e.item}, which this task's spec does not cite as a screen, terminal demo or TUI; it was not captured.`);
      return undefined;
    }
    if (!kinds.includes(item.kind)) {
      plan.refused.push({ itemId: item.itemId, error: `${where}: ${item.itemId} is a ${item.kind}, so it belongs in "${item.kind === "screen" ? "screens" : "terminals"}"` });
      return undefined;
    }
    return item;
  };

  for (const [i, e] of screens.entries()) {
    const where = `screens[${i}]`;
    if (!isObj(e)) return bad(`${where} is not an object`);
    const item = itemFor(e, where, ["screen"]);
    if (typeof item === "string") return bad(item);
    if (!item) continue;
    const refuse = (error: string) => plan.refused.push({ itemId: item.itemId, error: `${where}: ${error}` });
    if (typeof e.path !== "string" || e.path.length > MAX_PAGE_PATH || !PAGE_PATH.test(e.path)) {
      refuse(`"path" is a page path on the preview, starting with "/" (at most ${MAX_PAGE_PATH} characters), not ${show(e.path)}`);
      continue;
    }
    const devices = e.devices;
    if (!Array.isArray(devices) || !devices.length || !devices.every((d) => (CAPTURE_DEVICES as readonly unknown[]).includes(d)) || new Set(devices).size !== devices.length) {
      refuse(`"devices" lists ${CAPTURE_DEVICES.join(" and/or ")}, each once`);
      continue;
    }
    plan.screens.push({ itemId: item.itemId, path: e.path, devices: CAPTURE_DEVICES.filter((d) => devices.includes(d)) });
  }

  for (const [i, e] of terminals.entries()) {
    const where = `terminals[${i}]`;
    if (!isObj(e)) return bad(`${where} is not an object`);
    const item = itemFor(e, where, ["terminal-demo", "tui"]);
    if (typeof item === "string") return bad(item);
    if (!item) continue;
    const refuse = (error: string) => plan.refused.push({ itemId: item.itemId, error: `${where}: ${error}` });
    const tape = repoPath(e.tape, ".tape");
    if (!tape) {
      refuse(`"tape" is a .tape inside the repository (plain names, no ".."), not ${show(e.tape)}`);
      continue;
    }
    const text = o.readFile(tape);
    if (text === undefined) {
      refuse(`${tape} is not a regular file of at most ${TAPE_CAP / 1024} KB in the change`);
      continue;
    }
    const folder = posix.dirname(tape);
    const check = validateTape(text, { name: tape, readSource: (rel) => o.readFile(folder === "." ? rel : posix.join(folder, rel)), outDir: posix.join(OUT, item.itemId) });
    if (!check.ok) {
      refuse(check.errors.slice(0, 3).join("; "));
      continue;
    }
    if (check.shell !== "bash") {
      refuse(`${tape} sets ${check.shell}; the recorder has bash only (Set Shell bash)`);
      continue;
    }
    if (o.cliEntry && !check.normalized!.split("\n").some((l) => /^\s*Type\b/.test(l) && l.includes(o.cliEntry!))) {
      refuse(`${tape} never types the CLI entry ${o.cliEntry}, so it would not record the real command`);
      continue;
    }
    plan.terminals.push({ itemId: item.itemId, tape, folder, normalized: check.normalized!, outputs: check.outputs });
  }
  return { ok: true, plan };
}

// ---------- reading files of the copy ----------

/**
 * One regular file of a folder (the copy of the change), read through no link: every folder on its way a real folder,
 * the file a regular file with one link, opened without following one, within `cap` bytes. Undefined otherwise.
 */
export function readPlainFile(root: string, rel: string, cap: number): Buffer | undefined {
  if (!isInsidePath(rel)) return undefined;
  const parts = rel.split("/");
  let cur = root;
  let fd: number | undefined;
  try {
    for (const [i, part] of parts.entries()) {
      cur = join(cur, part);
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) return undefined;
      if (i < parts.length - 1 && !st.isDirectory()) return undefined;
    }
    fd = openSync(cur, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size > cap) return undefined;
    const data = readFileSync(fd);
    return data.length > cap ? undefined : data;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const readText = (root: string, rel: string, cap: number): string | undefined => {
  const b = readPlainFile(root, rel, cap);
  if (!b) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
};

/** The capture plan of the copy at `root`, checked. "no-plan" when the change has none. */
export function readCapturePlan(root: string, items: readonly CaptureItem[], o: { cliEntry?: string } = {}): PlanRead {
  let exists = true;
  try {
    lstatSync(join(root, CAPTURE_PLAN));
  } catch {
    exists = false;
  }
  if (!exists) return { ok: false, reason: "no-plan", error: `The change has no capture plan (${CAPTURE_PLAN}).` };
  const text = readText(root, CAPTURE_PLAN, PLAN_CAP);
  if (text === undefined) return { ok: false, reason: "invalid-plan", error: `${CAPTURE_PLAN} is not a regular UTF-8 file of at most ${PLAN_CAP / 1024} KB reached through no link.` };
  return checkCapturePlan(text, items, { readFile: (rel) => readText(root, rel, TAPE_CAP), ...(o.cliEntry ? { cliEntry: o.cliEntry } : {}) });
}
