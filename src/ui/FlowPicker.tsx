// ORC-021: choose a flow. A plain labelled select over the six flows, a card with the chosen flow's "use it
// for" line, and a read-only list of its steps. Nothing here edits a pipeline: the shape of every pipeline
// comes from a flow file.

import { stepMarkers } from "../domain/flows";
import type { Flow, StepDef } from "../domain/types";
import { ROLE_LABEL } from "./common";

/** One row per step: id, purpose, role and the step's markers (if findings, repeats, pauses for you, …). */
export function FlowSteps({ steps }: { steps: StepDef[] }) {
  return (
    <ol className="flow-steps">
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

/** What a flow does, when to use it, and its steps. */
export function FlowCard({ flow, showSteps = true }: { flow: Flow; showSteps?: boolean }) {
  return (
    <div className="flow-card" aria-live="polite">
      <strong>{flow.name}</strong>
      <p style={{ fontSize: "0.88rem", margin: "0.3rem 0 0.2rem" }}>{flow.description}</p>
      <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.2rem" }}>
        <strong>Use it for:</strong> {flow.whenToUse}
      </p>
      {showSteps && (
        <>
          <div className="muted" style={{ fontSize: "0.8rem", margin: "0.3rem 0 0.1rem" }}>
            {flow.steps.length} steps, read-only. Provider and model are chosen per step on the task page.
          </div>
          <FlowSteps steps={flow.steps} />
        </>
      )}
    </div>
  );
}

/**
 * The select and, below it, the card of the chosen flow. `flows` is the list the caller allows (all six for
 * New task and the default; every flow but Goal for a child task). `value` may name a flow that is not in the
 * list; then no card is shown.
 */
export function FlowPicker({ flows, value, onChange, label = "Flow", disabled, showCard = true, id }: { flows: Flow[]; value: string; onChange: (id: string) => void; label?: string; disabled?: boolean; showCard?: boolean; id?: string }) {
  const chosen = flows.find((p) => p.id === value);
  return (
    <div>
      <label className="field" style={{ marginBottom: showCard ? "0.4rem" : undefined }}>
        <span>{label}</span>
        <select id={id} value={chosen ? value : ""} disabled={disabled || !flows.length} onChange={(e) => onChange(e.target.value)}>
          {!chosen && <option value="">{flows.length ? "Choose a flow" : "No flows loaded"}</option>}
          {flows.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}: {p.whenToUse}
            </option>
          ))}
        </select>
      </label>
      {showCard && chosen && <FlowCard flow={chosen} />}
    </div>
  );
}
