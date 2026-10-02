// The studio (ORC-029 pass 3d): the first slice of the studio screen approved in pass 1 (the canvas). `#/vision`.
//
// Left: the rounds, then the chosen round's artifacts with your mark, and the designer's runs of that round.
// Centre: the artifact, on Desktop or Mobile (only the project's devices), with its variants, Keep, Change or Drop,
// and Pin a comment; terminal demos and TUIs in a terminal window. Right: a labelled placeholder for the lead's panel
// and PE review (pass 4), then your feedback: a summary, a note, and Send feedback (the `sendFeedback` command).
//
// Your marks, picks, pins and notes are kept here until you send them, all together, as one answer.

import { useCallback, useState } from "react";
import * as M from "../../domain/model";
import * as S from "../../domain/studio/studio";
import type { Mark, StudioArtifact } from "../../domain/studio/types";
import type { PinMessage } from "../../runtime/prototype";
import { relTime } from "../common";
import { Banner, Button, ButtonLink, Card, Chip, EmptyState, Field, SegmentedControl, SimulatedChip, StatePill, Textarea } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import { DeviceFrame, NoPrototypeServer, PlainFrame, ScreenshotFallback, TerminalFile, TerminalRecording } from "./Frames";
import {
  DEVICE_LABEL,
  FOCUS_LABEL,
  addPin,
  artifactLine,
  changedDrafts,
  defaultRound,
  deviceOptions,
  draftFrom,
  draftKey,
  draftSummary,
  madeByLine,
  prototypeUrl,
  recordingOf,
  roundArtifacts,
  roundRuns,
  roundsNewestFirst,
  runLine,
  sendBlocker,
  sendDrafts,
  showKind,
  standing,
  variantEntry,
  type Draft,
  type ScreenDevice,
} from "./studioView";
import "./studio.css";

const MARKS: { value: Mark; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "change", label: "Change" },
  { value: "drop", label: "Drop" },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether the fake runtime made this version: its run was simulated. */
const simulatedRun = (s: ReturnType<typeof useStore>["state"], a: StudioArtifact) => a.madeBy.role !== "user" && !!s.studio.runs.find((r) => r.id === (a.madeBy as { attemptId: string }).attemptId)?.simulated;

