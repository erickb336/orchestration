// The files of the demo's Vision story (src/domain/demo.ts): what the simulated designer handed in for each studio
// artifact version of "Weekend Trips (sample)", by title and version. The demo records each version through the
// studio's commands with these files' SHA-256 hashes; the fake service writes the files into the version folders at
// start (server/demoFiles.ts), so the prototype server shows them and checks each hash as it does for real work.
//
// Every page says it is a sample: a band at its top names the simulated designer. Plain HTML and CSS, nothing
// fetched (the prototype server's policy allows no network). Pure data and hashing, no I/O.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Device } from "./types";
import type { DictionaryEntry, FlowExample, FlowRule, StudioArtifactKind } from "./studio/types";

/** One version as the designer handed it in: its kind, variants, devices and files (path → text). */
export interface DemoVersion {
  kind: StudioArtifactKind;
  title: string;
  version: number;
  variants: { id: string; label: string; entry: string }[];
  devices: Device[];
  files: Record<string, string>;
  dictionary?: DictionaryEntry[];
  rules?: { variant: string; path: string; rules: FlowRule[]; examples: FlowExample[] }[];
}

export const sha256Hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/** The band every sample page starts with. */
export const SAMPLE_BAND = "Sample prototype: the demo's simulated designer made this, not an agent.";

