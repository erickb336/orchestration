// ORC-025 pass 5: the pieces every Settings section is built from. A section is a heading, one sentence of help
// (S6), its cards, and one Save bar (S5). A card is the kit's Card with one sentence of help under its title.

import { useEffect, useId, useState, type ReactNode } from "react";
import * as M from "../../domain/model";
import { PROVIDERS, type ModelSelection, type State } from "../../domain/types";
import { Actions, Button, Card, Field, Select } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import type { Draft } from "./draft";
import type { CardId, SectionId } from "./sections";

/** A section: heading, help, cards, and the Save bar. Hidden sections stay mounted, so their drafts survive a switch. */
export function SettingsSection<T extends object>({
  id,
  title,
  help,
  current,
  draft,
  invalid,
  onSave,
  onDirty,
  children,
}: {
  id: SectionId;
  title: string;
  /** One sentence: what the section is for, and that changes wait for Save. */
  help: ReactNode;
  current: boolean;
  draft: Draft<T>;
  /** Why the draft cannot be saved yet (a field out of range), or undefined. */
  invalid?: string;
  /**
   * Sends the draft; true when everything was saved (the draft is then cleared). It asks any confirmation first
   * and calls `begin` once the commands start, so the bar says "Saving…" only while something is being saved.
   */
  onSave: (begin: () => void) => Promise<boolean>;
  onDirty: (id: SectionId, dirty: boolean) => void;
  children: ReactNode;
}) {
  const { disabled } = useStore();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const headingId = `settings-${id}-h`;
  useEffect(() => onDirty(id, draft.dirty), [id, draft.dirty, onDirty]);
  useEffect(() => {
    if (draft.dirty) setSaved(false);
  }, [draft.dirty]);
  const save = async () => {
    setBusy(true);
    const ok = await onSave(() => setSaving(true));
    setBusy(false);
    setSaving(false);
    if (ok) {
      draft.reset();
      setSaved(true);
    }
  };
  const state = draft.dirty ? "Unsaved changes" : saved ? "Saved" : "No unsaved changes";
  return (
    <section className="s-section" aria-labelledby={headingId} hidden={!current} data-section={id}>
      <div className="s-section__head">
        <h2 id={headingId}>{title}</h2>
        <p className="s-help">{help}</p>
      </div>
      <fieldset className="plain-fieldset s-cards" disabled={disabled || saving}>
        <legend className="sr-only">{title}</legend>
        {children}
      </fieldset>
      <div className={cx("s-savebar", draft.dirty && "s-savebar--dirty")} role="group" aria-label={`Save ${title}`}>
        <span className={cx("s-savebar__state", draft.dirty && "s-savebar__state--dirty", !draft.dirty && saved && "s-savebar__state--saved")} role="status">
          {state}
        </span>
        <Actions>
          {draft.dirty && (
            <Button variant="quiet" disabled={busy} onClick={draft.reset}>
              Discard
            </Button>
          )}
          <Button variant="primary" disabled={disabled || busy || !draft.dirty || !!invalid} disabledReason={draft.dirty ? invalid : undefined} showReason={!!invalid && draft.dirty} loading={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </Actions>
      </div>
    </section>
  );
}

/** A card with one sentence of help under its title (S6: help is visible, not behind "How this works"). */
export function SettingsCard({ id, title, help, actions, children }: { id: CardId; title: ReactNode; help?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <Card id={id} title={title} as="h3" actions={actions} className="s-card">
      {help && <p className="s-card-help">{help}</p>}
      {children}
    </Card>
  );
}

/** One radio choice: a label, what it means, and anything it needs (a branch name) under it. */
export function Choice({
  name,
  checked,
  onChange,
  label,
  aside,
  description,
  disabled,
  boxed,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  /** A chip after the label ("Current"). */
  aside?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  boxed?: boolean;
  /** Shown under the choice while it is chosen. */
  children?: ReactNode;
}) {
  const descId = useId();
  return (
    <div className={cx("s-choice", boxed && "s-choice--boxed", checked && "s-choice--on")}>
      <input id={`${descId}r`} className="s-choice__input" type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} aria-describedby={description ? descId : undefined} />
      <label className="s-choice__text" htmlFor={`${descId}r`}>
        <span className="s-choice__label">
          {label}
          {aside}
        </span>
        {description && (
          <span className="s-choice__desc" id={descId}>
            {description}
          </span>
        )}
      </label>
      {checked && children && <div className="s-choice__more">{children}</div>}
    </div>
  );
}

const INHERIT = "__inherit__";
const enc = (v: ModelSelection | null) => (v ? `${v.provider}::${v.model}` : INHERIT);

/** A provider and model, in a kit Select inside a Field. `inheritLabel` adds a "use the default" choice. */
export function ModelField({
  state,
  label,
  hint,
  value,
  onChange,
  inheritLabel,
  enabled,
}: {
  state: State;
  label: string;
  hint?: ReactNode;
  value: ModelSelection | null;
  onChange: (v: ModelSelection | null) => void;
  inheritLabel?: string;
  /** The providers the draft enables (a provider being turned on in the same save counts). */
  enabled: readonly string[];
}) {
  const catalog = state.project.catalog;
  return (
    <Field label={label} hint={hint}>
      <Select
        value={enc(value)}
        onChange={(e) => {
          if (e.target.value === INHERIT) return onChange(null);
          const [provider, model] = e.target.value.split("::");
          onChange({ provider: provider as ModelSelection["provider"], model });
        }}
      >
        {inheritLabel && <option value={INHERIT}>{inheritLabel}</option>}
        {PROVIDERS.map((p) => (
          <optgroup key={p} label={`${M.providerLabel(p)}${enabled.includes(p) ? "" : " (not enabled)"}`}>
            <option value={`${p}::auto`}>{M.providerLabel(p)} · Auto (the lead chooses)</option>
            {catalog[p].map((m) => (
              <option key={m.id} value={`${p}::${m.id}`}>
                {M.providerLabel(p)} · {m.id}
              </option>
            ))}
          </optgroup>
        ))}
        {value && value.model !== "auto" && !catalog[value.provider].some((m) => m.id === value.model) && <option value={enc(value)}>{`${M.providerLabel(value.provider)} · ${value.model} (not in the catalog)`}</option>}
      </Select>
    </Field>
  );
}
