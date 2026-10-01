/** Join class names; falsy parts drop out. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");
