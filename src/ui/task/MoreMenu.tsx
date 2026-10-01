// The task's rarer controls in one menu behind "More". A button opens a list of actions
// and settings; arrow keys move, Enter or Space choose, Escape and a click outside close it. A checkbox item
// shows its mark and is announced as checked.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../kit/Button";
import { cx } from "../kit/cx";
import { moveIndex } from "../kit/keys";

export type MenuItem =
  | { kind?: "item"; id: string; label: ReactNode; hint?: string; onSelect: () => void; disabled?: boolean; disabledReason?: string; danger?: boolean }
  | { kind: "check"; id: string; label: ReactNode; hint?: string; checked: boolean; onSelect: () => void; disabled?: boolean; disabledReason?: string }
  | { kind: "sep"; id: string };

export function MoreMenu({ label = "More", items, menuLabel }: { label?: string; items: MenuItem[]; menuLabel: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const choices = items.filter((i) => i.kind !== "sep");

  useEffect(() => {
    if (!open) return;
    const first = root.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)');
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (giveBack = true) => {
    setOpen(false);
    if (giveBack) root.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = moveIndex(buttons.length, current, e.key, "vertical", (i) => buttons[i].disabled);
    if (next !== null) {
      e.preventDefault();
      buttons[next].focus();
    }
  };

  return (
    <div className="t-menu" ref={root} onKeyDown={onKeyDown}>
      <Button variant="quiet" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((o) => !o)}>
        {label} ▾
      </Button>
      {open && (
        <div role="menu" id={menuId} aria-label={menuLabel} className="t-menu__pop">
          {items.map((it) => {
            if (it.kind === "sep") return <div key={it.id} className="t-menu__sep" role="separator" />;
            const check = it.kind === "check";
            const off = !!it.disabled;
            return (
              <button
                key={it.id}
                type="button"
                role={check ? "menuitemcheckbox" : "menuitem"}
                aria-checked={check ? it.checked : undefined}
                className={cx("t-menu__item", !check && it.danger && "t-menu__item--danger")}
                disabled={off}
                title={off ? it.disabledReason : undefined}
                onClick={() => {
                  it.onSelect();
                  if (!check) close();
                }}
              >
                <span className="t-menu__mark" aria-hidden="true">
                  {check && it.checked ? "✓" : ""}
                </span>
                <span>
                  {it.label}
                  {(it.hint || (off && it.disabledReason)) && <span className="t-menu__hint">{off && it.disabledReason ? it.disabledReason : it.hint}</span>}
                </span>
              </button>
            );
          })}
          {choices.length === 0 && <span className="t-menu__hint">Nothing to do here.</span>}
        </div>
      )}
    </div>
  );
}
