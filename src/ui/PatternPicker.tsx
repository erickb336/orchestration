// ORC-016: choose a pipeline pattern. The picker is a labelled select with option groups (Standard; Pauses for
// you; Experiments; Without an independent review), a card that describes the chosen pattern, and a read-only
// list of its steps. Nothing here edits a pipeline: the shape of every pipeline comes from a pattern file.

import { stepMarkers } from "../domain/patterns";
import type { Pattern, State, StepDef } from "../domain/types";
import { ROLE_LABEL } from "./common";
import { audienceText, disabledProviders, patternFlagChips, patternGroups, patternOptionLabel, shortHash } from "./patternView";

/** One row per step: id, purpose, role and the step's markers (if findings, repeats, pauses for you, …). */
export function PatternSteps({ steps }: { steps: StepDef[] }) {
  return (
    <ol className="pattern-steps">
      {steps.map((st) => {
        const markers = stepMarkers(st).replace(/^ \(|\)$/g, "");
        return (
          <li key={st.id}>
            <span className="mono">{st.id}</span>
            <span>
              {st.purpose}
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                {" "}
                · {ROLE_LABEL[st.role]}
                {st.dependsOn.length ? ` · after ${st.dependsOn.join(", ")}` : ""}
                {markers ? ` · ${markers}` : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What a pattern does, when to use it, its hypothesis when it is an experiment, its flags, and its steps. */
export function PatternCard({ state, pattern, showSteps = true }: { state: State; pattern: Pattern; showSteps?: boolean }) {
  const missing = disabledProviders(pattern, state.project.enabledProviders);
  return (
    <div className="pattern-card" aria-live="polite">
      <div className="row" style={{ gap: "0.3rem" }}>
        <strong>{pattern.name}</strong>
        {patternFlagChips(pattern).map((c) => (
          <span key={c.text} className="chip" title={c.title}>
            {c.text}
          </span>
        ))}
        <span className="chip mono" title={`Content hash ${pattern.hash}; file ${pattern.file}`}>
          {shortHash(pattern.hash)}
        </span>
      </div>
      <p style={{ fontSize: "0.88rem", margin: "0.3rem 0 0.2rem" }}>{pattern.description}</p>
      <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.2rem" }}>
        <strong>Use when:</strong> {pattern.whenToUse}
      </p>
      {pattern.experimental && pattern.hypothesis && (
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.2rem" }}>
          <strong>Hypothesis:</strong> {pattern.hypothesis}
        </p>
      )}
      <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.2rem" }}>
        {audienceText(pattern)}
      </p>
      {missing.length > 0 && (
        <p style={{ color: "var(--s-paused)", fontSize: "0.85rem", margin: "0 0 0.2rem" }}>
          This pattern runs parallel copies on {missing.join(" and ")}, which {missing.length === 1 ? "is" : "are"} not enabled (Settings → Providers). Those copies will block until the provider is enabled.
        </p>
      )}
      {pattern.warnings.length > 0 && (
        <ul className="plain muted" style={{ fontSize: "0.8rem", margin: "0 0 0.2rem" }}>
          {pattern.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {showSteps && (
        <>
          <div className="muted" style={{ fontSize: "0.8rem", margin: "0.3rem 0 0.1rem" }}>
            {pattern.steps.length} steps, read-only. Provider and model are chosen per step on the task page.
          </div>
          <PatternSteps steps={pattern.steps} />
        </>
      )}
    </div>
  );
}

/**
 * The select and, below it, the card of the chosen pattern. `patterns` is the list the caller allows (the
 * whole catalog for New task; without patterns that break down for a child task; standard ones for the
 * project default). `value` may name a pattern that is not in the list; then no card is shown.
 */
export function PatternPicker({
  state,
  patterns,
  value,
  onChange,
  label = "Pattern",
  disabled,
  showCard = true,
  id,
}: {
  state: State;
  patterns: Pattern[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  disabled?: boolean;
  showCard?: boolean;
  id?: string;
}) {
  const chosen = patterns.find((p) => p.id === value);
  const groups = patternGroups(patterns);
  return (
    <div>
      <label className="field" style={{ marginBottom: showCard ? "0.4rem" : undefined }}>
        <span>{label}</span>
        <select id={id} value={chosen ? value : ""} disabled={disabled || !patterns.length} onChange={(e) => onChange(e.target.value)}>
          {!chosen && <option value="">{patterns.length ? "Choose a pattern" : "No patterns loaded"}</option>}
          {groups.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {patternOptionLabel(p)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {showCard && chosen && <PatternCard state={state} pattern={chosen} />}
    </div>
  );
}