const CSS = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c2a24; background: #f4f1ea; }
.sim { margin: 0; padding: 6px 16px; font-size: 13px; background: #fff1bf; color: #5a4700; text-align: center; }
.app { max-width: 980px; margin: 0 auto; padding: 16px 20px 32px; }
.top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h1 { margin: 4px 0 2px; font-size: 26px; }
h2 { margin: 18px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #5d6b63; }
.meta { margin: 0; color: #5d6b63; }
.grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; }
.card { background: #fff; border-radius: 14px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.btn { display: inline-block; border: 0; border-radius: 999px; padding: 10px 18px; font: inherit; font-weight: 600; background: #2f6d4f; color: #fff; }
.btn.quiet { background: #e6efe9; color: #2f6d4f; }
.list { margin: 0; padding: 0; list-style: none; }
.list li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #ece7dc; }
.list li:last-child { border-bottom: 0; }
.list.card { padding: 2px 16px; }
.muted { color: #5d6b63; }
.who { display: flex; gap: 6px; flex-wrap: wrap; }
.who span { min-width: 34px; height: 34px; padding: 0 8px; border-radius: 999px; display: grid; place-items: center; font-size: 13px; font-weight: 600; color: #fff; background: #3c7a89; }
.who span.maybe { background: #b9b2a4; }
.map { position: relative; min-height: 420px; border-radius: 14px; overflow: hidden; background: #dfeadb; }
.ridge { position: absolute; inset: 12% 8% 20% 14%; border: 5px dashed #b0552c; border-radius: 46% 54% 40% 60%; }
.creek { position: absolute; left: 0; right: 0; top: 58%; height: 10px; background: #9cc3db; transform: rotate(-8deg); }
.pin { position: absolute; padding: 4px 10px; border-radius: 999px; background: #1c2a24; color: #fff; font-size: 13px; white-space: nowrap; }
.banner { margin: 0 0 12px; padding: 10px 14px; border-radius: 12px; background: #1c2a24; color: #fff; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.next { margin-top: 12px; }
@media (max-width: 700px) {
  .app { padding: 12px 14px 24px; }
  .grid { grid-template-columns: 1fr; }
  .map { min-height: 300px; }
  h1 { font-size: 22px; }
}
`;

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
<p class="sim">${SAMPLE_BAND}</p>
<main class="app">
${body}
</main>
</body>
</html>
`;

// ---------- round 1, the experience ----------

const mapBody = (offline: boolean) => `<div class="top"><div><h1>Ridge Loop</h1><p class="meta">14 km · 620 m up · Sat 17 Oct</p></div>${offline ? `<button class="btn quiet">Saved for offline · 18 MB</button>` : ""}</div>
${offline ? `<p class="banner" role="status"><span><b>Offline.</b> The map is saved on this phone.</span><span>Saved 2 days ago</span></p>` : ""}
<div class="grid">
<div class="map" role="img" aria-label="Map of the Ridge Loop with its stops">
<div class="ridge"></div><div class="creek"></div>
<span class="pin" style="left:10%;top:72%">Trailhead</span>
<span class="pin" style="left:44%;top:50%">Second creek junction</span>
<span class="pin" style="left:60%;top:10%">Ridge top</span>
</div>
<div>
<div class="card next"><b>Next: Second creek junction</b><p class="meta">3.2 km · keep left after the bridge</p></div>
<h2>Stops</h2>
<ol class="list card"><li><span>Trailhead</span><span class="muted">0 km</span></li><li><span>Second creek junction</span><span class="muted">3.2 km</span></li><li><span>Ridge top</span><span class="muted">7.0 km</span></li><li><span>Back at the trailhead</span><span class="muted">14 km</span></li></ol>
${offline ? "" : `<p class="muted">Tiles load as you move the map.</p>`}
</div>
</div>`;

const tripPlan = `<h2>The plan</h2>
<ol class="list card"><li><span>Meet at the trailhead parking</span><span class="muted">8:00</span></li><li><span>Second creek junction</span><span class="muted">9:10</span></li><li><span>Lunch on the ridge</span><span class="muted">12:00</span></li><li><span>Back at the cars</span><span class="muted">15:30</span></li></ol>`;
const tripPeople = `<h2>Who is coming</h2>
<div class="card"><div class="who"><span>Ana</span><span>Ben</span><span>Chi</span><span>Dev</span><span class="maybe">Eli?</span></div><p class="meta">4 in · 1 maybe</p></div>`;
const tripTop = `<div class="top"><div><h1>Ridge Loop</h1><p class="meta">Sat 17 Oct · meet 8:00 at the trailhead parking</p></div><button class="btn">Share the invite link</button></div>`;

const packingBody = (who: boolean) => `<div class="top"><div><h1>Packing list</h1><p class="meta">Ridge Loop · 14 km · rain after 14:00</p></div><button class="btn quiet">Add an item</button></div>
<div class="grid">
<div>
<h2>Shared</h2>
<ul class="list card">
<li><span>☑ Stove and gas</span><span class="muted">${who ? "Ana" : ""}</span></li>
<li><span>☐ First-aid kit</span><span class="muted">${who ? "Nobody yet" : ""}</span></li>
<li><span>☑ Water filter</span><span class="muted">${who ? "Ben" : ""}</span></li>
</ul>
</div>
<div>
<h2>Each person</h2>
<ul class="list card"><li><span>Rain shell</span><span class="muted">forecast: rain</span></li><li><span>Water, 2 L</span><span class="muted">14 km</span></li><li><span>Head torch</span><span class="muted">back after 15:00</span></li></ul>
</div>
</div>`;

const chatBody = `<div class="top"><div><h1>Ridge Loop chat</h1><p class="meta">5 people</p></div></div>
<ul class="list card"><li><span><b>Ana</b> Who has the stove?</span><span class="muted">20:14</span></li><li><span><b>Ben</b> Me, I think</span><span class="muted">20:15</span></li><li><span><b>Chi</b> I can bring one too</span><span class="muted">20:21</span></li></ul>`;

const screen = (title: string, version: number, variants: { id: string; label: string; body: string }[]): DemoVersion => {
  const files: Record<string, string> = { "app.css": CSS };
  const entries = variants.map((v) => {
    const entry = variants.length === 1 ? "index.html" : `${v.id.toLowerCase()}/index.html`;
    files[entry] = variants.length === 1 ? page(`${title} · ${v.label}`, v.body) : page(`${title} · ${v.label}`, v.body).replace('href="app.css"', 'href="../app.css"');
    return { id: v.id, label: v.label, entry };
  });
  return { kind: "screen", title, version, variants: entries, devices: ["desktop", "mobile"], files };
};

// ---------- round 2, inputs and outputs ----------

const tripData = (guest: boolean) => `# Trip data

> ${SAMPLE_BAND}

What a trip holds, and what crosses the phone's boundary when a friend opens the plan.

| Thing | What it holds | How it relates |
| --- | --- | --- |
| Trip | the trail, the day, the meeting point and time | has people, one plan and one packing list |
| Person | a name, and in, out or maybe | joins trips${guest ? "; a guest has no account" : ""} |
| Packing item | a name, shared or each person, who brings it | belongs to one trip's list |
${guest ? "| Guest link | the trip, a link id, an expiry | lets a friend join without an account |\n" : ""}
## A worked example

\`\`\`json
{ "trip": "Ridge Loop", "day": "2026-10-17", "meet": "08:00", "people": [{ "name": "Ana", "status": "in" }${guest ? ', { "name": "Eli", "status": "maybe", "guest": true }' : ""}] }
\`\`\`
${guest ? "\n## What is kept\n\nA guest's name and the link id, for 30 days after the trip. Nothing else about a guest is stored.\n" : ""}`;

const WORDS: DictionaryEntry[] = [
  { term: "trip", meaning: "A weekend hike that a group plans together.", avoid: ["journey", "outing"] },
  { term: "friend", meaning: "A person in the group, who may join by link without an account.", avoid: ["member", "user"] },
  { term: "trailhead", meaning: "Where the trail starts and the group meets.", avoid: ["start point"] },
  { term: "offline map", meaning: "The trail's map saved on the phone, which works with no signal.", avoid: ["cached map"] },
];

// ---------- round 3, flows ----------

const JOIN_RULES: FlowRule[] = [
  { id: "R1", text: 'When a friend opens the invite link, the app shall show the trip and a "Join" button.', pattern: "event" },
  { id: "R2", text: "When a friend joins, the app shall add them to who is coming.", pattern: "event" },
  { id: "R3", text: 'If the link has expired, then the app shall show "Ask the organiser for a new link".', pattern: "unwanted" },
  { id: "R4", text: "The app shall never show a friend who joins by link any other trip.", pattern: "always" },
];
const JOIN_EXAMPLES: FlowExample[] = [{ id: "E1", text: "Given an expired link, when a friend opens it, then the page asks them to ask the organiser for a new link." }];
const joinFlow = `# Join a trip by link

> ${SAMPLE_BAND}

\`\`\`mermaid
flowchart LR
  open[Friend opens the link] --> valid{Link valid?}
  valid -- yes --> trip[Trip page with Join] --> join[Join] --> list[Added to who is coming]
  valid -- no --> expired[Ask the organiser for a new link]
\`\`\`

| Case | Outcome |
| --- | --- |
| The link is valid | The trip and a Join button |
| The friend joins | Added to who is coming |
| The link has expired | "Ask the organiser for a new link" |
`;

/** Every version of the demo's Vision story, in the order the designer handed them in. */
export const DEMO_VERSIONS: DemoVersion[] = [
  screen("Trail map", 1, [{ id: "A", label: "Map and stops", body: mapBody(false) }]),
  screen("Trip page", 1, [
    { id: "A", label: "Plan first", body: `${tripTop}<div class="grid"><div>${tripPlan}</div><div>${tripPeople}</div></div>` },
    { id: "B", label: "People first", body: `${tripTop}<div class="grid"><div>${tripPeople}</div><div>${tripPlan}</div></div>` },
  ]),
  screen("Packing list", 1, [{ id: "A", label: "Shared and each", body: packingBody(false) }]),
  screen("Group chat", 1, [{ id: "A", label: "Trip chat", body: chatBody }]),
  screen("Trail map", 2, [{ id: "A", label: "Map and stops, saved offline", body: mapBody(true) }]),
  screen("Packing list", 2, [{ id: "A", label: "Who brings what", body: packingBody(true) }]),
  { kind: "contract", title: "Trip data", version: 1, variants: [{ id: "A", label: "Trip data", entry: "contract.md" }], devices: [], files: { "contract.md": tripData(false) } },
  { kind: "contract", title: "Trip data", version: 2, variants: [{ id: "A", label: "Trip data, with guests", entry: "contract.md" }], devices: [], files: { "contract.md": tripData(true) } },
  { kind: "dictionary", title: "Words", version: 1, variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], devices: [], files: { "dictionary.json": `${JSON.stringify(WORDS, null, 2)}\n` }, dictionary: WORDS },
  {
    kind: "flow",
    title: "Join flow",
    version: 1,
    variants: [{ id: "A", label: "Join by link", entry: "join/flow.md" }],
    devices: [],
    files: { "join/flow.md": joinFlow, "join/rules.json": `${JSON.stringify({ rules: JOIN_RULES, examples: JOIN_EXAMPLES }, null, 2)}\n` },
    rules: [{ variant: "A", path: "join/rules.json", rules: JOIN_RULES, examples: JOIN_EXAMPLES }],
  },
];

/** The version with this title and number. */
export function demoVersion(title: string, version: number): DemoVersion {
  const v = DEMO_VERSIONS.find((x) => x.title === title && x.version === version);
  if (!v) throw new Error(`demo: no files for ${title} v${version}`);
  return v;
}

/** The files as the studio records them: each path with its SHA-256. */
export const fileList = (v: DemoVersion) => Object.entries(v.files).map(([path, text]) => ({ path, sha256: sha256Hex(text) }));

/** The screenshots the demo's screens carry (rendered by scripts/media/demo-shots.mjs): shots/<variant>-<device>.png. */
export const shotName = (variant: string, device: "desktop" | "mobile") => `${variant}-${device}.png`;
