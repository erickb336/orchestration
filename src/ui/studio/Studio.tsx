// Vision, the studio (ORC-029 passes 3d and 4a): the studio screen approved in pass 1 (the canvas). `#/vision`, in
// the main navigation.
//
// At the top (ORC-030 C1): the vision text and its history (VisionCard.tsx), then the draft bar, one line (Draft.tsx).
//
// Left: the rounds, then the chosen round's artifacts with your mark and where each stands in the blueprint ("in the
// draft" or "in force"), and the designer's runs of that round. A changed artifact shows its version in force beside it.
// Centre: the artifact, on Desktop or Mobile (only the project's devices), with Pin a comment; terminal demos and TUIs
// in a terminal window; interfaces, algorithms, topologies, contracts and flows as documents. Under it, your answer in
// one bar: the variant, Keep, Change or Drop, the note on the part, and Send to the lead (ORC-030 a-vision-actions).
// Right: only what the lead and the PE said: the lead's message for the round and its questions (with suggested
// answers and a box for yours), then PE review of the artifact shown, with the PE's verdict on each variant and the
// artifact's versions. The studio has no box of its own to message the lead: the header's Message the lead does that.
//
// Your marks, picks, pins, notes and answers are kept here until you send them, all together, as one message to the
// lead (the marks are also recorded on each version). You can mark a version once the PE agreed, or once its review
// ended, and then overrule an objection that stands, with your reason; until then you can look.

