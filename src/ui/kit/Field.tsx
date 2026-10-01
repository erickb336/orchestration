import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "./cx";

type FieldLink = { id: string; describedBy?: string; invalid: boolean };
const FieldContext = createContext<FieldLink | null>(null);

export type FieldProps = {
  label: ReactNode;
  /** How to fill it in, under the control. */
  hint?: ReactNode;
  /** What is wrong, under the hint; the control gets aria-invalid. */
  error?: ReactNode;
  /** short: a number or a time. medium: a name. full (default): text. */
  width?: "short" | "medium" | "full";
  /** The label is for screen readers only (a toolbar filter whose meaning is clear from context). Use sparingly. */
  labelHidden?: boolean;
  className?: string;
  /** One Input, Textarea or Select. It takes the id, aria-describedby and aria-invalid from the field. */
  children: ReactNode;
};

/** A labelled control. Every control sits in one, so every control is labelled and its hint and error are linked. */
export function Field({ label, hint, error, width = "full", labelHidden, className, children }: FieldProps) {
  const base = useId();
  const id = `${base}c`;
  const hintId = `${base}h`;
  const errorId = `${base}e`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("k-field", width !== "full" && `k-field--${width}`, className)}>
      <label className={cx("k-field__label", labelHidden && "sr-only")} htmlFor={id}>
        {label}
      </label>
      <FieldContext.Provider value={{ id, describedBy, invalid: !!error }}>{children}</FieldContext.Provider>
      {hint && (
        <span className="k-field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="k-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The attributes a control inherits from its Field. Explicit props win. */
export function useFieldControl(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: InputHTMLAttributes<HTMLElement>["aria-invalid"] }) {
  const field = useContext(FieldContext);
  return {
    id: props.id ?? field?.id,
    "aria-describedby": props["aria-describedby"] ?? field?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid ? true : undefined),
  };
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const link = useFieldControl(props);
  return <input {...props} {...link} className={cx("k-control", className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const link = useFieldControl(props);
  return <textarea {...props} {...link} className={cx("k-control", className)} />;
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({ className, options, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options?: SelectOption[] }) {
  const link = useFieldControl(props);
  return (
    <select {...props} {...link} className={cx("k-control", className)}>
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}

/** A checkbox with its label on the right and an optional hint under the label. It needs no Field. */
export function Checkbox({ label, hint, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; hint?: ReactNode }) {
  const hintId = useId();
  return (
    <label className={cx("k-check", className)}>
      <input {...props} type="checkbox" className="k-check__box" aria-describedby={hint ? hintId : props["aria-describedby"]} />
      <span className="k-check__text">
        {label}
        {hint && (
          <span className="k-check__hint" id={hintId}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
