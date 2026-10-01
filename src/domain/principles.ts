// Principles, pure. The working principles live as Markdown files in principles/ (adapted
// from pstack, MIT). Nothing can import Markdown, so `npm run principles` compiles them into
// src/domain/builtInPrinciples.json, which is imported here; CI fails when the two disagree, so the
// files stay the source of truth. The file format and the table order are in principleFiles.ts; this
// module adds the compiled copies and tells which principles a step carries. The automatic "attack the
// premise" lives with dispatch (model.ts); the envelope section lives with the other sections
// (server/envelope.ts).

import builtIn from "./builtInPrinciples.json";
import { PRINCIPLE_IDS, type Principle, type PrincipleId } from "./principleFiles";
import type { StepDef } from "./types";

export * from "./principleFiles";

/** The compiled copies, in table order (the generator writes them that way; a test checks it). */
export const PRINCIPLES: readonly Principle[] = builtIn as Principle[];

const byId = new Map(PRINCIPLES.map((p) => [p.id, p]));

export function principle(id: string): Principle | undefined {
  return byId.get(id);
}

/** A principle's display name; the id itself when a record names one that no longer exists. */
export function principleName(id: string): string {
  return byId.get(id)?.name ?? id;
}

/** Known ids only, deduplicated, in table order. */
export function orderPrinciples(ids: Iterable<string>): PrincipleId[] {
  const wanted = new Set(ids);
  return PRINCIPLE_IDS.filter((id) => wanted.has(id));
}

/** The principles a step carries by its definition (its flow file, an internal flow or a check round), in table order. */
export function stepPrinciples(st: Pick<StepDef, "principles">): PrincipleId[] {
  return orderPrinciples(st.principles ?? []);
}
