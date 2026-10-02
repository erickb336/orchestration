// What a principle file is, pure, with no import of the compiled copy, so the generator
// (scripts/principles.mjs) can rebuild src/domain/builtInPrinciples.json even when it is missing or stale.
// principles.ts adds the compiled copies on top of this.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export interface Principle {
  /** The file name without .md. */
  id: string;
  name: string;
  /** One line: when the principle applies. */
  applyWhen: string;
  /** The credit: "pstack principle-<name>, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted". */
  source: string;
  /** The Markdown after the frontmatter, trimmed. At most 200 words. */
  body: string;
  /** SHA-256 of `body`, recorded on every run that received the principle. */
  hash: string;
}

/** The pstack commit the texts were adapted from. */
export const PSTACK_COMMIT = "12d587dfb20741cafc376c42c696c5f6e2a64487";
/** A body is at most this many words. */
export const PRINCIPLE_BODY_WORDS = 200;

/**
 * Every principle, in table order: the table in docs/tasks/ORC-024.md, with contextualize-and-write-for-the-reader
 * (docs/tasks/ORC-026.md) and write-controlled-english (ORC-029 pass 4d) first so they are always given in full.
 * Envelopes and records list a step's principles in this order. "attack-the-premise" is given to no step directly: dispatch adds it to a
 * repair round that follows a round which failed the same way.
 */
export const PRINCIPLE_IDS = [
  "contextualize-and-write-for-the-reader",
  "write-controlled-english",
  "exhaust-the-design-space",
  "experience-first",
  "foundational-thinking",
  "sequence-verifiable-units",
  "laziness-protocol",
  "subtract-before-you-add",
  "test-behavior-not-implementation",
  "migrate-callers-then-delete-legacy-apis",
  "fix-root-causes",
  "attack-the-premise",
  "prove-it-works",
  "boundary-discipline",
  "minimize-reader-load",
  "never-block-on-the-human",
  "encode-lessons-in-structure",
] as const;
export type PrincipleId = (typeof PRINCIPLE_IDS)[number];
export const PREMISE_ID: PrincipleId = "attack-the-premise";
/** The lead's own runs (conversation, planning, decisions) get these; the envelope builder adds them. */
export const LEAD_PRINCIPLE_IDS: readonly PrincipleId[] = ["contextualize-and-write-for-the-reader", "write-controlled-english", "experience-first", "sequence-verifiable-units", "never-block-on-the-human", "encode-lessons-in-structure"];
/**
 * Given to every agent run on top of its step's own set (and to the lead), so whatever an agent writes
 * can be understood cold (the problem, the decisions and what is left) and on the first read (controlled
 * English, about 80% of ASD-STE100). Not named in flow files.
 */
export const EVERY_RUN_PRINCIPLE_IDS: readonly PrincipleId[] = ["contextualize-and-write-for-the-reader", "write-controlled-english"];
/**
 * The studio's runs (ORC-029 pass 4d-2b) get a fixed set by role: the every-run principles and a small one of the
 * role's own, kept short because their envelopes carry large briefs. Not steps, so no flow names them.
 * - designer, experience first: it makes what the owner sees and marks, and every feature must justify itself (the
 *   PE loop grew features on each pass in the second real trial).
 * - pe, foundational thinking: it judges structure, scale and longevity before anything is built.
 * - pe, prove it works: it judges a design's claims, and must say what it could not check.
 */
export const STUDIO_PRINCIPLE_IDS: Readonly<Record<"designer" | "pe", readonly PrincipleId[]>> = {
  designer: ["contextualize-and-write-for-the-reader", "write-controlled-english", "experience-first"],
  pe: ["contextualize-and-write-for-the-reader", "write-controlled-english", "foundational-thinking", "prove-it-works"],
};

export const isPrincipleId = (id: string): id is PrincipleId => (PRINCIPLE_IDS as readonly string[]).includes(id);

/** Words as a reader counts them: runs of non-space characters. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const sha256Hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

const FIELDS = ["id", "name", "applyWhen", "source"] as const;

/**
 * Parse one principles/<id>.md: a `---` frontmatter of `key: value` lines (id, name, applyWhen, source;
 * nothing else), then the body. Throws, naming the file, on anything else: the files are proven by
 * tests, so a broken one never reaches a run.
 */
export function parsePrincipleFile(file: string, text: string): Principle {
  const fail = (m: string): never => {
    throw new Error(`${file}: ${m}`);
  };
  const normalised = text.replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalised);
  if (!m) fail("expected a --- frontmatter block followed by the body");
  const fields: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const line of m![1].split("\n")) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) fail(`unreadable frontmatter line "${line}"`);
    const key = kv![1] as (typeof FIELDS)[number];
    if (!FIELDS.includes(key)) fail(`unknown frontmatter field "${key}" (allowed: ${FIELDS.join(", ")})`);
    if (fields[key] !== undefined) fail(`frontmatter field "${key}" appears twice`);
    fields[key] = kv![2].trim();
  }
  for (const key of FIELDS) if (!fields[key]) fail(`frontmatter needs "${key}"`);
  const expectedId = file.split("/").pop()!.replace(/\.md$/, "");
  if (fields.id !== expectedId) fail(`the file is named "${expectedId}" but declares the id "${fields.id}"`);
  if (/\n/.test(fields.applyWhen!)) fail("applyWhen is one line");
  const body = m![2].trim();
  if (!body) fail("the body is empty");
  const words = wordCount(body);
  if (words > PRINCIPLE_BODY_WORDS) fail(`the body has ${words} words; at most ${PRINCIPLE_BODY_WORDS}`);
  return { id: fields.id!, name: fields.name!, applyWhen: fields.applyWhen!, source: fields.source!, body, hash: sha256Hex(body) };
}

