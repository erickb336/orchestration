// ORC-018 §4: the Compare page. Finished tasks grouped by the pattern (and version) they ran, each measure
// as a median, a spread and a dot per task. No colour means better or worse here: the state hues are for
// states, and these are not states. The data comes from the domain's pure `compareRows` and `groupRows`;
// everything the page decides on its own lives in `compareView.ts`.

import { useMemo, useState, type ReactNode } from "react";
import { DEFAULT_FILTER, MEASURES, TOO_FEW, compareRows, groupRows, toCSV, toJSON, type CompareFilter, type CompareGroup, type CompareRow, type MeasureDef, type MeasureId, type MeasureStat } from "../domain/compare";
import type { ChosenBy } from "../domain/types";
import { useNarrow } from "./common";
import {
  CHOSEN_BY_LABEL,
  MEASURES_KEY,
  STRIP,
  TOO_FEW_LINE,
  TOO_FEW_TEXT,
  areaOptions,
  cellText,
  chosenByOptions,
  columnScale,
  dateBounds,
  defaultMeasureIds,
  dotX,
  encodeMeasures,
  exportFilename,
  fmtDate,
  fmtValue,
  groupCount,
  measureDef,
  readStoredMeasures,
  sideBySideLines,
  sourceText,
  versionChip,
  type Scale,
} from "./compareView";
import { useStore } from "./store";

export const EMPTY_TEXT = "No finished tasks with an outcome yet. Each task records how it went when it finishes or is cancelled; they will appear here, grouped by the pattern they ran.";
export const UNAVAILABLE_TEXT = "Comparison is not available in this build.";

