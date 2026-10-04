// Vision's draft bar (ORC-029 pass 5, screen 2; one line since ORC-030 C1): the draft's changes since the last Lock in
// behind Show, with Discard the draft, and the way to Start the factory or Lock in; and the version in force, shown
// beside the draft's version of a changed artifact. The words come from draftView.ts.

import { useState } from "react";
import * as B from "../../domain/studio/blueprint";
import { itemFactoryStatus } from "../../domain/studio/itemStatus";
import type { BlueprintItem, StudioArtifact } from "../../domain/studio/types";
import { Banner, Button, ButtonLink, Chip, useConfirm } from "../kit";
import { cx } from "../kit/cx";
import { useLeadContext } from "../LeadDrawer";
import { StartFactoryLink } from "../preflight/StartFactoryLink";
import { PREFLIGHT_HASH } from "../preflight/preflightView";
import { useStore } from "../store";
import { CHANGE_TONE, CHANGE_WORD, discardConfirm, draftHeading, draftLines, emptyDraftWords, type DraftLine } from "./draftView";
import { ArtifactPreview } from "./Preview";
import { STATUS_TONE, STATUS_WORDS, taskWords } from "./realityView";
import { showKind, type ScreenDevice } from "./studioView";

export const LOCK_IN_HASH = "#/vision/lock-in";

/** One change: its tag (Added, Changed, Dropped, Open), the item as the draft has it, and what it replaces or why it stays. */
export function ChangeLines({ lines, label }: { lines: DraftLine[]; label: string }) {
  return (
    <ul className="st-changes" aria-label={label}>
      {lines.map((l) => (
        <li key={`${l.kind}-${l.itemId}`}>
          <Chip tone={CHANGE_TONE[l.kind]}>{CHANGE_WORD[l.kind]}</Chip>
          <span>
            <b>{l.name}</b> <span className="muted">({l.note})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What "Ask the lead for a round" writes in the conversation's box as a hint: the owner says what the round is for. */
export const ASK_FOR_A_ROUND = "Ask for a round: what should the designer make next? For example, the main screen of a trip.";

/**
 * The draft bar (ORC-030 a-vision-draft-bar and a-vision-empty), one line under the vision. With a draft: "Draft · 5
 * changes · 1 open", Show (the list of changes, since when, and Discard the draft), and the way to put it into force:
 * Start the factory… in Vision (its pre-flight is the first Lock in), Lock in… once the factory runs. With an empty
 * draft the main button is Ask the lead for a round, and Start the factory… is a quiet link.
 */
export function DraftBar() {
  const { state, send, disabled } = useStore();
  const lead = useLeadContext();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const shaping = state.project.stage === "shaping";
  if (!B.hasDraft(state)) {
    const w = emptyDraftWords(state);
    return (
      <Banner
        tone="info"
        role="none"
        className="st-draftbar st-draftbar--empty"
        title={w.title}
        actions={
          <>
            <Button size="small" variant="primary" onClick={() => lead.openLead({ placeholder: ASK_FOR_A_ROUND })}>
              Ask the lead for a round
            </Button>
            <StartFactoryLink variant="quiet" size="small" />
          </>
        }
      >
        {w.text}
      </Banner>
    );
  }
  const heading = draftHeading(state);
  const rev = B.draftRev(state);
  const discard = async () => {
    if (!(await confirm(discardConfirm(state)))) return;
    setBusy(true);
    await send("discardDraft", { draftRev: rev });
    setBusy(false);
  };
  return (
    <Banner
      tone="you"
      role="none"
      className="st-draftbar"
      title={heading.title}
      actions={
        <>
          <Button size="small" variant="quiet" aria-expanded={open} aria-controls="st-draft-list" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </Button>
          {/* In Vision, Start the factory is the first Lock in: its pre-flight holds the summary. */}
          <ButtonLink size="small" variant="primary" href={shaping ? PREFLIGHT_HASH : LOCK_IN_HASH}>
            {shaping ? "Start the factory…" : "Lock in…"}
          </ButtonLink>
        </>
      }
    >
      {open && (
        <div id="st-draft-list" className="k-stack k-stack--tight st-draftbar__list">
          <p className="small no-margin">{heading.since}</p>
          <ChangeLines lines={draftLines(state)} label="The draft's changes" />
          <div>
            <Button size="small" variant="quiet" disabled={disabled} loading={busy} onClick={() => void discard()}>
              Discard the draft
            </Button>
          </div>
        </div>
      )}
    </Banner>
  );
}

/** The version in force of a changed artifact, beside the draft's: what the factory builds now, and the tasks on it. */
export function InForcePane({ item, artifact, rev, device, port }: { item: BlueprintItem; artifact: StudioArtifact; rev: number; device: ScreenDevice; port: number | undefined }) {
  const { state } = useStore();
  const view = itemFactoryStatus(state, item.id);
  const working = view?.tasks.filter((t) => t.state !== "landed") ?? [];
  const kind = showKind(artifact);
  return (
    <section className="st-beside__pane" aria-label={`v${item.version}, in force`}>
      <p className="st-beside__cap">
        <span>
          v{item.version} · in force{rev ? ` (Lock in ${rev})` : ""}
        </span>
        {working.length > 0 && (
          <Chip tone={STATUS_TONE["being-built"]} title={STATUS_WORDS["being-built"]}>
            {working.map((t) => taskWords(t, item.version)).join(" · ")}
          </Chip>
        )}
      </p>
      <div className={cx("st-stage", kind === "terminal" && "st-stage--terminal", (kind === "document" || kind === "dictionary") && "st-stage--doc")}>
        <ArtifactPreview artifact={artifact} variant={item.variant} device={device} port={port} />
      </div>
    </section>
  );
}
