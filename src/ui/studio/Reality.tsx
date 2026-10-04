// Design and reality (ORC-029 pass 5, screen 5; the owner chose the list with evidence), `#/results/design`: one row
// per blueprint item in force, with its name, kind, version, factory status, tasks, rule results and evidence
// thumbnails. Beside the list, the chosen item side by side: for a screen, the approved design in the studio's frames
// beside the built screenshot on each device; for a terminal demo, the demo beside the built recording; for a flow or a
// contract, each rule with its test result. The built side comes from the evidence record (its commit, design version
// and time), or says why there is none, with the log excerpt.

import { useRef, useState } from "react";
import * as B from "../../domain/studio/blueprint";
import { isCapturedKind, type CaptureDevice, type ItemEvidence } from "../../domain/studio/evidence";
import { blueprintFactoryStatus, screenDevices, type ItemFactoryView, type UxReviewOfItem } from "../../domain/studio/itemStatus";
import type { StudioArtifact } from "../../domain/studio/types";
import { Card, Chip, EmptyState, StatePill, Tabs } from "../kit";
import { designFirst } from "../resultsView";
import { useStore } from "../store";
import { ScaledBox, TerminalRecording, TerminalText, TerminalWindow, useServiceText } from "./Frames";
import { ArtifactPreview, TermsTable } from "./Preview";
import { readCast, renderAnsi } from "./ansi";
import { answerChip, baselineWhy, casesOf, partRules, testsOfPart } from "../import/importView";
import { testId } from "../../domain/studio/import";
import { NO_EVIDENCE_CLAUSE, STATUS_TONE, STATUS_WORDS, baselineOf, differenceState, evidenceCaption, evidenceFileUrl, recordingOf, ruleCell, rulesLine, shortSha, shotOf, statusWhy, taskState, taskWords } from "./realityView";
import { DEVICE_LABEL, DEVICE_SIZE, serviceFileUrl, showKind, variantDemo } from "./studioView";
import "./studio.css";

/** The two views of Results: the delivered work, and Design and reality. Each is its own address. Design and reality is first once anything is locked in (resultsView.ts). */
export function ResultsTabs({ value }: { value: "work" | "design" }) {
  const { state } = useStore();
  const work = { id: "work", label: "Delivered work" };
  const design = { id: "design", label: "Design and reality" };
  return (
    <Tabs
      label="Results"
      value={value}
      onChange={(id) => {
        location.hash = id === "design" ? "#/results/design" : "#/results";
      }}
      tabs={designFirst(state) ? [design, work] : [work, design]}
    />
  );
}

