// Settings in seven sections, each with its own address. `#/settings` opens the first;
// `#/settings/<section>` opens one; `#/settings/<section>/<card>` opens it at a card. A card's name alone
// (`#/settings/delivery`, `#/settings/checks`) also works, so a link never needs to know which section a card is in,
// and an address that names a card under another section opens the card where it is now (a card that moved).

export const SECTIONS = [
  { id: "working-style", label: "Working style" },
  { id: "project", label: "Project" },
  { id: "budgets", label: "Budgets" },
  { id: "how-it-runs", label: "How your project runs" },
  { id: "agents", label: "Agents" },
  { id: "quality", label: "Quality" },
  { id: "advanced", label: "Advanced" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** Every card that can be linked to, and its section. The card's element id is its name. */
export const CARD_SECTION = {
  involvement: "working-style",
  steering: "working-style",
  notifications: "working-style",
  repository: "project",
  domains: "project",
  devices: "project",
  delivery: "project",
  "new-project": "project",
  budgets: "budgets",
  environment: "how-it-runs",
  providers: "agents",
  models: "agents",
  "agents-at-once": "agents",
  "run-limits": "agents",
  checks: "quality",
  "pe-review": "quality",
  overrules: "quality",
  flows: "quality",
  principles: "quality",
  "pull-requests": "advanced",
  github: "advanced",
  sandbox: "advanced",
  "agent-environment": "advanced",
  capabilities: "advanced",
  data: "advanced",
  diagnostics: "advanced",
} as const satisfies Record<string, SectionId>;

export type CardId = keyof typeof CARD_SECTION;

const isSection = (x: string): x is SectionId => SECTIONS.some((s) => s.id === x);
const isCard = (x: string): x is CardId => Object.hasOwn(CARD_SECTION, x);

export function settingsHref(section: SectionId, card?: CardId): string {
  return `#/settings/${section}${card ? `/${card}` : ""}`;
}

/** The link to a card, wherever it lives. */
export const cardHref = (card: CardId) => settingsHref(CARD_SECTION[card], card);

/** Which section a Settings address opens, and the card to scroll to: always in the card's own section. */
export function parseSettingsHash(hash: string): { section: SectionId; card?: CardId } {
  const parts = hash.replace(/^#\/?/, "").split("?")[0].split("/").map((p) => decodeURIComponent(p));
  if (parts[0] !== "settings") return { section: SECTIONS[0].id };
  const [, a = "", b = ""] = parts;
  if (isSection(a)) return isCard(b) ? { section: CARD_SECTION[b], card: b } : { section: a };
  if (isCard(a)) return { section: CARD_SECTION[a], card: a };
  return { section: SECTIONS[0].id };
}
