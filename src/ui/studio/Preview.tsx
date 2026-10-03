// An artifact version shown read-only, in the studio's own frames (ORC-029 pass 5): the version in force beside the
// draft's (screen 2), and the approved design beside what the factory built (screen 5, Design and reality). No pins,
// no marks: the studio's centre is where you answer a version.

import * as S from "../../domain/studio/studio";
import type { StudioArtifact } from "../../domain/studio/types";
import { Banner, EmptyState } from "../kit";
import { DocumentArtifact } from "./Document";
import { DeviceFrame, NoPrototypeServer, PlainFrame, ScreenshotFallback, TerminalFile, TerminalRecording } from "./Frames";
import { DEVICE_LABEL, prototypeUrl, serviceFileUrl, showKind, variantDemo, variantEntry, type ScreenDevice } from "./studioView";

const NO_PINS: never[] = [];
const noPin = () => {};

/** The version's chosen variant (or its only one), framed as the studio frames it, with nothing to mark. */
export function ArtifactPreview({ artifact: a, variant, device, port }: { artifact: StudioArtifact; variant: string | undefined; device: ScreenDevice; port: number | undefined }) {
  const v = variant ?? a.variants[0]?.id;
  const label = a.variants.find((x) => x.id === v)?.label;
  const title = `${a.title} v${a.version}${label ? `, ${label}` : ""}`;
  const entry = variantEntry(a, v);
  const src = port && entry ? prototypeUrl(a, entry, port) : undefined;
  switch (showKind(a)) {
    case "screen":
      if (!entry) return <EmptyState title="No entry file">The designer named no entry file for this variant, so there is no page to show.</EmptyState>;
      return src ? <DeviceFrame src={src} title={`${title}, ${DEVICE_LABEL[device].toLowerCase()}`} device={device} pins={NO_PINS} pinMode={false} onPin={noPin} /> : <ScreenshotFallback artifact={a} variant={v} device={device} />;
    case "terminal":
      return <TerminalArtifact artifact={a} variant={v} />;
    case "document":
      return <DocumentArtifact artifact={a} variant={v} />;
    case "dictionary":
      return <TermsTable artifact={a} />;
    default:
      return src ? <PlainFrame src={src} title={title} /> : <NoPrototypeServer />;
  }
}

/** A dictionary's terms, read-only: each term, its one meaning and the words it replaces. */
export function TermsTable({ artifact: a }: { artifact: StudioArtifact }) {
  return (
    <table className="st-table">
      <thead>
        <tr>
          <th scope="col">Term</th>
          <th scope="col">Meaning</th>
          <th scope="col">Words to avoid</th>
        </tr>
      </thead>
      <tbody>
        {(a.dictionary ?? []).map((e) => (
          <tr key={e.term}>
            <th scope="row">{e.term}</th>
            <td data-label="Meaning">{e.meaning}</td>
            <td data-label="Avoid">{e.avoid.length ? e.avoid.join(", ") : <span className="muted">none</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One variant of a terminal demo or TUI: its recording, its hand-written frames, or why there is nothing to play,
 * in the studio's words (demoNote). Everything is read through the app's own service (GET /api/studio/file), so it
 * shows while the prototype server is down too.
 */
export function TerminalArtifact({ artifact: a, variant }: { artifact: StudioArtifact; variant: string | undefined }) {
  const demo = variantDemo(a, variant);
  const note = variant === undefined ? undefined : S.demoNote(a, variant);
  if (demo.status === "pending") return <EmptyState title="Recording…">The service is recording the designer's tape in the sandbox, with no network. It shows here when it is done.</EmptyState>;
  if (demo.status === "recorded") {
    return (
      <div className="st-stack">
        {demo.error && <Banner tone="fail">{note ? `${note}.` : `Recorded with errors: ${demo.error}`}</Banner>}
        {demo.video || demo.gif ? (
          <TerminalRecording title={a.title} video={demo.video && serviceFileUrl(a, demo.video)} gif={demo.gif && serviceFileUrl(a, demo.gif)} />
        ) : (
          demo.transcript && <TerminalFile artifact={a} path={demo.transcript} kind="transcript" />
        )}
        <p className="small muted">Recorded with VHS from the designer's tape, in the sandbox with no network.</p>
      </div>
    );
  }
  if (demo.status === "hand-written") {
    return (
      <div className="st-stack">
        {note && <p className="small muted">{note}.</p>}
        {demo.frame && <TerminalFile artifact={a} path={demo.frame} kind="frame" />}
        {demo.cast && <TerminalFile artifact={a} path={demo.cast} kind="cast" />}
      </div>
    );
  }
  return <EmptyState title="Not recorded.">{note ? `${note}.` : demo.reason}</EmptyState>;
}
