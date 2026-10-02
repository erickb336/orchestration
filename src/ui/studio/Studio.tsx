// Vision, the studio (ORC-029 passes 3d and 4a): the studio screen approved in pass 1 (the canvas). `#/vision`, in
// the main navigation.
//
// Left: the rounds, then the chosen round's artifacts with your mark, and the designer's runs of that round.
// Centre: the artifact, on Desktop or Mobile (only the project's devices), with its variants, Keep, Change or Drop,
// and Pin a comment; terminal demos and TUIs in a terminal window; interfaces, algorithms, topologies, contracts and
// flows as documents. Right: the lead's panel (its message for the round, its questions with suggested answers, and
// a box to message it); PE review of the artifact shown, with the PE's verdict on each variant and the artifact's
// versions; then your feedback: a summary, a note, and Send to the lead.
//
// Your marks, picks, pins, notes, answers and message are kept here until you send them, all together, as one
// message to the lead (the marks are also recorded on each version). You can mark a version once the PE agreed, or
// once its objections came to you; until then you can look.

import { useCallback, useState } from "react";
import * as M from "../../domain/model";
import * as S from "../../domain/studio/studio";
import { DOMAIN_WORDS } from "../../domain/studio/domains";
import type { Mark, Round, StudioArtifact } from "../../domain/studio/types";
import type { ProjectDomain } from "../../domain/types";
import type { PinMessage } from "../../runtime/prototype";
import { relTime, selectionText } from "../common";
import { Banner, Button, Chip, Disclosure, EmptyState, Field, Input, SegmentedControl, SimulatedChip, StatePill, Textarea } from "../kit";
import { cx } from "../kit/cx";
import { useLeadContext } from "../LeadDrawer";
import { useStore } from "../store";
import { DocumentArtifact } from "./Document";
import { DeviceFrame, NoPrototypeServer, PlainFrame, ScreenshotFallback, TerminalFile, TerminalRecording } from "./Frames";
import {
  AS_IS_FILES_SHOWN,
  AS_IS_LABEL,
  DEVICE_LABEL,
  DOMAIN_CHOICES,
  addPin,
  answerBlocker,
  answerParts,
  artifactLine,
  changedDrafts,
  defaultRound,
  deviceOptions,
  draftFrom,
  draftKey,
  draftSummary,
  madeByLine,
  peView,
  prototypeUrl,
  roundArtifacts,
  roundLead,
  roundLabel,
  roundRuns,
  roundsNewestFirst,
  runLine,
  sendAnswer,
  serviceFileUrl,
  showKind,
  standing,
  toggleDomain,
  versionHistory,
  usdRange,
  variantDemo,
  variantEntry,
  VERDICT_LABEL,
  VERDICT_TONE,
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
  const leadDrawer = useLeadContext();
  const [roundChoice, setRoundChoice] = useState<number | undefined>(undefined);
  const [artifactChoice, setArtifactChoice] = useState<string | undefined>(undefined);
  /** The version of an artifact you chose from its history, by artifact. */
  const [versionChoice, setVersionChoice] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [shownVariant, setShownVariant] = useState<Record<string, string>>({});
  const [deviceChoice, setDeviceChoice] = useState<ScreenDevice | undefined>(undefined);
  const [pinMode, setPinMode] = useState(false);
  /** Your answers to each round's questions, by round. */
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  /** What the last Send did, in words, until you change something. */
  const [sent, setSent] = useState<string | null>(null);

  // Until you choose one, the open round (or the newest) is shown, so a round that opens meanwhile comes into view.
  const n = roundChoice !== undefined && state.studio.rounds.some((r) => r.n === roundChoice) ? roundChoice : defaultRound(state);
  const round = state.studio.rounds.find((r) => r.n === n);
  const artifacts = n === undefined ? [] : roundArtifacts(state, n);
  const listed = artifacts.find((a) => a.id === artifactChoice) ?? artifacts[0];
  // An earlier or later version, when you chose one from its history; the round's newest otherwise.
  const artifact = listed && versionChoice[listed.id] !== undefined ? (S.versionsOf(state, listed.id).find((v) => v.version === versionChoice[listed.id]) ?? listed) : listed;

  const draftOf = (a: StudioArtifact): Draft => drafts[draftKey(a)] ?? draftFrom(S.currentFeedback(state, a.id, a.version));
  const update = useCallback(
    (a: StudioArtifact, change: (d: Draft) => Draft) => {
      setSent(null);
      setDrafts((all) => ({ ...all, [draftKey(a)]: change(all[draftKey(a)] ?? draftFrom(S.currentFeedback(state, a.id, a.version))) }));
    },
    [state],
  );

  const lead = roundLead(round);
  const questions = lead?.questions ?? [];
  const roundAnswers = (n !== undefined ? answers[n] : undefined) ?? [];
  const setAnswer = (i: number, text: string) => {
    if (n === undefined) return;
    setSent(null);
    setAnswers((all) => ({ ...all, [n]: questions.map((_, j) => (j === i ? text : (all[n]?.[j] ?? ""))) }));
  };
  const answer = { round: n, questions, answers: roundAnswers, message };
  const changed = changedDrafts(state, drafts);
  const parts = answerParts({ ...answer, changed });
  const blocker = disabled ? "The service is offline. What you marked and wrote stays here until it reconnects." : answerBlocker({ ...answer, changed });
  const sendAll = async () => {
    if (blocker || sending) return;
    setSending(true);
    const r = await sendAnswer(send, state, drafts, answer);
    setSending(false);
    if (!r) return;
    setDrafts((all) => {
      const next = { ...all };
      for (const k of r.recorded) delete next[k];
      return next;
    });
    setPinMode(false);
    if (!r.posted) {
      // The marks are recorded; your answers and message stay here to send again.
      setSent(r.recorded.length ? "Your marks are recorded on each version, but the message did not reach the lead. Send again." : null);
      return;
    }
    if (n !== undefined) setAnswers((all) => ({ ...all, [n]: [] }));
    setMessage("");
    setSent(`Sent to the lead as one message.${r.recorded.length ? " Your marks, picks, pins and notes are recorded on each version." : ""} The lead answers in the conversation.`);
  };

  const choose = (change: () => void) => {
    setPinMode(false);
    change();
  };

  return (
    <div className="k-stack st-page">
      <header className="st-head">
        <h1 className="no-margin">Vision</h1>
        <p className="small muted">
          {round ? `The studio · round ${round.n}${round.closedAt ? " (closed)" : ""}. ` : "The studio. "}The factory builds exactly what the blueprint shows, with many agents at once. Changing the blueprint now takes minutes; changing built work takes runs.
        </p>
      </header>
      {state.project.stage !== "shaping" && (
        <Banner tone="info">The factory has started. Looking at Vision changes nothing in it. You can mark artifacts and message the lead here; designer and PE runs wait until the project is back in Vision (Back to shaping, in Settings › Project).</Banner>
      )}
      <DomainPrompt />
      {state.studio.rounds.length === 0 ? (
        <EmptyState
          title="No rounds yet."
          action={
            <Button size="small" onClick={() => leadDrawer.openLead()}>
              Message the lead
            </Button>
          }
        >
          When the lead opens a round, the designer makes screens, terminal demos or documents for it, and they appear here for you to mark, pin and pick.
        </EmptyState>
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
                        {r.n} · {roundLabel(state, r)}
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
                        <ArtifactItem artifact={a} draft={draftOf(a)} current={a.id === artifact?.id} onClick={() => choose(() => (setArtifactChoice(a.id), setVersionChoice(({ [a.id]: _, ...rest }) => rest)))} />
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
            <LeadPanel round={round} answers={roundAnswers} onAnswer={setAnswer} message={message} onMessage={(text) => (setSent(null), setMessage(text))} />
            <PeReviewPanel artifact={artifact && round ? artifact : undefined} onVersion={(id, version) => choose(() => setVersionChoice((all) => ({ ...all, [id]: version })))} />
            <section className="k-stack k-stack--tight" aria-label="Your feedback">
              <h2 className="st-label">Your feedback</h2>
              {changed.length || parts.length ? (
                <ul className="st-sum" aria-label="Not sent yet">
                  {changed.map(({ artifact: a, draft }) => (
                    <li key={draftKey(a)}>
                      <b>{a.title}</b>
                      {a.version > 1 ? ` v${a.version}` : ""}: {draftSummary(a, draft) || "cleared"}
                    </li>
                  ))}
                  {parts.map((p) => (
                    <li key={p}>{`${p[0].toUpperCase()}${p.slice(1)}`}</li>
                  ))}
                </ul>
              ) : (
                !sent && <p className="small muted">Nothing marked or written yet.</p>
              )}
              {sent && (
                <p className="small muted" role="status">
                  {sent}
                </p>
              )}
              {artifact && standing(state, artifact).kind === "open" && (
                <Field label={`Note on ${artifact.title}`} hint="Anything the marks and pins do not say.">
                  <Textarea value={draftOf(artifact).note} disabled={disabled} rows={3} onChange={(e) => update(artifact, (d) => ({ ...d, note: e.target.value }))} />
                </Field>
              )}
              <div className="k-actions">
                <Button variant="primary" disabled={!!blocker} disabledReason={blocker} showReason={changed.length > 0 || parts.length > 0 || disabled} loading={sending} onClick={() => void sendAll()}>
                  {sending ? "Sending…" : "Send to the lead"}
                </Button>
              </div>
              <p className="micro muted">Your marks, answers and message go together, as one message to the lead.</p>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * While the product's kinds are not chosen: one compact question with the three kinds (r9). Each click saves at once
 * (setDomains), so one click answers it; after that it stays, to add a second kind, until Done or you leave Vision.
 * Settings › Project changes them later.
 */
function DomainPrompt() {
  const { state, send, disabled } = useStore();
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const chosen = state.project.domains;
  if (chosen.length && !answered) return null;
  const choose = async (d: ProjectDomain) => {
    setBusy(true);
    const r = await send("setDomains", { domains: toggleDomain(chosen, d) });
    setBusy(false);
    if (r.ok) setAnswered(true);
  };
  return (
    <Banner
      tone={chosen.length ? "done" : "you"}
      title={chosen.length ? `Saved: ${chosen.map((d) => DOMAIN_WORDS[d]).join(" and ")}.` : "What kind of product is it?"}
      actions={
        <div className="k-actions" role="group" aria-label="Kind of product">
          {DOMAIN_CHOICES.map((c) => {
            const on = chosen.includes(c.value);
            const last = on && chosen.length === 1;
            return (
              <Button key={c.value} size="small" aria-pressed={on} title={c.use} disabled={disabled || busy || last} disabledReason={disabled ? "The service is offline." : last ? "At least one kind stays chosen." : undefined} onClick={() => void choose(c.value)}>
                {c.label}
              </Button>
            );
          })}
          {chosen.length > 0 && (
            <Button size="small" variant="quiet" onClick={() => setAnswered(false)}>
              Done
            </Button>
          )}
        </div>
      }
    >
      {chosen.length
        ? "Choose another kind too if it fits. You can change this later in Settings › Project."
        : "Choose every kind that fits. The designer makes what each kind needs. Screen product: people use it on a screen. Code product: other programs use it. Infrastructure: it runs other software."}
    </Banner>
  );
}

/** An artifact in the left column: its title, what it is, and your mark (unsent marks included). */
function ArtifactItem({ artifact: a, draft, current, onClick }: { artifact: StudioArtifact; draft: Draft; current: boolean; onClick: () => void }) {
  const { state } = useStore();
  const st = standing(state, a);
  // An objection waiting for you is flagged in the list too, not only when the artifact is open.
  const objects = st.kind === "open" && S.openObjections(state, a).length > 0;
  return (
    <button type="button" className="st-item st-item--artifact" aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="st-item__title">{a.title}</span>
      <span className="st-item__line">{artifactLine(a)}</span>
      <span className="st-item__mark">
        {objects && (
          <>
            <Chip tone="you">PE objects</Chip>{" "}
          </>
        )}
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
  // The studio's own words on the screenshots: being taken, skipped and why, or some failed.
  const shots = S.shotsNote(a);
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

      {a.provenance?.asIs && <AsIsNote files={a.provenance.files} />}
      {locked && st.kind !== "open" && <p className="small muted">{locked}</p>}
      {kind === "screen" && shots && <p className="small muted">{shots}</p>}

      <div className={cx("st-stage", pinMode && "st-stage--pinning", kind === "terminal" && "st-stage--terminal", kind === "document" && "st-stage--doc")}>
        {kind === "screen" ? (
          !entry ? (
            <EmptyState title="No entry file">The designer named no entry file for this variant, so there is no page to show.</EmptyState>
          ) : src ? (
            <DeviceFrame src={src} title={`${frameTitle}, ${DEVICE_LABEL[shownDevice].toLowerCase()}`} device={shownDevice} pins={shownPins} pinMode={pinMode} onPin={onPin} />
          ) : (
            <ScreenshotFallback key={`${variant}-${shownDevice}`} artifact={a} variant={variant} device={shownDevice} />
          )
        ) : kind === "terminal" ? (
          <TerminalArtifact key={variant} artifact={a} variant={variant} />
        ) : kind === "document" ? (
          <DocumentArtifact key={variant} artifact={a} variant={variant} />
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

/**
 * An "as is" artifact (round 0 of an existing repository): the designer's reproduction of what the code does now, not
 * a proposal, with the repository files it came from. It is there for you to correct.
 */
function AsIsNote({ files }: { files: string[] }) {
  const list = (paths: string[]) => (
    <ul className="st-asis__files">
      {paths.map((f) => (
        <li key={f}>
          <code>{f}</code>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="st-asis" aria-label={AS_IS_LABEL}>
      <p className="small">
        <Chip strong>{AS_IS_LABEL}</Chip> The designer made this from the code, to show what the product does now. It is not a proposal. Correct what it gets wrong: mark it, pin comments or write a note.
      </p>
      <p className="micro muted">Made from {plural(files.length, "file")} in the repository:</p>
      {list(files.slice(0, AS_IS_FILES_SHOWN))}
      {files.length > AS_IS_FILES_SHOWN && (
        <Disclosure label="The other files" count={files.length - AS_IS_FILES_SHOWN}>
          {list(files.slice(AS_IS_FILES_SHOWN))}
        </Disclosure>
      )}
    </section>
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

/**
 * One variant of a terminal demo or TUI: its recording, its hand-written frames, or why there is nothing to play,
 * in the studio's words (demoNote). Everything is read through the app's own service (GET /api/studio/file), so it
 * shows while the prototype server is down too.
 */
function TerminalArtifact({ artifact: a, variant }: { artifact: StudioArtifact; variant: string | undefined }) {
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

/**
 * The lead's panel: its message for the round, its questions with the answers it suggests (a suggestion fills the
 * answer box, as on ORC-012's shaping panel), and a box to message it. What you write here is sent with your marks,
 * by Send to the lead, as one message in the conversation the header's Message the lead opens.
 */
export function LeadPanel({ round, answers, onAnswer, message, onMessage }: { round: Round | undefined; answers: string[]; onAnswer: (i: number, text: string) => void; message: string; onMessage: (text: string) => void }) {
  const { state, service, disabled } = useStore();
  const leadDrawer = useLeadContext();
  const lead = roundLead(round);
  const run = M.activeLeadRun(state);
  return (
    <section className="k-stack k-stack--tight" aria-label="The lead">
      <h2 className="st-label">The lead</h2>
      <div className="st-toolbar__grp">
        <span className="small muted">
          {selectionText(state.project.leadSelection)}
          {round ? ` · round ${round.n}` : ""}
        </span>
        {lead && service.runtime === "fake" && <SimulatedChip title="Simulated: the demo's lead wrote this round's message and questions; no model ran." />}
      </div>
      {lead?.message ? (
        <p className="st-leadmsg">{lead.message}</p>
      ) : (
        <p className="small muted">{round ? `The lead has written nothing for round ${round.n}.` : "No round is open."} Write to it below; it answers in the conversation.</p>
      )}
      {run && (
        <p className="small muted st-toolbar__grp" role="status">
          <StatePill tone="work" pulse>
            working
          </StatePill>
          {run.activity ?? "The lead is working."}
        </p>
      )}
      {lead && lead.questions.length > 0 && (
        <ol className="st-questions" aria-label="The lead asks">
          {lead.questions.map((q, i) => (
            <li key={i} className="st-question">
              <p className="small">{q.text}</p>
              {q.reason && <p className="micro muted">Why: {q.reason}</p>}
              {q.options && (
                <div className="st-chips" role="group" aria-label={`Suggested answers to question ${i + 1}`}>
                  {q.options.map((o) => (
                    <Button key={o} size="small" disabled={disabled} aria-pressed={answers[i] === o} onClick={() => onAnswer(i, o)}>
                      {o}
                    </Button>
                  ))}
                </div>
              )}
              <Field label={`Your answer to question ${i + 1}`} labelHidden>
                <Input type="text" value={answers[i] ?? ""} onChange={(e) => onAnswer(i, e.target.value)} placeholder="Your answer (leave empty to skip)" />
              </Field>
            </li>
          ))}
        </ol>
      )}
      <Field label="Message the lead" hint="Sent with your answers and marks, into the same conversation as Message the lead at the top.">
        <Textarea rows={3} value={message} onChange={(e) => onMessage(e.target.value)} placeholder="Anything else for the lead…" />
      </Field>
      <div>
        <Button size="small" variant="quiet" onClick={() => leadDrawer.openLead()}>
          Open the conversation
        </Button>
      </div>
    </section>
  );
}

/** PE review of the artifact shown: where it stands for you, the PE's latest verdict on each variant, and the artifact's versions. */
function PeReviewPanel({ artifact: a, onVersion }: { artifact: StudioArtifact | undefined; onVersion: (artifactId: string, version: number) => void }) {
  const { state } = useStore();
  const view = a && peView(state, a, M.providerLabel);
  const history = a ? versionHistory(state, a) : [];
  return (
    <section className="k-stack k-stack--tight" aria-label="PE review">
      <h2 className="st-label">PE review</h2>
      {!a ? (
        <p className="small muted">The PE reviews each option the designer makes before it reaches you.</p>
      ) : !view ? (
        <p className="small muted">{a.kind === "material" ? "What you brought" : "A probe's evidence"} is not reviewed by the PE.</p>
      ) : (
        <>
          <div className="st-toolbar__grp">
            <StatePill tone={view.tone} pulse={view.tone === "work"}>
              {view.state}
            </StatePill>
            {view.simulated && <SimulatedChip title="Simulated: the fake runtime's PE answered; no agent judged this." />}
            {view.notIndependent && <Chip tone="you">not independent</Chip>}
          </div>
          <p className="small">{view.text}</p>
          {view.by && <p className="micro muted">PE · {view.by}</p>}
          {view.notIndependent && <p className="small">{view.notIndependent}</p>}
          {view.verdicts.length > 0 && (
            <ul className="st-verdicts" aria-label="The PE's verdicts">
              {view.verdicts.map((v) => (
                <li key={v.id} className="st-verdict">
                  <div className="st-toolbar__grp">
                    <b className="small">{v.label}</b>
                    <Chip tone={VERDICT_TONE[v.verdict]}>{VERDICT_LABEL[v.verdict]}</Chip>
                    {v.overruled && <Chip>overruled</Chip>}
                  </div>
                  <p className="small muted">{v.reasons}</p>
                  {v.change && (
                    <p className="small">
                      {v.verdict === "not-feasible" ? "What would change the verdict: " : "The change: "}
                      {v.change}
                    </p>
                  )}
                  {v.budget && (
                    <p className="small muted">
                      Budget effect: {[v.budget.buildUsd && `building ${usdRange(v.budget.buildUsd)}`, v.budget.maintenanceUsdPerMonth && `maintenance ${usdRange(v.budget.maintenanceUsdPerMonth, true)}`].filter(Boolean).join(", ") || "no figures"}. Basis: {v.budget.basis}
                    </p>
                  )}
                  {v.overruled && <p className="small muted">You overruled it: {v.overruled.why}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {a && history.length > 1 && (
        <div className="k-stack k-stack--tight">
          <h3 className="st-label">Versions</h3>
          <ol className="st-list st-versions" aria-label={`Versions of ${a.title}`}>
            {history.map((h) => (
              <li key={h.version}>
                <button type="button" className="st-item st-version" aria-current={h.version === a.version ? "true" : undefined} onClick={() => onVersion(a.id, h.version)}>
                  <span className="st-version__head">
                    <b>v{h.version}</b>
                    {h.round !== a.round ? <span className="muted">round {h.round}</span> : null}
                    <Chip tone={h.tone}>{h.state}</Chip>
                    {h.current && <Chip strong>current</Chip>}
                  </span>
                  <span className="st-version__text">{h.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
