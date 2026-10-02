// The vision studio and the blueprint (ORC-029). Placeholders for now: ORC-029 unit 2c gives each record its
// fields (docs/design/ORC-029-pass2-design.md, section 2c). The containers exist from state format 19, so the
// unit that fills them needs no migration of its own.

/** One exchange of the studio: the lead's message, the round's artifacts, and the owner's answer. */
export interface Round {}
/** A prototype, terminal demo, contract, flow map, material or evidence, versioned. */
export interface StudioArtifact {}
/** The owner's marks, pins and picks on one artifact version. */
export interface Feedback {}
/** The PE's verdict on one artifact version (or variant). */
export interface PeVerdict {}
/** A small Vision task that brings evidence for PE review. */
export interface Probe {}
/** One approved revision of what the factory builds from. */
export interface BlueprintRevision {}
/** A blueprint revision after the factory started, with the tasks it affects. */
export interface ChangeOrder {}

export interface Studio {
  rounds: Round[];
  artifacts: StudioArtifact[];
  feedback: Feedback[];
  verdicts: PeVerdict[];
  probes: Probe[];
}

export interface Blueprint {
  revisions: BlueprintRevision[];
  changeOrders: ChangeOrder[];
}

export const emptyStudio = (): Studio => ({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [] });
export const emptyBlueprint = (): Blueprint => ({ revisions: [], changeOrders: [] });
