// Design and reality (ORC-029 pass 5, screen 5; the owner chose the list with evidence), `#/results/design`: one row
// per blueprint item in force, with its name, kind, version, factory status, tasks and rule results. Beside the list,
// the chosen item side by side: the approved design in the studio's frames, and what the factory built (its captured
// evidence, or a slot that says there is none yet), or each rule of a flow with its test result.

import { useRef, useState } from "react";
import * as B from "../../domain/studio/blueprint";
import { blueprintFactoryStatus, type ItemFactoryView } from "../../domain/studio/itemStatus";
import { Card, Chip, EmptyState, StatePill, Tabs } from "../kit";
import { useStore } from "../store";
import { ArtifactPreview, TermsTable } from "./Preview";
import { NO_EVIDENCE, STATUS_TONE, STATUS_WORDS, builtEvidence, ruleCell, rulesLine, statusWhy, taskState, taskWords, type BuiltEvidence } from "./realityView";
import { deviceOptions, showKind } from "./studioView";
import "./studio.css";

/** The two views of Results: the delivered work, and Design and reality. Each is its own address. */
export function ResultsTabs({ value }: { value: "work" | "design" }) {
  return (
    <Tabs
      label="Results"
      value={value}
      onChange={(id) => {
        location.hash = id === "design" ? "#/results/design" : "#/results";
      }}
      tabs={[
        { id: "work", label: "Delivered work" },
        { id: "design", label: "Design and reality" },
      ]}
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
            Lock in {B.blueprintRev(state)} · {views.length} part{views.length === 1 ? "" : "s"}. Each part of the design, where the factory stands on it, and the evidence beside the design. The checks decide "built and verified".
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

/** One part of the design: its name, version and kind, its status, its tasks, and its rule results. */
function ItemRow({ view: v, current, onClick }: { view: ItemFactoryView; current: boolean; onClick: () => void }) {
  const rules = rulesLine(v);
  return (
    <button type="button" className="st-bprow" aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="st-bprow__name">
        <b>{v.item.title}</b> <span className="muted">v{v.item.version}</span>
        <span className="st-bprow__kind">{v.item.kind}</span>
      </span>
      <StatePill tone={STATUS_TONE[v.status]} pulse={v.status === "being-built" && v.tasks.some((t) => t.state === "running")}>
        {STATUS_WORDS[v.status]}
      </StatePill>
      <span className="st-bprow__tasks">{v.tasks.length ? v.tasks.map((t) => taskWords(t, v.item.version)).join(" · ") : "no task yet"}</span>
      {rules && <span className="st-bprow__rules">Tests: {rules}</span>}
    </button>
  );
}

/** The chosen part, side by side: the approved design and what the factory built, or each rule with its test. */
export function ItemDetail({ view: v }: { view: ItemFactoryView }) {
  const { state, service } = useStore();
  const artifact = B.citedArtifact(state, v.item);
  const kind = artifact ? showKind(artifact) : undefined;
  const built = builtEvidence(state, v.item.id);
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
      ) : (
        <div className="st-beside">
          <section className="st-beside__pane" aria-label="The approved design">
            <p className="st-beside__cap">
              <span>Design · v{v.item.version}, approved</span>
            </p>
            <div className="st-stage">
              {artifact ? (
                <ArtifactPreview artifact={artifact} variant={v.item.variant} device={deviceOptions(state.project.devices, artifact)[0] ?? "desktop"} port={service.prototypePort} />
              ) : (
                <EmptyState title="The design is not here.">The studio has no version {v.item.version} of it.</EmptyState>
              )}
            </div>
          </section>
          <section className="st-beside__pane" aria-label="What the factory built">
            <p className="st-beside__cap">
              <span>Built</span>
            </p>
            <BuiltSlot evidence={built} title={v.item.title} />
          </section>
        </div>
      )}
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

/** What the factory captured of the built part, or the slot that says it has captured nothing yet. */
function BuiltSlot({ evidence, title }: { evidence: BuiltEvidence | undefined; title: string }) {
  if (!evidence) {
    return (
      <div className="st-reality__slot" role="note">
        {NO_EVIDENCE}
      </div>
    );
  }
  return evidence.kind === "screenshot" ? (
    <img className="st-reality__shot" src={evidence.url} alt={`${title} as built, captured on commit ${evidence.commit.slice(0, 12)}`} />
  ) : (
    <video className="st-reality__shot" src={evidence.url} controls muted aria-label={`${title} as built, recorded on commit ${evidence.commit.slice(0, 12)}`} />
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
