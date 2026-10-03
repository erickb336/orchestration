// Vision with a draft (ORC-029 pass 5, screen 2): the bar at the top of the studio that lists the draft's changes
// since the last Lock in, with Discard the draft and Review and lock in; and the version in force, shown beside the
// draft's version of a changed artifact. The words come from draftView.ts.

import { useState } from "react";
import * as B from "../../domain/studio/blueprint";
import { itemFactoryStatus } from "../../domain/studio/itemStatus";
import type { BlueprintItem, StudioArtifact } from "../../domain/studio/types";
import { Banner, Button, ButtonLink, Chip, useConfirm } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import { CHANGE_TONE, CHANGE_WORD, discardConfirm, draftHeading, draftLines, type DraftLine } from "./draftView";
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

/** The draft bar: what the draft holds since the last Lock in, Discard the draft, and Review and lock in. */
export function DraftBar() {
  const { state, send, disabled } = useStore();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
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
          <Button size="small" variant="quiet" disabled={disabled} loading={busy} onClick={() => void discard()}>
            Discard the draft
          </Button>
          <ButtonLink size="small" variant="primary" href={LOCK_IN_HASH}>
            Review and lock in
          </ButtonLink>
        </>
      }
    >
      <p className="small">{heading.since}</p>
      <ChangeLines lines={draftLines(state)} label="The draft's changes" />
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
