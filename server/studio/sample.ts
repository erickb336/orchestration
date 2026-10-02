// What the fake runtime's designer hands in (ORC-029 pass 3a): a small sample prototype of Weekend Trips' trip plan,
// in two variants, for desktop and mobile, in plain HTML and CSS with nothing fetched (the prototype server's
// content security policy allows no network). It goes through the same
// studio.json check and import as a real designer's work, so the demo and the tests need no agent. Every page says
// it is a simulated sample.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d2733; background: #f6f4ef; }
.sim { margin: 0; padding: 6px 16px; font-size: 13px; background: #fff3c4; color: #5c4a00; text-align: center; }
header { padding: 20px 24px 8px; }
h1 { margin: 0; font-size: 26px; }
.meta { margin: 4px 0 0; color: #5b6673; }
.who { display: flex; gap: 6px; margin-top: 12px; }
.who span { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-weight: 600; color: #fff; background: #3c7a89; }
.who span:nth-child(2) { background: #b5651d; }
.who span:nth-child(3) { background: #6b5ca5; }
.who span:nth-child(4) { background: #2e7d4f; }
`;

const MAP_CSS = `${BASE_CSS}main { display: grid; grid-template-columns: 1fr 360px; gap: 20px; padding: 16px 24px 32px; }
.map { position: relative; min-height: 520px; border-radius: 14px; background: linear-gradient(160deg, #cfe3d6, #e8efe0 55%, #d9e7f1); overflow: hidden; }
.lake { position: absolute; left: 38%; top: 30%; width: 34%; height: 36%; border-radius: 48% 52% 40% 60%; background: #9cc4dd; }
.pin { position: absolute; padding: 4px 10px; border-radius: 999px; background: #1d2733; color: #fff; font-size: 13px; white-space: nowrap; }
.market { left: 12%; top: 14%; }
.cabin { left: 58%; top: 20%; }
.trail { left: 20%; top: 70%; }
.boats { left: 64%; top: 72%; }
.list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.list li { padding: 12px 14px; border-radius: 12px; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.list b { display: block; }
.list small { color: #5b6673; }
@media (max-width: 700px) {
  header { padding: 16px 16px 4px; }
  main { grid-template-columns: 1fr; padding: 12px 16px 24px; }
  .map { min-height: 260px; }
}
`;

const DAYS_CSS = `${BASE_CSS}main { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; padding: 16px 24px 32px; }
.day { border-radius: 14px; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); overflow: hidden; }
.day h2 { margin: 0; padding: 12px 16px; font-size: 17px; background: #3c7a89; color: #fff; }
.day ol { margin: 0; padding: 8px 16px 16px; list-style: none; }
.day li { display: grid; grid-template-columns: 64px 1fr; gap: 8px; padding: 10px 0; border-bottom: 1px solid #eee8dc; }
.day li:last-child { border-bottom: 0; }
.day time { font-variant-numeric: tabular-nums; color: #5b6673; }
@media (max-width: 700px) {
  header { padding: 16px 16px 4px; }
  main { grid-template-columns: 1fr; padding: 12px 16px 24px; }
}
`;

const head = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<p class="sim">Simulated sample: the fake runtime made this, not a designer agent.</p>
<header>
<h1>Lake weekend</h1>
<p class="meta">Sat 17 – Sun 18 Oct · Pine Lake cabin · 4 friends · about $140 each</p>
<div class="who" aria-label="Who is going"><span>AM</span><span>JR</span><span>KT</span><span>SO</span></div>
</header>`;

const MAP_HTML = `${head("Trip plan · A · Map first")}
<main>
<div class="map" role="img" aria-label="Map of the weekend's stops around Pine Lake">
<div class="lake"></div>
<span class="pin market">Farmers market</span>
<span class="pin cabin">Cabin</span>
<span class="pin trail">Ridge trail</span>
<span class="pin boats">Boat rental</span>
</div>
<ol class="list">
<li><b>Cabin at Pine Lake</b><small>Check in Sat 15:00 · booked by Jo</small></li>
<li><b>Farmers market</b><small>Sat 10:00 · on the way up</small></li>
<li><b>Ridge trail</b><small>Sun 08:30 · 7 km loop</small></li>
<li><b>Boat rental</b><small>Sun 13:00 · two kayaks</small></li>
</ol>
</main>
</body>
</html>
`;

const DAYS_HTML = `${head("Trip plan · B · Day by day")}
<main>
<section class="day">
<h2>Saturday 17</h2>
<ol>
<li><time>08:00</time><span>Leave town, two cars</span></li>
<li><time>10:00</time><span>Farmers market for groceries</span></li>
<li><time>15:00</time><span>Check in at the cabin</span></li>
<li><time>19:00</time><span>Dinner on the deck</span></li>
</ol>
</section>
<section class="day">
<h2>Sunday 18</h2>
<ol>
<li><time>08:30</time><span>Ridge trail, 7 km loop</span></li>
<li><time>13:00</time><span>Kayaks from the boat rental</span></li>
<li><time>16:00</time><span>Check out and drive back</span></li>
</ol>
</section>
</main>
</body>
</html>
`;

/** The sample's files, by path in the staging folder, and its studio.json. */
export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  "a/index.html": MAP_HTML,
  "a/style.css": MAP_CSS,
  "b/index.html": DAYS_HTML,
  "b/style.css": DAYS_CSS,
};

export const SAMPLE_MANIFEST = {
  artifacts: [
    {
      kind: "screen",
      title: "Trip plan (simulated sample)",
      devices: ["desktop", "mobile"],
      variants: [
        { id: "a", label: "A · Map first", entry: "a/index.html" },
        { id: "b", label: "B · Day by day", entry: "b/index.html" },
      ],
      files: Object.keys(SAMPLE_FILES),
    },
  ],
};

/** Write the sample prototype and its studio.json into a run's staging folder, as a designer agent would. */
export function writeSamplePrototype(staging: string) {
  for (const [p, text] of Object.entries(SAMPLE_FILES)) {
    mkdirSync(dirname(join(staging, p)), { recursive: true });
    writeFileSync(join(staging, p), text);
  }
  writeFileSync(join(staging, "studio.json"), `${JSON.stringify(SAMPLE_MANIFEST, null, 2)}\n`);
}

// ---------- the trips CLI: a terminal demo and a TUI ----------
//
// For a brief that asks for a terminal demo, the fake designer hands in the `trips` CLI instead: a VHS tape that the
// service records in its sandbox (with a hand-written .cast beside it, shown when it cannot record), and a TUI in two
// layouts as hand-written .ans frames. Every file says it is a simulated sample.

const E = "\x1b[";
const bold = (s: string) => `${E}1m${s}${E}0m`;
const dim = (s: string) => `${E}2m${s}${E}0m`;
const green = (s: string) => `${E}32m${s}${E}0m`;
const cyan = (s: string) => `${E}36m${s}${E}0m`;
const inverse = (s: string) => `${E}7m${s}${E}0m`;

/** The planned output of `trips`, which does not exist yet: a stand-in the tape runs with node. */
const TRIPS_JS = `// Simulated sample: the planned output of \`trips\`, the Weekend Trips CLI, which does not exist yet.
// A designer's stand-in that only prints what the real command will show, so the tape can record the experience.
const [cmd, arg] = process.argv.slice(2);
const b = (s) => "\\x1b[1m" + s + "\\x1b[0m", d = (s) => "\\x1b[2m" + s + "\\x1b[0m", g = (s) => "\\x1b[32m" + s + "\\x1b[0m", c = (s) => "\\x1b[36m" + s + "\\x1b[0m";
if (cmd === "plan") {
  console.log(b("Lake weekend") + "  " + d("Sat 17 - Sun 18 Oct · Pine Lake · 4 friends"));
  console.log("");
  console.log("  " + c("1") + "  Cabin at Pine Lake   check in Sat 15:00   " + g("$140 each"));
  console.log("  " + c("2") + "  Farmers market       Sat 10:00            " + g("free"));
  console.log("  " + c("3") + "  Ridge trail          Sun 08:30, 7 km      " + g("free"));
  console.log("");
  console.log(d("Next: trips pick <n>"));
} else if (cmd === "pick" && arg === "1") {
  console.log(b("Cabin at Pine Lake") + ", Saturday");
  console.log("  08:00  leave town, two cars");
  console.log("  15:00  check in, booked by Jo");
  console.log("  19:00  dinner on the deck");
  console.log("");
  console.log(g("Saved.") + " " + d("trips share 1 makes a link for your group"));
} else {
  console.log("usage: trips <plan | pick <n>>");
  process.exitCode = 2;
}
`;

const TRIPS_TAPE = `# Simulated sample: a terminal demo of \`trips\`, the Weekend Trips CLI. cli/trips.js prints its planned output; the
# shell starts at the artifact's root, so the tape names it by that path.
Output trips.gif
Output trips.webm
Output trips.txt

Set Shell bash
Set Columns 80
Set Rows 24
Set FontSize 16
Set TypingSpeed 40ms

Hide
Type "alias trips='node cli/trips.js' && clear"
Enter
Show

Type "trips plan"
Sleep 300ms
Enter
Sleep 1.5s

Type "trips pick 1"
Sleep 300ms
Enter
Sleep 2s
`;

/** The same demo written by hand, as asciicast v3: shown when the tape cannot be recorded. */
const TRIPS_CAST = [
  JSON.stringify({ version: 3, term: { cols: 80, rows: 24 }, title: "trips (simulated sample, hand-written)" }),
  JSON.stringify([0.4, "o", "$ trips plan\r\n"]),
  JSON.stringify([0, "m", "trips plan"]),
  JSON.stringify([0.3, "o", `${bold("Lake weekend")}  ${dim("Sat 17 - Sun 18 Oct · Pine Lake · 4 friends")}\r\n\r\n`]),
  JSON.stringify([0.1, "o", `  ${cyan("1")}  Cabin at Pine Lake   check in Sat 15:00   ${green("$140 each")}\r\n`]),
  JSON.stringify([0.1, "o", `  ${cyan("2")}  Farmers market       Sat 10:00            ${green("free")}\r\n`]),
  JSON.stringify([0.1, "o", `  ${cyan("3")}  Ridge trail          Sun 08:30, 7 km      ${green("free")}\r\n\r\n${dim("Next: trips pick <n>")}\r\n`]),
  JSON.stringify([0.8, "o", "$ trips pick 1\r\n"]),
  JSON.stringify([0, "m", "trips pick 1"]),
  JSON.stringify([0.3, "o", `${bold("Cabin at Pine Lake")}, Saturday\r\n  08:00  leave town, two cars\r\n  15:00  check in, booked by Jo\r\n  19:00  dinner on the deck\r\n\r\n${green("Saved.")} ${dim("trips share 1 makes a link for your group")}\r\n`]),
  JSON.stringify([1.5, "x", "0"]),
].join("\n");

/** One TUI frame, 80×24: a title line, the body's lines, and the keys. */
function tuiFrame(title: string, body: string[]): string {
  const lines = [`${bold(cyan(" trips "))} ${title}`, dim("─".repeat(78)), ...body];
  while (lines.length < 22) lines.push("");
  return [...lines.slice(0, 22), dim("─".repeat(78)), dim(" ↑↓ move   enter pick   s share   q quit   (simulated sample)")].join("\n") + "\n";
}

const TUI_LIST = tuiFrame("Lake weekend · Sat 17 - Sun 18 Oct", [
  "",
  ` ${inverse(" 1  Cabin at Pine Lake        ")}   ${bold("Cabin at Pine Lake")}`,
  "  2  Farmers market               check in Sat 15:00, booked by Jo",
  "  3  Ridge trail                  4 beds, $140 each",
  "  4  Boat rental",
  "                                  " + green("✓ Jo, Kim and Sam are in"),
  "                                  " + dim("Alex has not answered"),
]);

const TUI_DAYS = tuiFrame("Lake weekend · day by day", [
  "",
  ` ${bold("Saturday 17")}                     ${bold("Sunday 18")}`,
  "  08:00  leave town              08:30  ridge trail, 7 km",
  "  10:00  farmers market          13:00  kayaks",
  ` ${inverse(" 15:00  check in at the cabin ")}   16:00  drive back`,
  "  19:00  dinner on the deck",
]);

/** The terminal sample's files, by path in the staging folder. */
export const TERMINAL_SAMPLE_FILES: Readonly<Record<string, string>> = {
  "cli/trips.tape": TRIPS_TAPE,
  "cli/trips.js": TRIPS_JS,
  "cli/trips.cast": `${TRIPS_CAST}\n`,
  "tui/a/tui.ans": TUI_LIST,
  "tui/b/tui.ans": TUI_DAYS,
};

/** The terminal sample's studio.json: designed for the terminal when the project's scope has it. */
export function terminalSampleManifest(terminal: boolean) {
  const devices = terminal ? ["terminal"] : [];
  return {
    artifacts: [
      { kind: "terminal-demo", title: "trips CLI (simulated sample)", devices, variants: [{ id: "a", label: "A · Plan, then pick", entry: "cli/trips.tape" }], files: ["cli/trips.tape", "cli/trips.js", "cli/trips.cast"] },
      {
        kind: "tui",
        title: "trips TUI (simulated sample)",
        devices,
        variants: [
          { id: "a", label: "A · List and detail", entry: "tui/a/tui.ans" },
          { id: "b", label: "B · Day by day", entry: "tui/b/tui.ans" },
        ],
        files: ["tui/a/tui.ans", "tui/b/tui.ans"],
      },
    ],
  };
}

/** Write the terminal sample and its studio.json into a run's staging folder, as a designer agent would. */
export function writeTerminalSample(staging: string, terminal: boolean) {
  for (const [p, text] of Object.entries(TERMINAL_SAMPLE_FILES)) {
    mkdirSync(dirname(join(staging, p)), { recursive: true });
    writeFileSync(join(staging, p), text);
  }
  writeFileSync(join(staging, "studio.json"), `${JSON.stringify(terminalSampleManifest(terminal), null, 2)}\n`);
}

/** A designer's brief that asks for a terminal demo, a CLI or a TUI: the fake designer then hands in the terminal sample. */
export const TERMINAL_BRIEF = /\b(terminal|CLI|TUI)\b/i;

/** The brief and the device scope a designer run's envelope gives it (runs.ts, designerEnvelope). */
export function designerAsk(prompt: string): { brief: string; terminal: boolean } {
  const brief = /\n## The brief\n\n([\s\S]*?)\n\n## Where you work\n/.exec(prompt)?.[1] ?? "";
  const devices = /\n## The project's devices: ([^\n]*)\n/.exec(prompt)?.[1] ?? "";
  return { brief, terminal: devices.split(", ").includes("terminal") };
}

/**
 * The variants a revision brief asks the designer to change: its lines "- Revise `<id>` …", which the revision brief
 * writes (server/studio/revise.ts). None named: every variant.
 */
export function variantsToRevise(brief: string): string[] {
  return [...brief.matchAll(/^- Revise `([^`]+)`/gm)].map((m) => m[1]);
}

const REVISION_NOTE = "Simulated revision: the fake runtime's designer marked this variant revised in answer to the PE; nothing was redesigned.";

/** A sample file of a revised variant, marked so the owner and the PE can see the simulated revision. */
function revisedText(path: string, text: string): string {
  if (path.endsWith(".html")) return text.includes("<body>\n") ? text.replace("<body>\n", `<body>\n<p class="sim">${REVISION_NOTE}</p>\n`) : `${text}<p class="sim">${REVISION_NOTE}</p>\n`;
  if (path.endsWith(".ans")) return text.replace("(simulated sample)", "(simulated revision)");
  if (path.endsWith(".tape")) return `${text}# ${REVISION_NOTE}\n`;
  if (path.endsWith(".js")) return `${text}// ${REVISION_NOTE}\n`;
  return text;
}

/**
 * The fake designer's revision (ORC-029 pass 4). Its staging folder starts with the files of the version it revises,
 * one of its own samples: it marks the files of each variant the brief asks it to revise (those in the variant's
 * entry folder), leaves the others as they are, and writes a studio.json with that one artifact, as a designer agent
 * would. Returns its final message. Throws when the files are not one of its samples: it revises only what it made.
 */
export function reviseSample(staging: string, opts: { terminal: boolean; variants: string[] }): string {
  const samples = [SAMPLE_MANIFEST.artifacts[0], ...terminalSampleManifest(opts.terminal).artifacts];
  const manifest = samples.find((m) => m.files.every((f) => existsSync(join(staging, f))));
  if (!manifest) throw new Error("its working directory does not hold one of its own samples, and it revises only what it made");
  const asked = opts.variants.length ? manifest.variants.filter((v) => opts.variants.includes(v.id)) : manifest.variants;
  const folder = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
  for (const f of manifest.files.filter((f) => asked.some((v) => folder(f) === folder(v.entry)))) writeFileSync(join(staging, f), revisedText(f, readFileSync(join(staging, f), "utf8")));
  writeFileSync(join(staging, "studio.json"), `${JSON.stringify({ artifacts: [manifest] }, null, 2)}\n`);
  return `Revised ${asked.map((v) => v.label).join(" and ") || "nothing"} of ${manifest.title} in answer to the PE; the other variants are as they were (simulated revision).`;
}

/**
 * The earlier asks a PE envelope lists on a later pass ("- `pev-3` on `b` (…), pass 1, …"; server/studio/pe.ts), by
 * the variant each is on (none: the whole artifact).
 */
export function earlierAsksIn(prompt: string): { ask: string; variant?: string }[] {
  return [...prompt.matchAll(/^- `([^`]+)` on (?:`([^`]+)`|the whole artifact)[^\n]*, pass \d+, /gm)].map((m) => ({ ask: m[1], ...(m[2] !== undefined ? { variant: m[2] } : {}) }));
}

/**
 * What the fake runtime's PE answers (ORC-029 passes 3 and 4): it reads the version's manifest.json, as a PE agent
 * reads the folder, and its envelope. On an artifact's first version with two or more variants it asks for a stand-in
 * change to the second (feasible-if), and raises one stand-in open case on it, so the demo shows the designer
 * revising in answer and a question going to the owner through the lead. On every other version it checks each
 * earlier ask its envelope lists, finds each met, and agrees. Every reason says it is simulated: nothing was judged.
 */
export function fakePeAnswer(folder: string, prompt = ""): { ok: true; text: string } | { ok: false; error: string } {
  let variants: { id: string }[];
  let version: unknown;
  try {
    const m = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { variants?: unknown; version?: unknown };
    variants = Array.isArray(m.variants) ? m.variants.filter((v): v is { id: string } => !!v && typeof (v as { id?: unknown }).id === "string") : [];
    version = m.version;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const reasons = "Simulated: the fake runtime's PE, not an agent. It judged nothing about feasibility, scale, longevity or budget;";
  const objects = version === 1 && variants.length >= 2;
  const asks = earlierAsksIn(prompt);
  const earlier = (variant?: string) => {
    const mine = asks.filter((x) => variant === undefined || x.variant === undefined || x.variant === variant);
    return mine.length ? { earlier: mine.map((x) => ({ ask: x.ask, met: true })) } : {};
  };
  const agrees = (variant?: string) => ({ ...(variant !== undefined ? { variant } : {}), ...earlier(variant), verdict: "feasible", reasons: `${reasons} it agrees so the demo can go on${asks.length ? ", and finds each earlier ask met" : ""}.` });
  const verdicts = variants.length
    ? variants.map((v, i) =>
        objects && i === 1
          ? {
              variant: v.id,
              verdict: "feasible-if",
              reasons: `${reasons} it asks for a change on the first version, so the demo shows the designer revising.`,
              change: "Simulated: a stand-in change, which the fake designer marks on this variant in a revision.",
              openCases: [{ text: "Simulated: when a friend drops out after the cabin is booked, who pays their share?", why: "Simulated: a stand-in question, so the demo shows an open case going to the owner through the lead." }],
            }
          : agrees(v.id),
      )
    : [agrees()];
  return { ok: true, text: `Simulated PE review: no agent read this version.\n\n\`\`\`json\n${JSON.stringify({ verdicts }, null, 2)}\n\`\`\`\n` };
}
