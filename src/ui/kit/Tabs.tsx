import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { moveIndex } from "./keys";

export type TabItem = { id: string; label: ReactNode; count?: number; disabled?: boolean };

export type TabsProps = {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** What the set of tabs is for: "Show". */
  label: string;
  className?: string;
  /** The selected tab's content; rendered in the tab panel. Leave it out to render the panel yourself. */
  children?: ReactNode;
};

/** Tabs that switch a view in place. Arrow keys move and select; Home and End jump. */
export function Tabs({ tabs, value, onChange, label, className, children }: TabsProps) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = tabs.findIndex((t) => t.id === value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = moveIndex(tabs.length, i, e.key, "horizontal", (n) => !!tabs[n].disabled);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(tabs[next].id);
  };
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="k-tabs">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}tab-${t.id}`}
            className="k-tab"
            aria-selected={t.id === value}
            aria-controls={`${base}panel-${t.id}`}
            tabIndex={t.id === value || (selected < 0 && i === 0) ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.count !== undefined && <span className="k-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {children !== undefined && (
        <div role="tabpanel" id={`${base}panel-${value}`} aria-labelledby={`${base}tab-${value}`} className="k-tabpanel" tabIndex={0}>
          {children}
        </div>
      )}
    </div>
  );
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

export type SegmentedControlProps<T extends string> = {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** What is being chosen: "View". */
  label: string;
  size?: "small" | "normal";
  className?: string;
};

/** One choice among a few, shown side by side (List · Board). A radio group: arrow keys move and choose. */
export function SegmentedControl<T extends string>({ options, value, onChange, label, size = "normal", className }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checked = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = moveIndex(options.length, i, e.key, "both", (n) => !!options[n].disabled);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(options[next].value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("k-seg", size === "small" && "k-seg--small", className)}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          className="k-seg__btn"
          aria-checked={o.value === value}
          tabIndex={o.value === value || (checked < 0 && i === 0) ? 0 : -1}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
