// The vision text (ORC-030 C1, the owner's choice: "the vision text lives in Vision"). At the top of Vision, the card
// "The vision": the text and its focus, its editor, the lead's draft of it and the lead's questions about it, and,
// one click away, its history, its documents and what is clear so far. Home keeps one line of it (VisionLine), with a
// link here. Every "vision" link opens Vision.
//
// While the factory runs, the editor works on the draft's text (ORC-029 pass 5): the factory builds from the text in
// force until the owner's next Lock in, and both texts show while they differ. In Vision, an edit goes into force at
// once. Every save is compare-and-set on the revision the editor started from.

import { useEffect, useRef, useState } from "react";
import { diffLines } from "../../domain/diff";
import * as M from "../../domain/model";
import type { State, VisionRevision } from "../../domain/types";
import { fmtTime, relTime } from "../common";
import { Banner, Button, ButtonLink, Card, Chip, Disclosure, Field, Input, Textarea } from "../kit";
import { historyRequested } from "../route";
import { CoverageChecklist, OpenDraft, QuestionsForm, coverageCount } from "../Shaping";
import { StartFactoryLink } from "../preflight/StartFactoryLink";
import { useStore } from "../store";
import { RevisionDocs, VisionDocsList } from "../VisionDocs";
import { LOCK_IN_HASH } from "./Draft";
import "./studio.css";

/** Who made a vision revision and from what, in a few words (the history list). */
export function revisionSource(v: VisionRevision): string {
  if (v.source?.undoOf) return `${v.author} · undo of the lead's change`;
  if (v.source?.draftId) return `${v.author} · accepted the lead's draft`;
  if (v.source?.docsAdded) return `${v.author} · attached ${v.source.docsAdded.length} document${v.source.docsAdded.length === 1 ? "" : "s"}${v.source.docsRemoved?.length ? " (replacing earlier copies)" : ""}`;
  if (v.source?.docAdded) return `${v.author} · ${v.source.docRemoved ? "replaced a document" : "attached a document"}`;
  if (v.source?.docRemoved) return `${v.author} · removed a document`;
  if (v.source?.changeSetId) return v.author === "lead" ? "lead · from your message" : `${v.author} · applied the lead's suggestion`;
  return v.author;
}

/** The card's line about the text in force: "r3, by you, 2 h ago", "r4, by the lead, just now". */
export function revisionMeta(v: VisionRevision): string {
  const by = v.author === "user" ? "you" : v.author === "lead" ? "the lead" : v.author;
  return `r${v.rev}, by ${by}, ${relTime(v.at)}`;
}

/** The editor's hint while the factory runs: where an edit of the text goes, and where the focus goes. */
export const VISION_DRAFT_HINT = "The factory runs, so your edit of the text goes into the draft, not into force. It goes into force with your next Lock in. A new focus applies at once.";

/**
 * The vision text the editor works on (the draft's while building, `draftVisionText`), and, when an edit of it waits
 * in the draft, why and until when.
 */
export function visionDraftWords(s: State): { building: boolean; text: string; waiting?: string } {
  const building = s.project.stage === "building";
  const dv = s.blueprint.draft.vision;
  return { building, text: M.draftVisionText(s), ...(building && dv ? { waiting: `"${dv.reason}". It goes into force with your next Lock in. Until then the factory builds from the text in force.` } : {}) };
}

/** A text longer than this shows its first lines, with Show all. */
const LONG_TEXT = { lines: 4, chars: 360 };
export const isLongText = (t: string) => t.split("\n").length > LONG_TEXT.lines || t.length > LONG_TEXT.chars;

/** Home's line of the vision: its first line, shortened to about one line of text. "" when nothing is written. */
export function visionLine(s: State): string {
  const first = M.currentVision(s).text.trim().split("\n").find((l) => l.trim()) ?? "";
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
}

/** The reason a hand edit records when the owner writes none. */
export const HAND_EDIT_REASON = "Written by hand in Vision";