export function Studio() {
  const { state, service, send, disabled } = useStore();
  const [roundChoice, setRoundChoice] = useState<number | undefined>(undefined);
  const [artifactChoice, setArtifactChoice] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [shownVariant, setShownVariant] = useState<Record<string, string>>({});
  const [deviceChoice, setDeviceChoice] = useState<ScreenDevice | undefined>(undefined);
  const [pinMode, setPinMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // Until you choose one, the open round (or the newest) is shown, so a round that opens meanwhile comes into view.
  const n = roundChoice !== undefined && state.studio.rounds.some((r) => r.n === roundChoice) ? roundChoice : defaultRound(state);
  const round = state.studio.rounds.find((r) => r.n === n);
  const artifacts = n === undefined ? [] : roundArtifacts(state, n);
  const artifact = artifacts.find((a) => a.id === artifactChoice) ?? artifacts[0];

  const draftOf = (a: StudioArtifact): Draft => drafts[draftKey(a)] ?? draftFrom(S.currentFeedback(state, a.id, a.version));
  const update = useCallback(
    (a: StudioArtifact, change: (d: Draft) => Draft) => {
      setSent(false);
      setDrafts((all) => ({ ...all, [draftKey(a)]: change(all[draftKey(a)] ?? draftFrom(S.currentFeedback(state, a.id, a.version))) }));
    },
    [state],
  );

  const changed = changedDrafts(state, drafts);
  const blocker = disabled ? "The service is offline. Your marks stay here until it reconnects." : sendBlocker(changed);
  const sendAll = async () => {
    if (blocker || sending) return;
    setSending(true);
    const sentKeys = await sendDrafts(send, state, drafts);
    setSending(false);
    if (!sentKeys) return;
    setDrafts((all) => {
      const next = { ...all };
      for (const k of sentKeys) delete next[k];
      return next;
    });
    setPinMode(false);
    setSent(true);
  };

  const choose = (change: () => void) => {
    setPinMode(false);
    change();
  };

  return (
    <div className="k-stack st-page">
      <header className="st-head">
        <h1 className="no-margin">Studio</h1>
        <p className="small muted">
          {round ? `Vision · round ${round.n}${round.closedAt ? " (closed)" : ""}` : "Vision"}. The factory builds exactly what the blueprint shows, with many agents at once. Changing the blueprint now takes minutes; changing built work takes runs.
        </p>
      </header>
      {state.project.stage !== "shaping" && <Banner tone="info">The factory has started. The studio keeps Vision's rounds as they were.</Banner>}
      {state.studio.rounds.length === 0 ? (
        <EmptyState title="No rounds yet.">When the lead opens a round, the designer makes screens or terminal demos for it, and they appear here for you to mark, pin and pick.</EmptyState>
      ) : (
        <div className="st-canvas">
          <aside className="st-col st-left" aria-label="Rounds and artifacts">
            <section>
              <h2 className="st-label">Rounds</h2>
              <ul className="st-list" aria-label="Rounds">
                {roundsNewestFirst(state).map((r) => (
                  <li key={r.n}>
                    <button type="button" className="st-item" aria-current={r.n === n ? "true" : undefined} onClick={() => choose(() => (setRoundChoice(r.n), setArtifactChoice(undefined)))}>
                      <span className="st-item__title">
                        {r.n} · {FOCUS_LABEL[r.focus]}
                      </span>
                      <StatePill tone={r.closedAt ? "neutral" : "work"}>{r.closedAt ? "closed" : "open"}</StatePill>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {round && (
              <section>
                <h2 className="st-label">Round {round.n}</h2>
                {round.summary && <p className="small muted st-summary">{round.summary}</p>}
                {artifacts.length > 0 && (
                  <ul className="st-list" aria-label={`Artifacts of round ${round.n}`}>
                    {artifacts.map((a) => (
                      <li key={a.id}>
                        <ArtifactItem artifact={a} draft={draftOf(a)} current={a.id === artifact?.id} onClick={() => choose(() => setArtifactChoice(a.id))} />
                      </li>
                    ))}
                  </ul>
                )}
                <RunLines n={round.n} />
              </section>
            )}
          </aside>

          <section className="st-col st-center" aria-label="The artifact">
            {artifact && round ? (
              <ArtifactView
                key={draftKey(artifact)}
                artifact={artifact}
                draft={draftOf(artifact)}
                update={update}
                variant={shownVariant[draftKey(artifact)] ?? draftOf(artifact).pickedVariant ?? artifact.variants[0]?.id}
                onVariant={(v) => choose(() => setShownVariant((all) => ({ ...all, [draftKey(artifact)]: v })))}
                device={deviceChoice}
                onDevice={(d) => choose(() => setDeviceChoice(d))}
                pinMode={pinMode}
                setPinMode={setPinMode}
                port={service.prototypePort}
              />
            ) : round ? (
              <NoArtifacts n={round.n} />
            ) : null}
          </section>

          <aside className="st-col st-right" aria-label="The lead and your feedback">
            <section className="st-placeholder">
              <h2 className="st-label">The lead and PE review</h2>
              <p className="small muted">Not built yet: the lead's message for this round, its questions, and the PE's review of each option come here in pass 4 of the studio.</p>
            </section>
            <section className="k-stack k-stack--tight">
              <h2 className="st-label">Your feedback</h2>
              {changed.length ? (
                <ul className="st-sum" aria-label="Not sent yet">
                  {changed.map(({ artifact: a, draft }) => (
                    <li key={draftKey(a)}>
                      <b>{a.title}</b>
                      {a.version > 1 ? ` v${a.version}` : ""}: {draftSummary(a, draft) || "cleared"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{sent ? "Sent. Your marks, picks, pins and notes are recorded on each version." : "Nothing marked yet."}</p>
              )}
              {artifact && standing(state, artifact).kind === "open" && (
                <Field label={`Note on ${artifact.title}`} hint="Anything the marks and pins do not say.">
                  <Textarea value={draftOf(artifact).note} disabled={disabled} rows={3} onChange={(e) => update(artifact, (d) => ({ ...d, note: e.target.value }))} />
                </Field>
              )}
              <div className="k-actions">
                <Button variant="primary" disabled={!!blocker} disabledReason={blocker} showReason={changed.length > 0 || disabled} loading={sending} onClick={() => void sendAll()}>
                  {sending ? "Sending…" : "Send feedback"}
                </Button>
              </div>
              <p className="micro muted">Sent together, as one answer to the round.</p>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

/** An artifact in the left column: its title, what it is, and your mark (unsent marks included). */
function ArtifactItem({ artifact: a, draft, current, onClick }: { artifact: StudioArtifact; draft: Draft; current: boolean; onClick: () => void }) {
  const { state } = useStore();
  const st = standing(state, a);
  return (
    <button type="button" className="st-item st-item--artifact" aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="st-item__title">{a.title}</span>
      <span className="st-item__line">{artifactLine(a)}</span>
      <span className="st-item__mark">
        {st.kind === "pe" ? (
          <Chip>with the PE</Chip>
        ) : st.kind === "replaced" ? (
          <Chip>replaced by v{st.by.version}</Chip>
        ) : draft.mark ? (
          <Chip tone={draft.mark === "keep" ? "done" : draft.mark === "change" ? "you" : "fail"}>{draft.mark}</Chip>
        ) : (
          <Chip>unmarked</Chip>
        )}
      </span>
    </button>
  );
}

/** The designer's runs of a round that are under way, or the last one when it did not complete. */
function RunLines({ n }: { n: number }) {
  const { state } = useStore();
  const runs = roundRuns(state, n);
  if (!runs.length) return null;
  return (
    <ul className="st-runs" aria-label={`Runs of round ${n}`}>
      {runs.map((r) => {
        const line = runLine(state, r, M.providerLabel);
        return (
          <li key={r.id}>
            <StatePill tone={line.tone} pulse={line.tone === "work"}>
              {line.title}
            </StatePill>
            <span className="small muted">
              {line.text}
              {r.startedAt && r.status === "running" ? ` Started ${relTime(r.startedAt)}.` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The centre while a round has no artifacts: the designer working, waiting, failed, or nothing yet. */
function NoArtifacts({ n }: { n: number }) {
  const { state } = useStore();
  const runs = roundRuns(state, n);
  const working = runs.find((r) => r.status === "running" || r.status === "stopping");
  const queued = runs.find((r) => r.status === "queued");
  const ended = runs.find((r) => r.status === "failed" || r.status === "lost" || r.status === "stopped");
  if (working) return <EmptyState title={`The designer is working on round ${n}.`}>Its artifacts appear here when it finishes.</EmptyState>;
  if (queued) return <EmptyState title={`The designer's run for round ${n} is queued.`}>{runLine(state, queued, M.providerLabel).text}</EmptyState>;
  if (ended) return <EmptyState title={`The designer's run ${ended.status === "stopped" ? "was stopped" : ended.status === "lost" ? "was lost" : "failed"}.`}>{ended.note ?? "It ended without a reason."}</EmptyState>;
  return <EmptyState title={`Nothing in round ${n} yet.`}>The designer's artifacts for this round appear here.</EmptyState>;
}

interface ArtifactViewProps {
  artifact: StudioArtifact;
  draft: Draft;
  update: (a: StudioArtifact, change: (d: Draft) => Draft) => void;
  variant: string | undefined;
  onVariant: (v: string) => void;
  device: ScreenDevice | undefined;
  onDevice: (d: ScreenDevice) => void;
  pinMode: boolean;
  setPinMode: (on: boolean) => void;
  port: number | undefined;
}

/** The centre: the artifact's toolbar, the stage (a device frame, a terminal window or a plain frame), the variants, your mark, and the pins. */
function ArtifactView({ artifact: a, draft, update, variant, onVariant, device, onDevice, pinMode, setPinMode, port }: ArtifactViewProps) {
  const { state, disabled } = useStore();
  const kind = showKind(a);
  const st = standing(state, a);
  const locked = st.kind === "pe" ? st.text : st.kind === "replaced" ? `This is v${a.version}; v${st.by.version} (round ${st.by.round}) replaced it, so your answer goes on the newer version.` : disabled ? "The service is offline." : undefined;
  const options = deviceOptions(state.project.devices, a);
  // Until you choose, a phone-sized window starts on Mobile when the artifact has it.
  const narrow = typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 600px)").matches;
  const shownDevice = device && options.includes(device) ? device : narrow && options.includes("mobile") ? "mobile" : (options[0] ?? "desktop");
  const entry = variantEntry(a, variant);
  const src = port && entry ? prototypeUrl(a, entry, port) : undefined;
  const variantLabel = a.variants.find((v) => v.id === variant)?.label;
  const frameTitle = `${a.title}${variantLabel ? `, ${variantLabel}` : ""}`;
  const pinVariant = a.variants.length > 1 ? variant : undefined;
  const numbered = draft.pins.map((pin, i) => ({ pin, n: i + 1 }));
  const shownPins = numbered.filter(({ pin }) => pin.variant === undefined || pin.variant === variant);
  const onPin = useCallback((pin: PinMessage) => update(a, (d) => addPin(d, pin, pinVariant)), [update, a, pinVariant]);
  const canPin = kind === "screen" && !!src && !locked;

  return (
    <div className="st-stack">
      <div className="st-toolbar">
        <div className="st-toolbar__grp">
          <h2 className="st-title">{a.title}</h2>
          <span className="small muted">
            {madeByLine(a, M.providerLabel)} · v{a.version}
            {a.variants.length > 1 ? `, ${plural(a.variants.length, "variant")}` : ""}
          </span>
          {simulatedRun(state, a) && <SimulatedChip title="Simulated: the fake runtime's sample, not a designer agent's work." />}
        </div>
        <div className="st-toolbar__grp">
          {kind === "screen" && options.length > 1 && (
            <SegmentedControl label="Device" size="small" value={shownDevice} onChange={onDevice} options={options.map((d) => ({ value: d, label: DEVICE_LABEL[d] }))} />
          )}
          {kind === "screen" && options.length === 1 && <Chip>{DEVICE_LABEL[shownDevice]}</Chip>}
          {kind === "screen" && (
            <Button size="small" aria-pressed={pinMode} disabled={!canPin} disabledReason={!src ? "The prototype is not shown, so there is nothing to pin." : locked} onClick={() => setPinMode(!pinMode)}>
              {pinMode ? "Stop pinning" : "Pin a comment"}
            </Button>
          )}
        </div>
      </div>

      {locked && st.kind !== "open" && <p className="small muted">{locked}</p>}

      <div className={cx("st-stage", pinMode && "st-stage--pinning", kind === "terminal" && "st-stage--terminal")}>
        {kind === "screen" ? (
          src ? (
            <DeviceFrame src={src} title={`${frameTitle}, ${DEVICE_LABEL[shownDevice].toLowerCase()}`} device={shownDevice} pins={shownPins} pinMode={pinMode} onPin={onPin} />
          ) : (
            <ScreenshotFallback key={`${variant}-${shownDevice}`} artifact={a} variant={variant} device={shownDevice} />
          )
        ) : kind === "terminal" ? (
          <TerminalArtifact artifact={a} port={port} />
        ) : src ? (
          <PlainFrame src={src} title={frameTitle} />
        ) : (
          <NoPrototypeServer />
        )}
      </div>
      {/* Under the stage, so entering Pin mode does not move the prototype under your pointer. */}
      <p className={cx("small", pinMode ? "st-hint" : "sr-only")} role="status">
        {pinMode ? "Pin mode: click a spot in the prototype to pin a comment there. Clicks still work inside the prototype." : ""}
      </p>

      <div className="st-markbar">
        {a.variants.length > 1 && (
          <div className="st-toolbar__grp">
            <SegmentedControl label="Variant" size="small" value={variant ?? ""} onChange={onVariant} options={a.variants.map((v) => ({ value: v.id, label: v.label }))} />
            <Button
              size="small"
              aria-pressed={draft.pickedVariant === variant}
              disabled={!!locked || variant === undefined}
              disabledReason={locked}
              onClick={() => update(a, (d) => ({ ...d, pickedVariant: d.pickedVariant === variant ? undefined : variant }))}
            >
              {draft.pickedVariant === variant ? "Picked" : "Pick this variant"}
            </Button>
          </div>
        )}
        <div className="st-toolbar__grp" role="group" aria-label="Your mark">
          {MARKS.map((m) => (
            <Button
              key={m.value}
              size="small"
              className={cx("st-mark", `st-mark--${m.value}`)}
              aria-pressed={draft.mark === m.value}
              disabled={!!locked}
              disabledReason={locked}
              onClick={() => update(a, (d) => ({ ...d, mark: d.mark === m.value ? null : m.value }))}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </div>

      {draft.pins.length > 0 && <PinList artifact={a} draft={draft} update={update} locked={locked} />}
      <p className="micro muted">Artifacts stay on this computer: the studio shows the files the designer wrote, whichever provider wrote them.</p>
    </div>
  );
}

/** The pins on this version: number, the element it is on (as text), the variant, the comment, and Remove. */
function PinList({ artifact: a, draft, update, locked }: { artifact: StudioArtifact; draft: Draft; update: ArtifactViewProps["update"]; locked: string | undefined }) {
  const label = (id: string | undefined) => a.variants.find((v) => v.id === id)?.label;
  return (
    <ol className="st-pinlist" aria-label="Pinned comments">
      {draft.pins.map((p, i) => (
        <li key={i} className="st-pinrow">
          <span className="st-pin st-pin--static" aria-hidden="true">
            {i + 1}
          </span>
          <div className="st-pinrow__main">
            <p className="small">
              {p.selector ? <code className="st-selector">{p.selector}</code> : <span className="muted">The element is not recorded; the pin keeps its place on the page.</span>}
              {label(p.variant) ? <span className="muted"> · on {label(p.variant)}</span> : null}
            </p>
            <Field label={`Comment for pin ${i + 1}`} labelHidden>
              <Textarea
                rows={2}
                value={p.text}
                disabled={!!locked}
                placeholder="What should change here?"
                onChange={(e) => update(a, (d) => ({ ...d, pins: d.pins.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) }))}
              />
            </Field>
          </div>
          <Button size="small" variant="quiet" disabled={!!locked} disabledReason={locked} onClick={() => update(a, (d) => ({ ...d, pins: d.pins.filter((_, j) => j !== i) }))}>
            Remove
          </Button>
        </li>
      ))}
    </ol>
  );
}

/** A terminal demo or TUI: its recording, its hand-written frames, or why there is nothing to play. */
function TerminalArtifact({ artifact: a, port }: { artifact: StudioArtifact; port: number | undefined }) {
  const rec = recordingOf(a);
  if (rec.status === "recorded") {
    return (
      <div className="st-stack">
        {port ? <TerminalRecording title={a.title} video={rec.video && prototypeUrl(a, rec.video, port)} gif={rec.gif && prototypeUrl(a, rec.gif, port)} /> : <NoPrototypeServer />}
        <p className="small muted">Recorded with VHS from the designer's tape, in the sandbox with no network.</p>
        {!port && rec.transcript && <TerminalFile artifact={a} path={rec.transcript} kind="transcript" />}
      </div>
    );
  }
  if (rec.status === "hand-written") {
    return (
      <div className="st-stack">
        {rec.frame && <TerminalFile artifact={a} path={rec.frame} kind="frame" />}
        {rec.cast && <TerminalFile artifact={a} path={rec.cast} kind="cast" />}
      </div>
    );
  }
  return (
    <EmptyState title="Not recorded.">
      {rec.reason}
    </EmptyState>
  );
}

/** Home's way into the studio while the project is in Vision: where the rounds stand, and Open the studio. */
export function StudioCard() {
  const { state } = useStore();
  const round = S.currentRound(state) ?? state.studio.rounds.at(-1);
  const working = state.studio.runs.some((r) => r.status === "running" || r.status === "stopping");
  const count = round ? roundArtifacts(state, round.n).length : 0;
  const text = !round
    ? "No rounds yet. When the lead opens a round, the designer's screens and terminal demos appear in the studio for you to mark."
    : [`Round ${round.n}${round.closedAt ? " (closed)" : " open"}: ${FOCUS_LABEL[round.focus].toLowerCase()}`, plural(count, "artifact"), working ? "the designer is working" : ""].filter(Boolean).join(" · ");
  return (
    <Card
      title="Studio"
      actions={
        <ButtonLink size="small" href="#/vision">
          Open the studio
        </ButtonLink>
      }
    >
      <p className="no-margin">{text}</p>
    </Card>
  );
}
