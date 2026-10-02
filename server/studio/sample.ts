// What the fake runtime's designer hands in (ORC-029 pass 3a): a small sample prototype of Weekend Trips' trip plan,
// in two variants, for desktop and mobile, in plain HTML and CSS with nothing fetched (the prototype server's
// content security policy allows no network). It goes through the same
// studio.json check and import as a real designer's work, so the demo and the tests need no agent. Every page says
// it is a simulated sample.

import { mkdirSync, writeFileSync } from "node:fs";
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