export function Compare() {
  const { state, service, setNotice } = useStore();
  const demo = service.runtime === "fake" || state.project.sample;
  const [filter, setFilter] = useState<CompareFilter>(DEFAULT_FILTER);
  // The domain functions are the one source; a build without them (or a bug in them) shows a plain notice, never a blank page.
  const data = useMemo(() => {
    try {
      const rows = compareRows(state);
      const groups = groupRows(state, rows, filter);
      return { ok: true as const, rows, groups };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [state, filter]);
  const download = (kind: "csv" | "json") => {
    if (!data.ok) return;
    const rows = data.groups.flatMap((g) => g.rows);
    let text: string;
    try {
      text = kind === "csv" ? toCSV(rows) : toJSON(rows, filter, demo, new Date().toISOString());
    } catch {
      setNotice({ kind: "error", message: "The export is not available in this build." });
      return;
    }
    downloadText(exportFilename(kind, new Date()), kind === "csv" ? "text/csv;charset=utf-8" : "application/json", text);
  };
  return (
    <>
      <div className="compare-head">
        <h1>Compare patterns</h1>
        <p className="muted">How each pattern's tasks went: medians, spreads and every task as a dot. Small groups are marked; nothing here declares a winner.</p>
      </div>
      {demo && (
        <div className="banner neutral" role="note">
          Simulated outcomes, made by the demo to show this page. They say nothing about real patterns.
        </div>
      )}
      {data.ok ? (
        <CompareContent rows={data.rows} groups={data.groups} filter={filter} setFilter={setFilter} onDownload={download} />
      ) : (
        <div className="card compare-empty" role="status">
          <p style={{ margin: 0 }}>{UNAVAILABLE_TEXT}</p>
          <details className="how" style={{ margin: "0.4rem 0 0" }}>
            <summary>Details</summary>
            <p className="mono">{data.error}</p>
          </details>
        </div>
      )}
    </>
  );
}

/** A Blob download built in the browser (design §3.5): nothing goes through the service. */
function downloadText(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The chosen measures, kept in the browser under `orc.compare.measures`; storage may be blocked, so every access is guarded. */
function useMeasures(rows: CompareRow[]): [MeasureId[], (ids: MeasureId[]) => void, () => void] {
  const [chosen, setChosen] = useState<MeasureId[] | null>(() => {
    try {
      return readStoredMeasures(window.localStorage.getItem(MEASURES_KEY));
    } catch {
      return null;
    }
  });
  const measures = chosen ?? defaultMeasureIds(rows);
  const set = (ids: MeasureId[]) => {
    setChosen(ids);
    try {
      window.localStorage.setItem(MEASURES_KEY, encodeMeasures(ids));
    } catch {
      /* storage blocked: the choice lasts for this page */
    }
  };
  const reset = () => {
    setChosen(null);
    try {
      window.localStorage.removeItem(MEASURES_KEY);
    } catch {
      /* ignore */
    }
  };
  return [measures, set, reset];
}

export interface CompareContentProps {
  /** Every row (the filter options come from these). */
  rows: CompareRow[];
  /** The filtered groups, in the domain's order. */
  groups: CompareGroup[];
  filter: CompareFilter;
  setFilter: (f: CompareFilter) => void;
  onDownload: (kind: "csv" | "json") => void;
  /** Tests: start with these groups selected (at most two) and these open. */
  initialSelected?: string[];
  initialOpen?: string[];
}

/** The toolbar, the side-by-side panel and the groups table or cards. Store-free, so it can be rendered with a fixture. */
export function CompareContent({ rows, groups, filter, setFilter, onDownload, initialSelected = [], initialOpen = [] }: CompareContentProps) {
  const narrow = useNarrow("(max-width: 700px)");
  const [measures, setMeasures, resetMeasures] = useMeasures(rows);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(initialSelected.slice(0, 2));
  const [openKeys, setOpenKeys] = useState<string[]>(initialOpen);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // A group that left with a filter change leaves the selection too.
  const selected = selectedKeys.filter((k) => groups.some((g) => g.key === k));
  const toggleSelected = (key: string, on: boolean) => setSelectedKeys(on ? [...selected, key].slice(-2) : selected.filter((k) => k !== key));
  const toggleOpen = (key: string) => setOpenKeys(openKeys.includes(key) ? openKeys.filter((k) => k !== key) : [...openKeys, key]);
  const defs = measures.map(measureDef);
  const scales = useMemo(() => Object.fromEntries(measures.map((id) => [id, columnScale(groups, id)])) as Partial<Record<MeasureId, Scale>>, [groups, measures]);
  const pair = selected.length === 2 ? selected.map((k) => groups.find((g) => g.key === k)!) : null;

  if (rows.length === 0) {
    return (
      <div className="card compare-empty" role="status">
        <p style={{ margin: 0 }}>{EMPTY_TEXT}</p>
      </div>
    );
  }

  const resultKey = filter.results.includes("done") ? (filter.results.includes("cancelled") ? "all" : "done") : "cancelled";
  const setDates = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
    const b = dateBounds(f, t);
    setFilter({ ...filter, from: b.from, to: b.to });
  };

  return (
    <>
      <div className="toolbar compare-toolbar" role="group" aria-label="Filters">
        <label>
          Area
          <select value={filter.areas[0] ?? ""} onChange={(e) => setFilter({ ...filter, areas: e.target.value ? [e.target.value] : [] })}>
            <option value="">All</option>
            {areaOptions(rows).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Result
          <select value={resultKey} onChange={(e) => setFilter({ ...filter, results: e.target.value === "all" ? ["done", "cancelled"] : e.target.value === "cancelled" ? ["cancelled"] : ["done"] })}>
            <option value="done">Done</option>
            <option value="all">Done and cancelled</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label>
          Chosen by
          <select value={filter.chosenBy[0] ?? ""} onChange={(e) => setFilter({ ...filter, chosenBy: e.target.value ? [e.target.value as ChosenBy] : [] })}>
            <option value="">Anyone</option>
            {chosenByOptions(rows).map((c) => (
              <option key={c} value={c}>
                {CHOSEN_BY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={from} max={to || undefined} onChange={(e) => setDates(e.target.value, to)} />
        </label>
        <label>
          To
          <input type="date" value={to} min={from || undefined} onChange={(e) => setDates(from, e.target.value)} />
        </label>
        <label title="Tasks whose pattern was changed after runs had started are left out by default: their numbers belong to no one pattern">
          <input type="checkbox" checked={filter.includeChanged} onChange={(e) => setFilter({ ...filter, includeChanged: e.target.checked })} />
          Include tasks that changed pattern
        </label>
        <label title="Group every version of a pattern together; the group then says it mixes versions">
          <input type="checkbox" checked={filter.mergeVersions} onChange={(e) => setFilter({ ...filter, mergeVersions: e.target.checked })} />
          Merge versions
        </label>
        <details className="measures-menu">
          <summary>Measures…</summary>
          <fieldset className="measures-pop plain-fieldset">
            <legend className="sr-only">Measures to show</legend>
            {MEASURES.map((m) => (
              <label key={m.id} className="row" title={m.help}>
                <input type="checkbox" checked={measures.includes(m.id)} onChange={(e) => setMeasures(e.target.checked ? [...measures, m.id] : measures.filter((id) => id !== m.id))} />
                <span>{m.label}</span>
              </label>
            ))}
            <div className="row" style={{ marginTop: "0.4rem" }}>
              <button type="button" className="small" onClick={resetMeasures}>
                Default measures
              </button>
            </div>
          </fieldset>
        </details>
        <span className="compare-downloads">
          <button type="button" className="small" onClick={() => onDownload("csv")} title="The filtered rows, every measure, as RFC 4180 CSV">
            Download CSV
          </button>
          <button type="button" className="small" onClick={() => onDownload("json")} title="The filtered rows with the filter and the date, as JSON">
            Download JSON
          </button>
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="muted" role="status">
          No finished tasks match these filters.
        </p>
      ) : (
        <>
          {pair && <SideBySide a={pair[0]} b={pair[1]} measures={measures} narrow={narrow} onClear={() => setSelectedKeys([])} />}
          {measures.length === 0 && (
            <p className="muted" role="status">
              No measure is chosen. Pick some under Measures….
            </p>
          )}
          {narrow ? (
            <ul className="compare-cards">
              {groups.map((g) => (
                <GroupCard key={g.key} g={g} defs={defs} scales={scales} selected={selected.includes(g.key)} selectable={selected.length < 2} open={openKeys.includes(g.key)} onSelect={(on) => toggleSelected(g.key, on)} onToggleOpen={() => toggleOpen(g.key)} />
              ))}
            </ul>
          ) : (
            <div className="table-wrap">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Select to compare</span>
                    </th>
                    <th scope="col">Pattern</th>
                    {defs.map((def) => (
                      <th scope="col" key={def.id} title={def.help} className="measure">
                        {def.label}
                        <span className="sr-only">. {def.help}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRow key={g.key} g={g} defs={defs} scales={scales} selected={selected.includes(g.key)} selectable={selected.length < 2} open={openKeys.includes(g.key)} onSelect={(on) => toggleSelected(g.key, on)} onToggleOpen={() => toggleOpen(g.key)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

interface GroupProps {
  g: CompareGroup;
  defs: MeasureDef[];
  scales: Partial<Record<MeasureId, Scale>>;
  selected: boolean;
  selectable: boolean;
  open: boolean;
  onSelect: (on: boolean) => void;
  onToggleOpen: () => void;
}

const tasksId = (key: string) => `cmp-tasks-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** The checkbox: at most two groups, so the third is disabled with the reason in its title. */
function SelectBox({ g, selected, selectable, onSelect }: Pick<GroupProps, "g" | "selected" | "selectable" | "onSelect">) {
  const v = versionChip(g);
  return (
    <input
      type="checkbox"
      checked={selected}
      disabled={!selected && !selectable}
      onChange={(e) => onSelect(e.target.checked)}
      aria-label={`Select ${g.name} (${v.text}) to compare`}
      title={!selected && !selectable ? "Two groups are selected already; clear one first" : "Select to compare (at most two)"}
    />
  );
}

function GroupChips({ g }: { g: CompareGroup }) {
  const v = versionChip(g);
  return (
    <span className="compare-chips">
      <span className="chip mono" title={v.title}>
        {v.text}
      </span>
      <span className="chip" title="Where the pattern file comes from">
        {sourceText(g.source)}
      </span>
      {g.experimental && (
        <span className="chip" title="An experimental pattern, chosen by you">
          experiment
        </span>
      )}
      {g.tooFew && (
        <span className="chip" title={`Fewer than ${TOO_FEW} tasks: the medians and spreads of so few say little`}>
          {TOO_FEW_TEXT}
        </span>
      )}
    </span>
  );
}

function OpenButton({ g, open, onToggleOpen }: Pick<GroupProps, "g" | "open" | "onToggleOpen">) {
  return (
    <button type="button" className="link" aria-expanded={open} aria-controls={tasksId(g.key)} onClick={onToggleOpen}>
      {open ? "Hide tasks" : "Show tasks"}
    </button>
  );
}

function GroupRow({ g, defs, scales, selected, selectable, open, onSelect, onToggleOpen }: GroupProps) {
  return (
    <>
      <tr className={selected ? "selected" : undefined}>
        <td className="sel">
          <SelectBox g={g} selected={selected} selectable={selectable} onSelect={onSelect} />
        </td>
        <td className="who">
          <div className="compare-name">{g.name}</div>
          <GroupChips g={g} />
          <div className="compare-n muted">
            <span className="num">{groupCount(g)}</span> · <OpenButton g={g} open={open} onToggleOpen={onToggleOpen} />
          </div>
        </td>
        {defs.map((def) => (
          <td key={def.id} className="measure">
            <Cell def={def} stat={g.stats[def.id]} scale={scales[def.id]} />
          </td>
        ))}
      </tr>
      {open && (
        <tr className="compare-tasks-row">
          <td colSpan={2 + defs.length}>
            <TaskList g={g} defs={defs} narrow={false} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Phones: the same group as a card with a definition list of measures. */
function GroupCard({ g, defs, scales, selected, selectable, open, onSelect, onToggleOpen }: GroupProps) {
  return (
    <li className={`compare-card${selected ? " selected" : ""}`}>
      <div className="compare-card-head">
        <SelectBox g={g} selected={selected} selectable={selectable} onSelect={onSelect} />
        <div className="compare-card-title">
          <div className="compare-name">{g.name}</div>
          <GroupChips g={g} />
          <div className="compare-n muted">
            <span className="num">{groupCount(g)}</span> · <OpenButton g={g} open={open} onToggleOpen={onToggleOpen} />
          </div>
        </div>
      </div>
      <dl className="compare-dl">
        {defs.map((def) => (
          <div key={def.id} className="compare-dl-row">
            <dt title={def.help}>{def.label}</dt>
            <dd>
              <Cell def={def} stat={g.stats[def.id]} scale={scales[def.id]} />
            </dd>
          </div>
        ))}
      </dl>
      {open && <TaskList g={g} defs={defs} narrow />}
    </li>
  );
}

/** One cell: the median, the spread, "n of m reported", and the strip; "—" with its title when nothing was reported. */
function Cell({ def, stat, scale }: { def: MeasureDef; stat: MeasureStat; scale?: Scale }) {
  const c = cellText(def, stat);
  if (c.missing) {
    return (
      <span className="cell-missing" title={c.title}>
        —
      </span>
    );
  }
  return (
    <div className="cell" title={c.title}>
      <span className="cell-main num">{c.main}</span>
      {c.spread && <span className="cell-spread num">{c.spread}</span>}
      {c.reported && <span className="cell-reported">{c.reported}</span>}
      {c.fewHere && <span className="cell-reported">too few to compare</span>}
      {def.unit === "rate" ? <RateBar count={stat.count ?? 0} n={stat.n} /> : scale && <DotStrip values={stat.values} median={stat.median ?? stat.values[0]} scale={scale} />}
    </div>
  );
}

/** 96 × 14: one dot per task on the column's shared scale, the median as a 2 px tick. Decorative: the numbers are in the text beside it. */
function DotStrip({ values, median, scale }: { values: number[]; median: number; scale: Scale }) {
  const xs = dotX(values, scale);
  const mx = dotX([median], scale)[0];
  const { width, height, dotRadius } = STRIP;
  return (
    <svg className="strip" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      {xs.map((x, i) => (
        <circle key={i} className="dot" cx={x} cy={height / 2} r={dotRadius} />
      ))}
      <rect className="tick" x={mx - 1} y={1} width={2} height={height - 2} rx={1} />
    </svg>
  );
}

/** A rate: a thin bar, filled to count / n. */
function RateBar({ count, n }: { count: number; n: number }) {
  const { width, height } = STRIP;
  const w = n > 0 ? (count / n) * width : 0;
  return (
    <svg className="strip rate" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      <rect className="track" x={0} y={height / 2 - 2} width={width} height={4} rx={2} />
      {w > 0 && <rect className="fill" x={0} y={height / 2 - 2} width={w} height={4} rx={2} />}
    </svg>
  );
}

/** Two groups, measure by measure, on one shared scale. Position and label tell the sides apart; never colour. */
function SideBySide({ a, b, measures, narrow, onClear }: { a: CompareGroup; b: CompareGroup; measures: MeasureId[]; narrow: boolean; onClear: () => void }) {
  const lines = sideBySideLines(a, b, measures);
  const head = (g: CompareGroup) => (
    <>
      <span className="compare-name">{g.name}</span>
      <GroupChips g={g} />
      <span className="muted num small">{groupCount(g)}</span>
    </>
  );
  return (
    <section className="card compare-side" aria-labelledby="side-h">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h2 id="side-h" style={{ margin: 0 }}>
          Side by side
        </h2>
        <button type="button" className="small" onClick={onClear}>
          Clear selection
        </button>
      </div>
      {narrow ? (
        <ul className="side-stack">
          {lines.map((l) => (
            <li key={l.def.id}>
              <div className="side-label" title={l.def.help}>
                {l.def.label}
                {l.tooFew && <span className="side-note muted">{TOO_FEW_LINE}</span>}
              </div>
              <div className="side-pair">
                <div className="side-cell">
                  <span className="side-who">{a.name}</span>
                  <Cell def={l.def} stat={l.a} scale={l.scale} />
                </div>
                <div className="side-cell">
                  <span className="side-who">{b.name}</span>
                  <Cell def={l.def} stat={l.b} scale={l.scale} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="table-wrap">
          <table className="side-table">
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">{head(a)}</th>
                <th scope="col">{head(b)}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.def.id}>
                  <th scope="row" title={l.def.help}>
                    {l.def.label}
                    {l.tooFew && <span className="side-note muted">{TOO_FEW_LINE}</span>}
                  </th>
                  <td className="measure">
                    <Cell def={l.def} stat={l.a} scale={l.scale} />
                  </td>
                  <td className="measure">
                    <Cell def={l.def} stat={l.b} scale={l.scale} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A group opened: its tasks, each linked, with the settled date and the visible measures. */
function TaskList({ g, defs, narrow }: { g: CompareGroup; defs: MeasureDef[]; narrow: boolean }) {
  const link = (r: CompareRow): ReactNode => (
    <a href={`#/task/${encodeURIComponent(r.taskId)}`}>
      <span className="mono">{r.taskId}</span> {r.title}
    </a>
  );
  const flags = (r: CompareRow) => (
    <>
      {r.result === "cancelled" && <span className="chip">cancelled</span>}
      {r.changedPattern && (
        <span className="chip" title="The pattern was changed after runs had started">
          changed pattern
        </span>
      )}
    </>
  );
  const value = (r: CompareRow, def: MeasureDef) => {
    const v = r.m[def.id];
    return v === undefined ? (
      <span className="muted" title="Not reported">
        —
      </span>
    ) : (
      fmtValue(def.unit, v)
    );
  };
  if (narrow) {
    return (
      <ul id={tasksId(g.key)} className="compare-tasks plain-list">
        {g.rows.map((r) => (
          <li key={r.taskId}>
            <div className="compare-task-title">
              {link(r)} {flags(r)}
            </div>
            <div className="muted small">
              {fmtDate(r.settledAt)}
              {defs.map((def) => (
                <span key={def.id} className="compare-task-m">
                  {" · "}
                  {def.label} <span className="num">{value(r, def)}</span>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div id={tasksId(g.key)} className="compare-tasks">
      <table className="compare-task-table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Settled</th>
            {defs.map((def) => (
              <th scope="col" key={def.id} className="num">
                {def.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r) => (
            <tr key={r.taskId}>
              <td>
                {link(r)} {flags(r)}
              </td>
              <td className="num">{fmtDate(r.settledAt)}</td>
              {defs.map((def) => (
                <td key={def.id} className="num">
                  {value(r, def)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