/** The card at the top of Vision: the vision text, its editor, the lead's draft and questions, its history and documents. */
export function VisionCard() {
  const { state } = useStore();
  const vision = M.currentVision(state);
  const draft = visionDraftWords(state);
  const shaping = state.project.stage === "shaping";
  const asked = shaping ? M.latestQuestions(state) : undefined;
  const docs = M.currentVisionDocs(state);
  const clear = coverageCount(state);
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  // A link to the history (`#/vision?history=1`) opens it.
  const [history, setHistory] = useState(() => typeof location !== "undefined" && historyRequested(location.hash));
  const text = draft.waiting ? draft.text : vision.text;
  const long = isLongText(text);
  return (
    <Card
      id="vision-text"
      title="The vision"
      className="st-vision"
      actions={
        <>
          {vision.text.trim() && <span className="small muted">{revisionMeta(vision)}</span>}
          {!editing && (
            <Button size="small" onClick={() => setEditing(true)}>
              {vision.text.trim() ? (draft.waiting ? "Edit the draft's text" : "Edit") : "Write the vision"}
            </Button>
          )}
        </>
      }
    >
      <div className="k-stack k-stack--tight">
        <OpenDraft />
        {editing ? (
          <VisionEditor onDone={() => setEditing(false)} />
        ) : draft.waiting ? (
          <>
            <Banner
              tone="you"
              title="Your edit of the vision text waits in the draft."
              actions={
                <ButtonLink size="small" href={LOCK_IN_HASH}>
                  Lock in…
                </ButtonLink>
              }
            >
              {draft.waiting}
            </Banner>
            <p className="small muted no-margin">In the draft:</p>
            <p className="vision-text">{draft.text}</p>
            <p className="small muted no-margin">In force (r{vision.rev}), what the factory builds from:</p>
            <p className="vision-text muted">{vision.text}</p>
          </>
        ) : vision.text.trim() ? (
          <div className="st-vision__text">
            <p className={long && !full ? "vision-text st-vision__clamp" : "vision-text"}>{vision.text}</p>
            {long && (
              <Button size="small" variant="quiet" aria-expanded={full} onClick={() => setFull(!full)}>
                {full ? "Show less" : "Show all"}
              </Button>
            )}
          </div>
        ) : (
          <p className="muted no-margin">
            {/* An open draft that answers no message is the import's (UX-R2-2). */}
            {M.openVisionDraft(state)?.messageIds.length === 0 ? "Not written yet. The lead's draft above comes from the import: accept it, edit it, or write your own." : "Not written yet. Tell the lead what you want to build, or write it yourself."}
          </p>
        )}
        {!editing && (
          <p className="small no-margin">
            <span className="muted">Focus:</span> {vision.focus || <span className="muted">none</span>}
          </p>
        )}
        <div className="st-vision__more">
          {/* The lead's questions about the vision (from the conversation), answerable here, one click away so the studio stays near the top. */}
          {asked && (
            <Disclosure label="The lead's questions" count={asked.questions.length}>
              <QuestionsForm key={asked.message.id} questions={asked.questions} />
            </Disclosure>
          )}
          <Disclosure label="History" count={state.project.visions.length} open={history} onToggle={setHistory}>
            <VisionHistory state={state} scrollTo={history && typeof location !== "undefined" && historyRequested(location.hash)} />
          </Disclosure>
          <Disclosure label="Documents" count={docs.length}>
            <VisionDocsList />
          </Disclosure>
          {shaping && (
            <Disclosure label={clear ? `What is clear: ${clear}` : "What is clear"}>
              <CoverageChecklist state={state} />
            </Disclosure>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * The editor: the text (the draft's while the factory runs), the focus and the reason. A save is compare-and-set on
 * the revision it started from; when the vision (or the draft's text) moved meanwhile, it says so and keeps your text.
 */
function VisionEditor({ onDone }: { onDone: () => void }) {
  const { state, send, disabled } = useStore();
  const vision = M.currentVision(state);
  const draft = visionDraftWords(state);
  const [saving, setSaving] = useState(false);
  // The vision revision the edit started from; saving against it lets the service reject a stale edit. While building,
  // the text it started from is the draft's: a change to the draft's text meanwhile is stale too.
  const [baseRev, setBaseRev] = useState(vision.rev);
  const [baseText, setBaseText] = useState(draft.text);
  const staleRev = !saving && vision.rev !== baseRev;
  const staleText = !saving && !staleRev && draft.building && draft.text !== baseText;
  const [text, setText] = useState(draft.text);
  const [focus, setFocus] = useState(vision.focus);
  const [reason, setReason] = useState("");
  const load = () => {
    setText(draft.text);
    setFocus(vision.focus);
    setBaseRev(vision.rev);
    setBaseText(draft.text);
  };
  return (
    <form
      className="k-stack k-stack--tight"
      aria-label="Edit the vision"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        // A 409 keeps the form open with the text; the notice explains the conflict.
        const r = await send("editVision", { expectedRev: baseRev, text, focus, reason: reason.trim() || HAND_EDIT_REASON });
        setSaving(false);
        if (r.ok) onDone();
      }}
    >
      {staleRev && (
        <Banner
          tone="fail"
          title={`The vision changed to r${vision.rev} while you were editing`}
          actions={
            <>
              <Button size="small" onClick={() => (setBaseRev(vision.rev), setBaseText(draft.text))}>
                Save over r{vision.rev} anyway
              </Button>
              <Button size="small" onClick={load}>
                Discard my edit and load r{vision.rev}
              </Button>
            </>
          }
        >
          {vision.author}: {vision.reason}. Your text is kept.
        </Banner>
      )}
      {staleText && (
        <Banner
          tone="fail"
          title="The vision text in the draft changed while you were editing"
          actions={
            <>
              <Button size="small" onClick={() => setBaseText(draft.text)}>
                Save over it anyway
              </Button>
              <Button size="small" onClick={load}>
                Discard my edit and load it
              </Button>
            </>
          }
        >
          Your edit is kept.
        </Banner>
      )}
      <Field label={draft.building ? "Vision (the draft's text)" : "Vision"} hint={draft.building ? VISION_DRAFT_HINT : undefined}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} />
      </Field>
      <Field label="Current focus">
        <Input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
      </Field>
      <Field label="Reason for the change (recorded)" hint={`Empty: "${HAND_EDIT_REASON}".`}>
        <Input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="k-actions">
        <Button type="submit" variant="primary" disabled={disabled || saving || staleRev || staleText || !text.trim()} loading={saving}>
          {saving ? "Saving…" : draft.building && text !== draft.text ? "Save to the draft" : `Save as r${vision.rev + 1}`}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What changed from the previous revision, then every revision, newest first, with its documents. */
function VisionHistory({ state, scrollTo }: { state: State; scrollTo: boolean }) {
  const vision = M.currentVision(state);
  const visions = state.project.visions;
  const prev = visions.length > 1 ? visions[visions.length - 2] : undefined;
  const diff = prev ? diffLines([`Focus: ${prev.focus}`, ...prev.text.split("\n")], [`Focus: ${vision.focus}`, ...vision.text.split("\n")]).filter((d) => d.kind !== "same") : [];
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (scrollTo) ref.current?.scrollIntoView({ block: "start" });
  }, [scrollTo]);
  return (
    <div className="k-stack k-stack--tight">
      {prev && diff.length > 0 && (
        <Disclosure label={`What changed from r${prev.rev}: ${vision.reason}`}>
          <div className="diff" aria-label={`Differences between r${prev.rev} and r${vision.rev}`}>
            {diff.map((d, i) => (
              <div key={i} className={d.kind}>
                {d.text}
              </div>
            ))}
          </div>
        </Disclosure>
      )}
      <ul className="events" ref={ref} id="vision-history" aria-label="Vision history">
        {[...visions].reverse().map((r) => (
          <li key={r.rev}>
            <span className="mono">r{r.rev}</span>
            <span className="actor">{revisionSource(r)}</span>
            <span>
              {r.reason} <span className="muted">· focus: “{r.focus}” · {fmtTime(r.at)}</span> <RevisionDocs state={state} rev={r} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Home's line of the vision (ORC-030 C1): its first line and Open Vision. When the lead drafted a new vision, it says
 * so, since that waits for you in Vision. While in Vision (the stage), the quiet way to the pre-flight too.
 */
export function VisionLine() {
  const { state } = useStore();
  const line = visionLine(state);
  const drafted = !!M.openVisionDraft(state);
  return (
    <section className="k-card st-visionline" aria-labelledby="st-visionline-h">
      <h2 id="st-visionline-h" className="st-label st-visionline__label">
        Vision
      </h2>
      <p className="st-visionline__text">{line || <span className="muted">Not written yet.</span>}</p>
      <div className="k-actions st-visionline__actions">
        {drafted && <Chip tone="you">The lead drafted a new vision</Chip>}
        <ButtonLink size="small" href="#/vision">
          Open Vision
        </ButtonLink>
        <StartFactoryLink variant="quiet" size="small" />
      </div>
    </section>
  );
}