import { useCallback, useState, type ReactNode } from "react";
import * as M from "../../domain/model";
import * as R from "../../domain/studio/runs";
import * as S from "../../domain/studio/studio";
import { DOMAIN_WORDS } from "../../domain/studio/domains";
import type { Mark, Round, StudioArtifact } from "../../domain/studio/types";
import { PATTERNS, PATTERN_NAME } from "../../domain/studio/words";
import type { ProjectDomain } from "../../domain/types";
import type { PinMessage } from "../../runtime/prototype";
import { relTime, selectionText } from "../common";
import { Banner, Button, Chip, Disclosure, EmptyState, Field, Input, SegmentedControl, SimulatedChip, StatePill, Textarea } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import { DocumentArtifact } from "./Document";
import { DraftBar, InForcePane } from "./Draft";
import { BLUEPRINT_PLACE_TITLE, PLACE_TONE, blueprintPlace, inForceBeside } from "./draftView";
import { DeviceFrame, NoPrototypeServer, PlainFrame, ScreenshotFallback } from "./Frames";
import { PeQuestions } from "./PeQuestions";
import { TerminalArtifact } from "./Preview";
import { VisionCard } from "./VisionCard";
import { ImportPanel } from "../import/ImportPanel";
import { ImportReview } from "../import/ImportReview";
import { importScreen } from "../import/importView";
import {
  AS_IS_FILES_SHOWN,
  AS_IS_LABEL,
  DEVICE_LABEL,
  DOMAIN_CHOICES,
  addPin,
  answerBlocker,
  answerEffects,
  answerParts,
  artifactLine,
  changedDrafts,
  defaultRound,
  deviceOptions,
  dictionaryStanding,
  draftFrom,
  draftKey,
  draftSummary,
  keepUnmarked,
  keptNotInDraft,
  madeByLine,
  peView,
  prototypeUrl,
  roundArtifacts,
  roundLead,
  roundLabel,
  roundRuns,
  roundsNewestFirst,
  rowMark,
  runLine,
  sendAnswer,
  showKind,
  standing,
  tableRows,
  toggleDomain,
  toggleRow,
  versionHistory,
  usdRange,
  variantEntry,
  variantRules,
  type Draft,
  type DraftEffect,
  type ScreenDevice,
  type TableRow,
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

/**
 * Vision. While a project imports a repository (ORC-032), its round 0 is the import: the reading, then the review
 * (src/ui/import); once locked in as the baseline, the studio shows it as any round.
 */
export function Studio() {
  const { state } = useStore();
  const screen = importScreen(state);
  if (screen === "reading") return <ImportPanel />;
  if (screen === "review") return <ImportReview />;
  return <StudioCanvas />;
}

function StudioCanvas() {
  const { state, service, send, disabled } = useStore();
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
  const [sending, setSending] = useState(false);
  /** What the last Send did, in words, until you change something: to the lead, then to the draft, part by part. */
  const [sent, setSent] = useState<string | null>(null);
  const [sentDraft, setSentDraft] = useState<string[]>([]);

  // Until you choose one, the open round (or the newest) is shown, so a round that opens meanwhile comes into view.
  const n = roundChoice !== undefined && state.studio.rounds.some((r) => r.n === roundChoice) ? roundChoice : defaultRound(state);
  const round = state.studio.rounds.find((r) => r.n === n);
  const artifacts = n === undefined ? [] : roundArtifacts(state, n);
  const listed = artifacts.find((a) => a.id === artifactChoice) ?? artifacts[0];
  // An earlier or later version, when you chose one from its history; the round's newest otherwise.
  const artifact = listed && versionChoice[listed.id] !== undefined ? (S.versionsOf(state, listed.id).find((v) => v.version === versionChoice[listed.id]) ?? listed) : listed;
  const shown = artifact && round ? artifact : undefined;

  const draftOf = (a: StudioArtifact): Draft => drafts[draftKey(a)] ?? draftFrom(S.currentFeedback(state, a.id, a.version));
  const update = useCallback(
    (a: StudioArtifact, change: (d: Draft) => Draft) => {
      setSent(null);
      setSentDraft([]);
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
  // The studio has no message box of its own (ORC-030 a-vision-two-boxes): the note on the part says the rest.
  const answer = { round: n, questions, answers: roundAnswers, message: "" };
  const changed = changedDrafts(state, drafts);
  const effects = new Map(answerEffects(state, changed).map((e) => [e.key, e]));
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
    setSentDraft(r.draft);
    if (!r.posted) {
      // The marks are recorded; your answers stay here to send again.
      setSent(r.recorded.length ? "Your marks are recorded on each version, but the message did not reach the lead. Send again." : null);
      return;
    }
    if (n !== undefined) setAnswers((all) => ({ ...all, [n]: [] }));
    setSent(`Sent to the lead as one message.${r.recorded.length ? " Your marks, picks, pins and notes are recorded on each version." : ""} The lead answers in the conversation.`);
  };

  const choose = (change: () => void) => {
    setPinMode(false);
    change();
  };
  const variant = shown ? (shownVariant[draftKey(shown)] ?? draftOf(shown).pickedVariant ?? shown.variants[0]?.id) : undefined;
  // The bar shows when there is something to answer: a part, the lead's questions, or a change not sent yet.
  const showBar = !!round && (!!shown || questions.length > 0 || changed.length > 0 || !!sent);

  return (
    <div className="k-stack st-page">
      <header className="st-head">
        <h1 className="no-margin">Vision</h1>
        <p className="small muted">{round ? `The studio · round ${round.n}${round.closedAt ? " (closed)" : ""}. ` : "The studio. "}The factory builds exactly what the blueprint shows.</p>
      </header>
      <VisionCard />
      <DraftBar />
      <DomainPrompt />
      {state.studio.rounds.length === 0 ? (
        <EmptyState title="No rounds yet.">When the lead opens a round, the designer makes screens, terminal demos or documents for it, and they appear here for you to mark, pin and pick.</EmptyState>
      ) : (
        <div className="st-canvas">
          <aside className="st-col st-left" aria-label="Rounds and artifacts">
            <section>
              <h2 className="st-label">Rounds</h2>
              <ul className="st-list" aria-label="Rounds" data-tour="vision-rounds">
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
            {shown ? (
              <ArtifactView
                key={draftKey(shown)}
                artifact={shown}
                draft={draftOf(shown)}
                update={update}
                variant={variant}
                device={deviceChoice}
                onDevice={(d) => choose(() => setDeviceChoice(d))}
                pinMode={pinMode}
                setPinMode={setPinMode}
                port={service.prototypePort}
              />
            ) : round ? (
              <NoArtifacts n={round.n} />
            ) : null}
            {showBar && (
              <AnswerBar
                artifact={shown}
                draft={shown ? draftOf(shown) : undefined}
                update={update}
                variant={variant}
                onVariant={(v) => shown && choose(() => setShownVariant((all) => ({ ...all, [draftKey(shown)]: v })))}
                pending={changed.map(({ artifact: a, draft }) => ({
                  key: draftKey(a),
                  title: `${a.title}${a.version > 1 ? ` v${a.version}` : ""}`,
                  summary: draftSummary(a, draft) || "cleared",
                  effect: effects.get(draftKey(a)),
                }))}
                parts={parts}
                kept={shown && !changed.some((c) => draftKey(c.artifact) === draftKey(shown)) ? keptNotInDraft(state, shown) : undefined}
                blocker={blocker}
                sending={sending}
                sent={sent}
                sentDraft={sentDraft}
                onSend={() => void sendAll()}
              />
            )}
          </section>

          <aside className="st-col st-right" aria-label="What the lead and the PE said">
            <LeadPanel round={round} answers={roundAnswers} onAnswer={setAnswer} />
            <PeReviewPanel artifact={shown} onVersion={(id, version) => choose(() => setVersionChoice((all) => ({ ...all, [id]: version })))} />
          </aside>
        </div>
      )}
    </div>
  );
}

/** One part of your answer not sent yet, as the bar lists it: the version, your marks in words, and what Send does to the draft. */
interface PendingPart {
  key: string;
  title: string;
  summary: string;
  effect: DraftEffect | undefined;
}

interface AnswerBarProps {
  /** The part shown, when there is one; undefined while the round has none. */
  artifact: StudioArtifact | undefined;
  draft: Draft | undefined;
  update: (a: StudioArtifact, change: (d: Draft) => Draft) => void;
  variant: string | undefined;
  onVariant: (v: string) => void;
  pending: PendingPart[];
  /** Your answers to the lead's questions, in a few words ("2 answers to the lead's questions"). */
  parts: string[];
  /** Why a version you kept is not in the draft, when your answer has nothing on it. */
  kept: string | undefined;
  blocker: string | undefined;
  sending: boolean;
  sent: string | null;
  sentDraft: string[];
  onSend: () => void;
}

/**
 * Your answer, in one bar under the part (ORC-030 a-vision-actions): the variant and Pick this variant, then Keep,
 * Change or Drop, the note on the part and Send to the lead; under it, what Send sends and does to the draft.
 */
function AnswerBar({ artifact: a, draft, update, variant, onVariant, pending, parts, kept, blocker, sending, sent, sentDraft, onSend }: AnswerBarProps) {
  const { state, disabled } = useStore();
  const locked = a ? lockedWhy(state, a, disabled) : undefined;
  const open = !!a && standing(state, a).kind === "open";
  const nothing = pending.length === 0 && parts.length === 0;
  return (
    <section className="st-answer" aria-label="Your answer">
      {a && draft && a.variants.length > 1 && (
        <div className="st-answer__row">
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
      <div className="st-answer__row">
        {a && draft && (
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
        )}
        {a && draft && open && (
          <Field label={`Note on ${a.title}`} labelHidden className="st-answer__note">
            <Textarea value={draft.note} disabled={disabled} rows={1} placeholder={`Note on ${a.title}…`} onChange={(e) => update(a, (d) => ({ ...d, note: e.target.value }))} />
          </Field>
        )}
        <Button variant="primary" size="small" disabled={!!blocker} disabledReason={blocker} showReason={!nothing || disabled} loading={sending} onClick={onSend}>
          {sending ? "Sending…" : "Send to the lead"}
        </Button>
      </div>
      {!nothing && (
        <ul className="st-sum" aria-label="Not sent yet">
          {pending.map((p) => (
            <li key={p.key}>
              <b>{p.title}</b>: {p.summary}
              {p.effect && <span className={cx("st-effect", p.effect.refused && "st-effect--refused")}>{p.effect.will}</span>}
            </li>
          ))}
          {parts.map((p) => (
            <li key={p}>{`${p[0].toUpperCase()}${p.slice(1)}`}</li>
          ))}
        </ul>
      )}
      {nothing && kept && <p className="small st-hint">{kept}</p>}
      {nothing && !kept && !sent && open && <p className="micro muted">Keep puts the part in the draft when you send. Drop takes it out.</p>}
      {sent && (
        <p className="small muted" role="status">
          {sent}
        </p>
      )}
      {sentDraft.length > 0 && (
        <ul className="st-sum" aria-label="The draft after Send">
          {sentDraft.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Why you cannot mark this version now, in words: the PE has it, a newer version replaced it, or the service is offline. */
function lockedWhy(s: ReturnType<typeof useStore>["state"], a: StudioArtifact, offline: boolean): string | undefined {
  const st = standing(s, a);
  return st.kind === "pe" ? st.text : st.kind === "replaced" ? `This is v${a.version}; v${st.by.version} (round ${st.by.round}) replaced it, so your answer goes on the newer version.` : offline ? "The service is offline." : undefined;
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
        <div className="st-chips st-kinds" role="group" aria-label="Kind of product">
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
  // Where this version stands in the blueprint (pass 5): in the draft, or in force.
  const place = blueprintPlace(state, a);
  return (
    <button type="button" className="st-item st-item--artifact" aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="st-item__title">{a.title}</span>
      <span className="st-item__line">{artifactLine(a)}</span>
      <span className="st-item__mark">
        {place && (
          <>
            <Chip tone={PLACE_TONE[place]} strong={place === "in force"} title={BLUEPRINT_PLACE_TITLE[place]}>
              {place}
            </Chip>{" "}
          </>
        )}
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
        ) : draft.rows.length ? (
          <Chip>{rowsMarkedText(a, draft)}</Chip>
        ) : (
          <Chip>unmarked</Chip>
        )}
      </span>
    </button>
  );
}

/** "4 of 6 terms marked": the owner's row marks on a dictionary or a flow's rules, when the artifact itself has no mark. */
function rowsMarkedText(a: StudioArtifact, draft: Draft): string {
  return `${draft.rows.length} of ${plural(tableRows(a).length, a.kind === "dictionary" ? "term" : "rule")} marked`;
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
  const working = runs.find(R.isActiveStudioRun);
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
  device: ScreenDevice | undefined;
  onDevice: (d: ScreenDevice) => void;
  pinMode: boolean;
  setPinMode: (on: boolean) => void;
  port: number | undefined;
}

/** The centre: the artifact's toolbar, the stage (a device frame, a terminal window or a plain frame), and the pins. Your answer is the bar under it (AnswerBar). */
function ArtifactView({ artifact: a, draft, update, variant, device, onDevice, pinMode, setPinMode, port }: ArtifactViewProps) {
  const { state, disabled } = useStore();
  const kind = showKind(a);
  const st = standing(state, a);
  const locked = lockedWhy(state, a, disabled);
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

      <Beside artifact={a} device={shownDevice} port={port}>
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
          ) : kind === "dictionary" ? (
            <DictionaryTable artifact={a} draft={draft} update={update} locked={locked} />
          ) : src ? (
            <PlainFrame src={src} title={frameTitle} />
          ) : (
            <NoPrototypeServer />
          )}
        </div>
      </Beside>
      {/* Under the stage, so entering Pin mode does not move the prototype under your pointer. */}
      <p className={cx("small", pinMode ? "st-hint" : "sr-only")} role="status">
        {pinMode ? "Pin mode: click a spot in the prototype to pin a comment there. Clicks still work inside the prototype." : ""}
      </p>
      {a.kind === "flow" && <RulesTable key={variant} artifact={a} variant={variant} draft={draft} update={update} locked={locked} />}

      {draft.pins.length > 0 && <PinList artifact={a} draft={draft} update={update} locked={locked} />}
    </div>
  );
}

/**
 * The stage, and beside it the version in force when this version is the draft's change to it (pass 5, screen 2): so
 * you see what your Lock in changes. Any other version: the stage alone.
 */
function Beside({ artifact: a, device, port, children }: { artifact: StudioArtifact; device: ScreenDevice; port: number | undefined; children: ReactNode }) {
  const { state } = useStore();
  const beside = inForceBeside(state, a);
  if (!beside) return <>{children}</>;
  return (
    <div className="st-beside">
      <section className="st-beside__pane" aria-label={`v${a.version}, in the draft`}>
        <p className="st-beside__cap">
          <span>v{a.version} · in the draft</span>
        </p>
        {children}
      </section>
      <InForcePane item={beside.item} artifact={beside.artifact} rev={beside.rev} device={device} port={port} />
    </div>
  );
}

// ---------- tables: the project's dictionary and a flow's rules (pass 4d) ----------

interface TableProps {
  artifact: StudioArtifact;
  draft: Draft;
  update: ArtifactViewProps["update"];
  locked: string | undefined;
}

/** A row's mark: Keep, Change or Drop, one click each; a second click on the same mark clears it. */
function RowMarks({ label, mark, onMark, locked }: { label: string; mark: Mark | null; onMark: (m: Mark) => void; locked: string | undefined }) {
  return (
    <div className="st-rowmarks" role="group" aria-label={`Your mark on ${label}`}>
      {MARKS.map((m) => (
        <Button key={m.value} size="small" className={cx("st-mark", `st-mark--${m.value}`)} aria-pressed={mark === m.value} disabled={!!locked} disabledReason={locked} onClick={() => onMark(m.value)}>
          {m.label}
        </Button>
      ))}
    </div>
  );
}

/** Under a table: how many rows are marked, and Keep the rest in one click. */
function TableFoot({ artifact: a, draft, update, locked, rows, what }: TableProps & { rows: TableRow[]; what: string }) {
  const open = rows.filter((r) => rowMark(draft, r.row, r.variant) === null).length;
  return (
    <div className="st-tablefoot">
      <span className="small muted">
        {rows.length - open} of {plural(rows.length, what)} marked.{" "}
        {open ? `Mark each one, or keep the rest. A ${what} marked Change or Drop waits for the next version before Keep can put it in the draft.` : `Every ${what} has your mark.`}
      </span>
      {open > 0 && (
        <Button size="small" variant="quiet" disabled={!!locked} disabledReason={locked} onClick={() => update(a, (d) => keepUnmarked(d, rows))}>
          Keep the other {plural(open, what)}
        </Button>
      )}
    </div>
  );
}

/**
 * The project's dictionary as a table: each term, its one meaning and the words it replaces, with your mark on each.
 * It says whether this version is in force (locked in: the factory's agents get it), in the draft, or neither.
 */
function DictionaryTable({ artifact: a, draft, update, locked }: TableProps) {
  const { state } = useStore();
  const standing = dictionaryStanding(state, a);
  const terms = a.dictionary ?? [];
  return (
    <section className="st-table-wrap" aria-label="The project's dictionary">
      <p className="small">
        <Chip tone={standing.place === "in force" ? "done" : standing.place === "in the draft" ? "you" : "neutral"} strong={standing.place === "in force"}>
          {standing.place === "in force" ? "In force" : standing.place === "in the draft" ? "In the draft" : "Not in force"}
        </Chip>{" "}
        {standing.text}
      </p>
      <table className="st-table">
        <thead>
          <tr>
            <th scope="col">Term</th>
            <th scope="col">Meaning</th>
            <th scope="col">Words to avoid</th>
            <th scope="col" className="st-table__marks">
              Your mark
            </th>
          </tr>
        </thead>
        <tbody>
          {terms.map((e) => {
            const mark = rowMark(draft, e.term);
            return (
              <tr key={e.term} className={cx(mark && `st-row--${mark}`)}>
                <th scope="row">{e.term}</th>
                <td data-label="Meaning">{e.meaning}</td>
                <td data-label="Avoid">{e.avoid.length ? e.avoid.join(", ") : <span className="muted">none</span>}</td>
                <td className="st-table__marks">
                  <RowMarks label={`"${e.term}"`} mark={mark} locked={locked} onMark={(m) => update(a, (d) => toggleRow(d, e.term, undefined, m))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TableFoot artifact={a} draft={draft} update={update} locked={locked} rows={tableRows(a)} what="term" />
    </section>
  );
}

/**
 * A flow variant's rules (its rules.json), each with the pattern it fits and your mark, then its examples. An edge
 * case is an "If …, then …" rule, so a case nobody decided shows as a missing rule. Nothing for a flow without rules.
 */
function RulesTable({ artifact: a, variant, draft, update, locked }: TableProps & { variant: string | undefined }) {
  const set = variantRules(a, variant);
  if (!set) return null;
  const v = a.variants.length > 1 ? set.variant : undefined;
  const rows = set.rules.map((r) => ({ row: r.id, ...(v !== undefined ? { variant: v } : {}) }));
  return (
    <section className="st-table-wrap st-rules" aria-label="Rules">
      <h3 className="st-label">Rules ({set.rules.length})</h3>
      <p className="small muted">Each rule is one sentence in a fixed pattern. An edge case is an "If …, then …" rule, so a case with no rule is a case nobody decided.</p>
      <table className="st-table">
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Pattern</th>
            <th scope="col" className="st-table__marks">
              Your mark
            </th>
          </tr>
        </thead>
        <tbody>
          {set.rules.map((r) => {
            const mark = rowMark(draft, r.id, v);
            return (
              <tr key={r.id} className={cx(mark && `st-row--${mark}`)}>
                <th scope="row" className="st-rule">
                  <span className="st-rule__id">{r.id}</span> {r.text}
                </th>
                <td data-label="Pattern">
                  <Chip title={PATTERNS.find((p) => p.pattern === r.pattern)?.form}>
                    {PATTERN_NAME[r.pattern]}
                  </Chip>
                </td>
                <td className="st-table__marks">
                  <RowMarks label={`rule ${r.id}`} mark={mark} locked={locked} onMark={(m) => update(a, (d) => toggleRow(d, r.id, v, m))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TableFoot artifact={a} draft={draft} update={update} locked={locked} rows={rows} what="rule" />
      {set.examples.length > 0 && (
        <>
          <h3 className="st-label">Examples ({set.examples.length})</h3>
          <ul className="st-examples">
            {set.examples.map((x) => (
              <li key={x.id}>
                <span className="st-rule__id">{x.id}</span> {x.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
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
 * The lead's panel: its message for the round, and its questions with the answers it suggests (a suggestion fills the
 * answer box, as on ORC-012's shaping panel). Your answers go with your marks, by Send to the lead under the part, as
 * one message in the conversation the header's Message the lead opens. The panel has no message box of its own
 * (ORC-030 a-vision-two-boxes).
 */
export function LeadPanel({ round, answers, onAnswer }: { round: Round | undefined; answers: string[]; onAnswer: (i: number, text: string) => void }) {
  const { state, service, disabled } = useStore();
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
        <p className="small muted">{round ? `The lead has written nothing for round ${round.n}.` : "No round is open."}</p>
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
      {lead && lead.questions.length > 0 && <p className="micro muted">Your answers go with Send to the lead, with your marks.</p>}
    </section>
  );
}

/**
 * Overrule one of the PE's objections, with your reason (`overruleObjection`): once its review ended, on the newest
 * version. The objection stays recorded, with your reason.
 */
function OverruleObjection({ verdictId }: { verdictId: string }) {
  const { send, disabled } = useStore();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div>
        <Button size="small" disabled={disabled} disabledReason="The service is offline." onClick={() => setOpen(true)}>
          Overrule the objection
        </Button>
      </div>
    );
  }
  const blocker = disabled ? "The service is offline." : !why.trim() ? "Write your reason first." : undefined;
  const submit = async () => {
    if (blocker || busy) return;
    setBusy(true);
    const r = await send("overruleObjection", { verdictId, why: why.trim() });
    setBusy(false);
    if (r.ok) setOpen(false);
  };
  return (
    <div className="k-stack k-stack--tight">
      <Field label="Your reason" hint="The objection stays recorded, with your reason.">
        <Textarea rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <div className="k-actions">
        <Button size="small" disabled={!!blocker} disabledReason={blocker} loading={busy} onClick={() => void submit()}>
          {busy ? "Overruling…" : "Overrule"}
        </Button>
        <Button size="small" variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Ask the PE again (`askPeAgain`, B-06): it gave no verdict on this version, because it could not answer. The service asks for its run. */
function AskPeAgain({ artifact: a }: { artifact: StudioArtifact }) {
  const { send, disabled } = useStore();
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (disabled || busy) return;
    setBusy(true);
    await send("askPeAgain", { artifactId: a.id, version: a.version });
    setBusy(false);
  };
  return (
    <div>
      <Button size="small" disabled={disabled} disabledReason="The service is offline." loading={busy} onClick={() => void ask()}>
        {busy ? "Asking…" : "Ask the PE again"}
      </Button>
    </div>
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
      {!a || !view ? (
        <p className="small muted">The PE reviews each option the designer makes before it reaches you.</p>
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
          {view.verdicts.length > 0 && (
            <ul className="st-verdicts" aria-label="The PE's verdicts">
              {view.verdicts.map((v) => (
                <li key={v.id} className="st-verdict">
                  <div className="st-toolbar__grp">
                    <b className="small">{v.label}</b>
                    <Chip tone={v.tone}>{v.word}</Chip>
                    {v.overruled && <Chip>overruled</Chip>}
                  </div>
                  <p className="small muted">{v.reasons}</p>
                  {v.change && <p className="small">{v.change}</p>}
                  {v.budget && (
                    <p className="small muted">
                      Budget effect: {[v.budget.buildUsd && `building ${usdRange(v.budget.buildUsd)}`, v.budget.maintenanceUsdPerMonth && `maintenance ${usdRange(v.budget.maintenanceUsdPerMonth, true)}`].filter(Boolean).join(", ") || "no figures"}. Basis: {v.budget.basis}
                    </p>
                  )}
                  {v.overruled && <p className="small muted">You overruled it: {v.overruled.why}</p>}
                  {v.canOverrule && <OverruleObjection verdictId={v.id} />}
                </li>
              ))}
            </ul>
          )}
          {view.next && <p className="small">{view.next}</p>}
          {view.canAskAgain && <AskPeAgain artifact={a} />}
          {view.by && <p className="micro muted">PE · {view.by}</p>}
          {view.notIndependent && <p className="small">{view.notIndependent}</p>}
          <PeQuestions artifact={a} />
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