export function Reality() {
  const { state } = useStore();
  const views = blueprintFactoryStatus(state);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const detail = useRef<HTMLDivElement>(null);
  const shown = views.find((v) => v.item.id === chosen) ?? views[0];
  const dropped = B.blueprintItems(state).filter((i) => i.status === "dropped");
  const choose = (id: string) => {
    setChosen(id);
    // On a narrow screen the detail is under the list: bring it into view.
    if (window.matchMedia?.("(max-width: 860px)").matches) detail.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <div className="k-stack r-page">
      <h1>Results</h1>
      <ResultsTabs value="design" />
      {views.length === 0 ? (
        <EmptyState title="Nothing is locked in yet.">Each part of the design shows here once it is in force: Start the factory is your first Lock in.</EmptyState>
      ) : (
        <>
          <p className="small muted no-margin">
            Lock in {B.blueprintRev(state)}
            {state.blueprint.revisions.at(-1)?.lockIn?.baseline ? ", the baseline" : ""} · {views.length} part{views.length === 1 ? "" : "s"}. Each part of the design, where the factory stands on it, and the evidence beside the design. The checks decide "built and verified".
          </p>
          <div className="st-reality">
            <div className="k-stack k-stack--tight">
              <ul className="st-reality__list" aria-label="Parts of the design">
                {views.map((v) => (
                  <li key={v.item.id}>
                    <ItemRow view={v} current={v.item.id === shown.item.id} onClick={() => choose(v.item.id)} />
                  </li>
                ))}
              </ul>
              {dropped.length > 0 && <p className="small muted no-margin">Dropped, so not listed: {dropped.map((i) => `${i.title} v${i.version}`).join(", ")}.</p>}
            </div>
            <div ref={detail} className="st-reality__detail">
              <ItemDetail view={shown} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One part of the design: its name, version and kind, its status, its tasks, its rule results, and its evidence thumbnails. */
function ItemRow({ view: v, current, onClick }: { view: ItemFactoryView; current: boolean; onClick: () => void }) {
  const { state } = useStore();
  // A part of the import's baseline (ORC-032): its status and tests come from the import.
  const base = baselineOf(state, v.item);
  const status = base?.status ?? v.status;
  const rules = base ? testsOfPart(state, base.part) : rulesLine(v);
  return (
    <button type="button" className="st-bprow" aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="st-bprow__name">
        <b>{v.item.title}</b> <span className="muted">v{v.item.version}</span>
        <span className="st-bprow__kind">{v.item.kind}</span>
      </span>
      <StatePill tone={STATUS_TONE[status]} pulse={status === "being-built" && v.tasks.some((t) => t.state === "running")}>
        {STATUS_WORDS[status]}
      </StatePill>
      <span className="st-bprow__tasks">{base ? "from the import" : v.tasks.length ? v.tasks.map((t) => taskWords(t, v.item.version)).join(" · ") : "no task yet"}</span>
      {rules && <span className="st-bprow__rules">Tests: {rules}</span>}
      <Thumbs view={v} />
    </button>
  );
}

/** The row's thumbnails, as in the prototype: the design, and what was built when the factory captured it. */
function Thumbs({ view: v }: { view: ItemFactoryView }) {
  const { state } = useStore();
  if (!isCapturedKind(v.item.kind)) return null;
  const a = B.citedArtifact(state, v.item);
  const terminal = v.item.kind !== "screen";
  const variant = v.item.variant ?? a?.variants[0]?.id;
  const design = a && (terminal ? designGif(a, variant) : designShot(a, variant));
  const e = v.evidence?.status === "captured" ? v.evidence : undefined;
  const builtFile = e && (terminal ? recordingOf(e).gif : (shotOf(e, "desktop") ?? shotOf(e, "mobile")));
  return (
    <span className="st-thumbs" aria-hidden="true">
      <Thumb label="design" src={design} terminal={terminal} />
      {e && <Thumb label="built" src={builtFile && evidenceFileUrl(e, builtFile)} terminal={terminal} />}
    </span>
  );
}

function Thumb({ label, src, terminal }: { label: string; src: string | undefined; terminal: boolean }) {
  return (
    <span className={`st-thumb${terminal ? " st-thumb--term" : ""}`}>
      {src ? <img src={src} alt="" loading="lazy" /> : <i />}
      <span className="st-thumb__label">{label}</span>
    </span>
  );
}

/** The approved design's own screenshot on desktop (else its first device), when the studio took one. */
function designShot(a: StudioArtifact, variant: string | undefined): string | undefined {
  if (a.shots?.status !== "taken" || variant === undefined) return undefined;
  const shot = a.shots.shots.find((x) => x.variant === variant && x.device === "desktop") ?? a.shots.shots.find((x) => x.variant === variant);
  return shot && serviceFileUrl(a, shot.path);
}

/** The approved demo's GIF, when the service recorded one. */
function designGif(a: StudioArtifact, variant: string | undefined): string | undefined {
  const d = variantDemo(a, variant);
  return d.status === "recorded" && d.gif ? serviceFileUrl(a, d.gif) : undefined;
}

/** The chosen part, side by side: the approved design and what the factory built, or each rule with its test. */
export function ItemDetail({ view: v }: { view: ItemFactoryView }) {
  const { state } = useStore();
  const base = baselineOf(state, v.item);
  if (base) return <BaselineDetail view={v} base={base} />;
  const artifact = B.citedArtifact(state, v.item);
  const kind = artifact ? showKind(artifact) : undefined;
  return (
    <Card
      title={
        <>
          {v.item.title} <span className="muted">v{v.item.version}</span>
        </>
      }
      actions={<StatePill tone={STATUS_TONE[v.status]}>{STATUS_WORDS[v.status]}</StatePill>}
      className="st-reality__card"
    >
      <p className="small muted no-margin">{v.item.kind}</p>
      <p className="small">{statusWhy(v)}</p>
      {v.rules ? (
        <RuleTable view={v} />
      ) : kind === "dictionary" && artifact ? (
        <TermsTable artifact={artifact} />
      ) : v.item.kind === "screen" ? (
        <ScreenBeside view={v} artifact={artifact} />
      ) : isCapturedKind(v.item.kind) ? (
        <DemoBeside view={v} artifact={artifact} />
      ) : (
        <section className="st-beside__pane" aria-label="The approved design">
          <p className="st-beside__cap">
            <span>Design · v{v.item.version}, approved</span>
          </p>
          <DesignStage view={v} artifact={artifact} device="desktop" />
        </section>
      )}
      {v.uxReview && <UxReview review={v.uxReview} />}
      {v.tasks.length > 0 && (
        <section aria-label="Its tasks">
          <h3 className="st-label">Its tasks</h3>
          <ul className="st-reality__tasks small">
            {v.tasks.map((t) => (
              <li key={t.taskId}>
                <a href={`#/task/${encodeURIComponent(t.taskId)}`}>{t.taskId}</a> {t.title} · {taskState(t, v.item.version)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}

/**
 * A part of the import's baseline (ORC-032): why it stands where it does, what the import recorded of it (the
 * recording is the part's own demo, at the import's commit), and each rule with its tests and your answer.
 */
function BaselineDetail({ view: v, base }: { view: ItemFactoryView; base: NonNullable<ReturnType<typeof baselineOf>> }) {
  const { state } = useStore();
  const imp = state.studio.import!;
  const a = base.part;
  const rules = partRules(state, a);
  const tests = testsOfPart(state, a);
  const cap = imp.capture?.parts.find((p) => p.artifactId === a.id);
  const recorded = cap?.status === "captured" ? `Recorded at commit ${shortSha(imp.commit)}${imp.capture?.simulated ? " · simulated" : ""}` : `Not recorded${cap?.status === "none" ? `: ${cap.detail}` : ""}`;
  return (
    <Card
      title={
        <>
          {v.item.title} <span className="muted">v{v.item.version}</span>
        </>
      }
      actions={<StatePill tone={STATUS_TONE[base.status]}>{STATUS_WORDS[base.status]}</StatePill>}
      className="st-reality__card"
    >
      <p className="small muted no-margin">
        {v.item.kind} · from the import, Lock in 1{tests ? ` · Tests: ${tests}` : ""}
      </p>
      <p className="small">{baselineWhy(state, a, base)}</p>
      {a.kind === "dictionary" ? (
        <TermsTable artifact={a} />
      ) : (
        <section className="st-beside__pane" aria-label={isCapturedKind(a.kind) ? "The recording" : "The design"}>
          <p className="st-beside__cap">
            <span>{isCapturedKind(a.kind) ? recorded : `The design · as it is today, at commit ${shortSha(imp.commit)}`}</span>
          </p>
          <DesignStage view={v} artifact={a} device="desktop" />
        </section>
      )}
      {rules.length > 0 && (
        <section aria-label="Its rules">
          <h3 className="st-label">Its rules</h3>
          <ul className="st-reality__baserules">
            {rules.map((r) => {
              const cases = casesOf(state, r);
              const bad = cases.find((c) => c.status !== "passed");
              const chip = answerChip(state, r);
              return (
                <li key={r.id}>
                  <span className="st-rule__id">{r.id}</span>
                  <span className="k-stack k-stack--tight">
                    <span>{r.text}</span>
                    <span className="imp-ruleev">
                      {cases.length ? (
                        <>
                          <span className="micro muted s-mono imp-wrap">
                            {testId(cases[0])}
                            {cases.length > 1 ? ` +${cases.length - 1}` : ""}
                          </span>
                          <Chip tone={bad ? (bad.status === "skipped" ? "you" : "fail") : "done"}>{bad ? (bad.status === "skipped" ? "skipped" : "fails") : "passes"}</Chip>
                        </>
                      ) : (
                        <Chip tone="you">no test</Chip>
                      )}
                      {chip && <Chip tone={chip.tone}>{chip.word}</Chip>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Card>
  );
}

/** The approved design in the studio's frames, read-only. */
function DesignStage({ view: v, artifact, device }: { view: ItemFactoryView; artifact: StudioArtifact | undefined; device: CaptureDevice }) {
  const { service } = useStore();
  return (
    <div className="st-stage">
      {artifact ? (
        <ArtifactPreview artifact={artifact} variant={v.item.variant} device={device} port={service.prototypePort} />
      ) : (
        <EmptyState title="The design is not here.">The studio has no version {v.item.version} of it.</EmptyState>
      )}
    </div>
  );
}

/** A screen: on each device of the design, the approved prototype beside the built screenshot. */
function ScreenBeside({ view: v, artifact }: { view: ItemFactoryView; artifact: StudioArtifact | undefined }) {
  const { state } = useStore();
  const devices = screenDevices(state, v.item);
  const e = v.evidence && v.evidence.status !== "no-run" ? v.evidence : undefined;
  // Without screenshots, the reason is said once, beside the design on its first device.
  const shown = devices.length ? (e?.status === "captured" ? devices : devices.slice(0, 1)) : (["desktop"] as const);
  return (
    <div className="k-stack">
      {shown.map((device) => (
        <section key={device} className="st-reality__device" aria-label={`${DEVICE_LABEL[device]}: the design beside what was built`}>
          <h3 className="st-label">{DEVICE_LABEL[device]}</h3>
          <div className="st-beside st-reality__beside">
            <section className="st-beside__pane" aria-label="The approved design">
              <p className="st-beside__cap">
                <span>Design · v{v.item.version}, approved</span>
              </p>
              <DesignStage view={v} artifact={artifact} device={device} />
            </section>
            <section className="st-beside__pane" aria-label="What the factory built">
              <BuiltCaption view={v} evidence={e} />
              {e?.status === "captured" ? (
                <div className="st-stage">
                  <BuiltShot evidence={e} device={device} title={v.item.title} />
                </div>
              ) : (
                <NoEvidence view={v} />
              )}
            </section>
          </div>
        </section>
      ))}
    </div>
  );
}

/** A terminal demo or TUI: the approved demo beside the built recording. */
function DemoBeside({ view: v, artifact }: { view: ItemFactoryView; artifact: StudioArtifact | undefined }) {
  const e = v.evidence && v.evidence.status !== "no-run" ? v.evidence : undefined;
  return (
    <div className="st-beside st-reality__beside">
      <section className="st-beside__pane" aria-label="The approved demo">
        <p className="st-beside__cap">
          <span>Demo · v{v.item.version}, approved</span>
        </p>
        <DesignStage view={v} artifact={artifact} device="desktop" />
      </section>
      <section className="st-beside__pane" aria-label="What the factory built">
        <BuiltCaption view={v} evidence={e} />
        {e?.status === "captured" ? (
          <div className="st-stage st-stage--terminal">
            <BuiltRecording evidence={e} title={v.item.title} />
          </div>
        ) : (
          <NoEvidence view={v} />
        )}
      </section>
    </div>
  );
}

/** "Built · commit 1a2b3c4 · design v2 · Oct 2, 9:11 AM", "not the current design version", and what the UX review says. */
function BuiltCaption({ view: v, evidence: e }: { view: ItemFactoryView; evidence: ItemEvidence | undefined }) {
  if (!e) {
    return (
      <p className="st-beside__cap">
        <span>Built</span>
      </p>
    );
  }
  const cap = evidenceCaption(e, v.item.version);
  const open = v.uxReview?.differences.filter((d) => d.state === "open").length ?? 0;
  return (
    <p className="st-beside__cap">
      <span>{cap.text}</span>
      {cap.older && <Chip tone="you">{cap.older}</Chip>}
      {v.uxReview ? open ? <Chip tone="fail">differs: {open} open</Chip> : <Chip tone="done">matches the design</Chip> : e.status === "captured" && v.item.kind === "screen" ? <Chip>not compared yet</Chip> : null}
    </p>
  );
}

/** A built screenshot in the same frame as the design beside it: a browser window, or a phone. */
function BuiltShot({ evidence: e, device, title }: { evidence: Extract<ItemEvidence, { status: "captured" }>; device: CaptureDevice; title: string }) {
  const f = shotOf(e, device);
  if (!f) {
    const why = e.warnings?.find((w) => w.includes(device));
    return (
      <div className="st-reality__slot" role="note">
        No screenshot on {device}{why ? `: ${why}` : "."}
      </div>
    );
  }
  const size = DEVICE_SIZE[device];
  const img = <img className="st-viewport__frame st-reality__img" src={evidenceFileUrl(e, f)} alt={`${title} as built, ${device}, commit ${shortSha(e.commit)}`} />;
  if (device === "mobile") {
    return (
      <ScaledBox width={size.width + 24} height={size.height + 24} label={`${title} as built, in a phone frame`}>
        <div className="st-phone">
          <div className="st-viewport">{img}</div>
        </div>
      </ScaledBox>
    );
  }
  return (
    <ScaledBox width={size.width} height={size.height + 32} label={`${title} as built, in a browser window`}>
      <div className="st-browser">
        <div className="st-browser__bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <span className="st-browser__url">built · {shortSha(e.commit)}</span>
        </div>
        <div className="st-viewport">{img}</div>
      </div>
    </ScaledBox>
  );
}

/** The built recording of a terminal demo or TUI: its video or GIF, else its transcript. */
function BuiltRecording({ evidence: e, title }: { evidence: Extract<ItemEvidence, { status: "captured" }>; title: string }) {
  const r = recordingOf(e);
  if (r.video || r.gif) return <TerminalRecording title={`${title} as built`} video={r.video && evidenceFileUrl(e, r.video)} gif={r.gif && evidenceFileUrl(e, r.gif)} />;
  if (r.cast) return <BuiltCast url={evidenceFileUrl(e, r.cast)} title={title} />;
  if (r.transcript) return <BuiltTranscript url={evidenceFileUrl(e, r.transcript)} title={title} />;
  return (
    <div className="st-reality__slot" role="note">
      The capture kept no recording.
    </div>
  );
}

/** An asciicast the service recorded in the project's environment (unit E2), drawn as the studio draws a .cast file. */
function BuiltCast({ url, title }: { url: string; title: string }) {
  const loaded = useServiceText(url);
  if (loaded.status !== "ok") return <p className="small muted">{loaded.status === "loading" ? "Reading the recording…" : `The recording cannot be read: ${loaded.message}.`}</p>;
  const cast = readCast(loaded.text);
  if (!cast.ok) return <p className="small muted">The recording cannot be read: {cast.error}.</p>;
  return (
    <TerminalWindow title={`${title} as built — ${cast.cols}×${cast.rows}`}>
      <TerminalText lines={renderAnsi(cast.output, cast)} cols={cast.cols} rows={cast.rows} label={`Recording of ${title} as built`} />
    </TerminalWindow>
  );
}

function BuiltTranscript({ url, title }: { url: string; title: string }) {
  const loaded = useServiceText(url);
  if (loaded.status !== "ok") return <p className="small muted">{loaded.status === "loading" ? "Reading the transcript…" : `The transcript cannot be read: ${loaded.message}.`}</p>;
  return (
    <TerminalWindow title={`${title} as built — transcript`}>
      <TerminalText lines={renderAnsi(loaded.text, { cols: 100, rows: 30 })} cols={100} rows={1} label={`Transcript of ${title} as built`} />
    </TerminalWindow>
  );
}

/** Without evidence: why, from the record (with its log excerpt), or that no capture has run. */
function NoEvidence({ view: v }: { view: ItemFactoryView }) {
  const e = v.evidence;
  if (!e || e.status === "no-run") {
    const started = v.tasks.some((t) => t.state !== "queued");
    return (
      <div className="st-reality__slot" role="note">
        {started ? `No evidence yet: ${NO_EVIDENCE_CLAUSE["no-run"]}.` : "Not built yet."}
      </div>
    );
  }
  if (e.status !== "none") return null;
  return (
    <div className="st-reality__slot st-reality__slot--why" role="note">
      <p>
        <b>No evidence yet: {NO_EVIDENCE_CLAUSE[e.reason]}.</b> {e.detail}
      </p>
      {e.log && (
        <pre className="st-reality__log" aria-label="The end of the capture's log">
          {e.log}
        </pre>
      )}
    </div>
  );
}

/** What the UX review found when it compared the built part with the approved design. */
function UxReview({ review: r }: { review: UxReviewOfItem }) {
  return (
    <section className="st-reality__ux" aria-label="The UX review">
      <h3 className="st-label">The UX review ({r.taskId})</h3>
      {r.differences.length === 0 ? (
        <p className="small no-margin">It found no difference from the approved design.</p>
      ) : (
        <ul className="st-reality__diffs">
          {r.differences.map((d) => (
            <li key={d.findingId || d.title}>
              <Chip tone={d.state === "open" ? "fail" : "done"}>{d.state === "open" ? "differs" : "accepted"}</Chip>{" "}
              <b>
                {d.findingId && `${d.findingId} `}
                {d.title}
              </b>
              {d.detail !== d.title && <p className="small no-margin">{d.detail}</p>}
              <p className="micro muted no-margin">{differenceState(d)}</p>
            </li>
          ))}
        </ul>
      )}
      {r.notes.length > 0 && <p className="micro muted no-margin">Notes, not differences: {r.notes.map((n) => `${n.findingId} ${n.title}`).join(" · ")}</p>}
      {!r.ofLandedWork && <p className="micro muted no-margin">It compared work that has not landed, or an earlier commit: its differences do not decide the status.</p>}
    </section>
  );
}

/** Each rule and example of a flow, with its test result: passes, fails (with the test's message), skipped, or No test (and why). */
function RuleTable({ view: v }: { view: ItemFactoryView }) {
  return (
    <div className="st-table-wrap">
      <table className="st-table st-reality__rules">
        <thead>
          <tr>
            <th scope="col">Rule or example</th>
            <th scope="col">Test</th>
          </tr>
        </thead>
        <tbody>
          {v.rules!.results.map((r) => {
            const cell = ruleCell(r);
            return (
              <tr key={r.id}>
                <th scope="row" className="st-rule">
                  <span className="st-rule__id">{r.id}</span> {r.text}
                </th>
                <td data-label="Test">
                  <Chip tone={cell.tone}>{cell.word}</Chip>
                  {cell.detail && <p className="micro muted no-margin">{cell.detail}</p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
