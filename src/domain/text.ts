// Short text helpers shared by the domain, the server and the UI. Pure.

/** `text` cut to `n` characters, the last one an ellipsis when something was cut. */
export const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** One line of at most `max` characters: whitespace collapsed, then clipped. */
export const truncate = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);

/** A duration in whole seconds, never less than one: "12 s". */
export const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;
