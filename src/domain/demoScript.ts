// ORC-017 §5: the words of the sample story, "Weekend Trips (sample)". The fake runtime reads its output
// summaries, review findings and breakdown items from here, keyed by task id, and falls back to neutral
// wording. Nothing here claims a real run: every run that uses these words is labelled simulated by the
// run record, the banner and the chips, so the text itself carries no "(Simulated)" prefix.

import type { ArtifactKind } from "./types";

/** One finding a first review round reports (the repair step then fixes it). */
export interface ScriptFinding {
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

/** A breakdown item in the lead-proposal shape the service accepts (`approach` alone is enough). */
export interface ScriptBreakdownItem {
  title: string;
  area?: string;
  whyNow?: string;
  outcome: string;
  benefit?: string;
  approach: string;
  acceptance: string[];
  options?: { id: string; name: string; approach: string; benefit: string; effort: string; risks: string; reversibility: string }[];
  recommendedOptionId?: string;
  rationale?: string;
  uncertainty?: string;
  flowId?: string;
  priority?: number;
  dependsOn?: (number | string)[];
}

export interface TaskScript {
  /** Output summaries by "<stepId>.<output>" (exact step) or "<output>" (any step with that output name). */
  outputs?: Record<string, string>;
  /** Review findings by step id (a first round reports one); "*" is the default for any review step. */
  findings?: Record<string, ScriptFinding>;
  /** Breakdown items by step id. An empty list means the goal is met. */
  breakdown?: Record<string, ScriptBreakdownItem[]>;
}

/** The project's areas (tracks). */
export const DEMO_AREAS = ["Offline maps", "Trip sharing", "Packing lists", "Accessibility", "Reliability"] as const;

export const DEMO_SCRIPT: Record<string, TaskScript> = {
  "WT-002": {
    outputs: {
      "S1.change": "Shows an offline banner with the age of the cached map when there is no signal (+96 −12, 4 files)",
      "S1.handoff": "The banner reads the tile cache's last sync time; no new permissions.",
      "S3.change": "Moved the offline banner under the search field on small phones (+18 −6, 1 file)",
      verification: "The banner shows and hides with the connection state; checks passed on the final change.",
    },
    findings: { "*": { title: "The offline banner hides the compass on small phones", detail: "Below 360 px wide the banner overlaps the compass control; stack it under the search field instead.", file: "src/map/OfflineBanner.tsx", line: 42 } },
  },
  "WT-003": {
    outputs: {
      design: "Download by trail: one button on the trail page saves its tiles for 20 km around the route, with the size shown before you start and progress while it runs.",
      "S2.change": "Download a trail's tiles with a size estimate and progress (+188 −9, 7 files)",
      "S2.handoff": "Downloads resume after the app is closed; the estimate uses the zoom levels the map actually shows.",
      "S5.change": "Asks once before a download over 50 MB on cellular data (+22 −3, 2 files)",
      verification: "A trail's tiles download, resume and show offline; checks passed on the final change.",
    },
    findings: {
      S3: { title: "A download can start on cellular data without a warning", detail: "Ask once before a download over 50 MB on a cellular connection.", file: "src/map/download.ts", line: 71 },
      S4: { title: "The size estimate is shown after the download starts", detail: "Show the estimate before the button is pressed, so the choice is informed.", file: "src/map/DownloadButton.tsx", line: 15 },
    },
  },
  "WT-004": {
    outputs: {
      plan: "Three parts: invite friends with a link, see who is coming, and join without an account.",
      "S2.next": "One part remains: the plan should open offline for everyone who was invited.",
      "S2-i2.next": "All parts landed; the goal is met.",
      report: "Trip sharing is complete: invite links, the attendee list, guest access and an offline copy of the plan all landed.",
    },
    breakdown: {
      S1: [
        {
          title: "Invite friends with a link",
          area: "Trip sharing",
          whyNow: "Nobody can see a plan yet except the person who made it.",
          outcome: "A trip has a link that opens it for anyone who has it.",
          benefit: "Inviting is one message, not an account per friend.",
          approach: "Signed invite links that expire after 7 days, on the invite sheet designed in WT-013",
          acceptance: ["A link opens the trip", "An expired link says so"],
          flowId: "change",
        },
        {
          title: "See who is coming",
          area: "Trip sharing",
          whyNow: "Invited friends have no way to answer.",
          outcome: "The trip page lists who is coming, who might, and who is not.",
          benefit: "No separate group chat to count heads.",
          approach: "An attendee list with yes, maybe and no, stored with the trip",
          acceptance: ["Each invitee can answer once and change it", "The list updates for everyone"],
          flowId: "change",
          dependsOn: [0],
        },
        {
          title: "Join a trip without an account",
          area: "Trip sharing",
          whyNow: "Most friends will not create an account to see one hike.",
          outcome: "An invitee can join with a name only.",
          benefit: "No sign-up wall for occasional friends.",
          approach: "A guest link that keeps a name and the link id for 30 days",
          acceptance: ["A guest joins with a name", "Guest data is removed after 30 days"],
          options: [
            { id: "A", name: "Guest link", approach: "A guest link that keeps a name and the link id for 30 days", benefit: "One tap to join; the name persists on the trip", effort: "Small", risks: "Keeps a name and a link id for 30 days", reversibility: "High" },
            { id: "B", name: "One-time code", approach: "A six-digit code typed on each visit; nothing is stored", benefit: "Nothing is kept", effort: "Small", risks: "Friends re-enter the code on every visit", reversibility: "High" },
          ],
          recommendedOptionId: "A",
          rationale: "A guest link is one tap and keeps the attendee list meaningful.",
          uncertainty: "It changes what data is kept: a guest link stores a name and a link id for 30 days; a code stores nothing. Your call.",
          flowId: "change",
          dependsOn: [0],
        },
      ],
      S2: [
        {
          title: "Share the plan offline",
          area: "Trip sharing",
          whyNow: "A shared plan is useless at a trailhead with no signal.",
          outcome: "Everyone who opened the trip keeps a copy that works offline.",
          benefit: "The plan is there when the signal is not.",
          approach: "Cache the trip page and its map tiles on first open",
          acceptance: ["A trip opened once shows offline", "Changes sync when the signal returns"],
          flowId: "change",
        },
      ],
    },
  },
  "WT-004.1": {
    outputs: {
      "S1.change": "Signed invite links that expire after 7 days (+132 −4, 4 files)",
      "S1.handoff": "Links are signed with the app's link key; expiry is checked when the link is opened.",
      "S3.change": "Signs the trip id into the invite link and refuses a link opened on another trip (+23 −6, 2 files)",
      verification: "A link opens only its own trip and an expired link says so; checks passed on the final change.",
    },
    // ORC-021: the security review beside the code review found what the code review did not; the repair round fixed it.
    findings: {
      SR1: {
        title: "Invite links are not scoped to the trip",
        detail: "The signature covers the token and its expiry but not the trip id, so a valid link for one trip opened another when the id in the address was swapped. Sign the trip id into the link and refuse a link opened on a different trip.",
        file: "src/server/links.ts",
        line: 48,
      },
    },
  },
  "WT-004.2": {
    outputs: {
      "S1.change": "Attendee list on the trip page with yes, maybe and no (+74 −8, 3 files)",
      "S1.handoff": "Answers are stored with the trip; no notifications yet.",
      "S3.change": "Sorted attendees by answer, then by name (+9 −2, 1 file)",
      verification: "Each invitee answers once and can change it; the list updates for everyone; checks passed on the final change.",
    },
    findings: { "*": { title: "The attendee list is not sorted", detail: "Sort by answer, then by name, so the people who are coming read first.", file: "src/trip/Attendees.tsx", line: 18 } },
  },
  "WT-004.3": {
    outputs: {
      "S1.change": "Guest links: join a trip with a name only, kept for 30 days (+61 −4, 3 files)",
      "S1.handoff": "Guest records are removed by the nightly cleanup; the attendee list shows guests with a small mark.",
      "S3.change": "Removed guest records exactly at 30 days, not at the next cleanup after (+7 −2, 1 file)",
      verification: "A guest joins with a name and is removed after 30 days; checks passed on the final change.",
    },
    findings: { "*": { title: "Guest records can outlive 30 days by up to a day", detail: "The cleanup runs nightly; remove records at exactly 30 days from joining.", file: "src/trip/guests.ts", line: 40 } },
  },
  "WT-004.4": {
    outputs: {
      "S1.change": "Caches the trip page and its map tiles on first open (+88 −6, 4 files)",
      "S1.handoff": "Reuses the tile cache from offline maps; the trip page is stored as JSON.",
      "S3.change": "Syncs a cached plan's changes when the signal returns (+24 −4, 2 files)",
      verification: "A trip opened once shows offline and syncs its changes later; checks passed on the final change.",
    },
    findings: { "*": { title: "Edits made offline are lost when the signal returns", detail: "Queue offline edits and replay them on reconnect.", file: "src/trip/sync.ts", line: 62 } },
  },
  "WT-006": {
    outputs: {
      "S1.change": "Shared packing list with live check-off for everyone on the trip (+112 −14, 5 files)",
      "S1.handoff": "Check-offs sync through the trip record; conflicts are resolved by the newest write.",
      "S3.change": "Retries a check-off on a version conflict instead of dropping it (+15 −4, 1 file)",
      verification: "Two people checking items at once both see every change; checks passed on the final change.",
    },
    findings: { "*": { title: "Two people checking the same item at once lose one update", detail: "Use the server's version number and retry on conflict.", file: "src/packing/sync.ts", line: 56 } },
  },
  "WT-007": {
    outputs: {
      design: "VoiceOver reads the trail name, distance, elevation and the next waypoint; pins are grouped by trail, and the map has a rotor for waypoints.",
      "S2.change": "Accessibility labels and a waypoint rotor for the trail map (+142 −11, 6 files)",
      "S2.handoff": "Distances are read in the phone's unit setting for now; the UX review should confirm.",
      "S5.change": "Pins announce the trail name and distance (+12 −3, 1 file)",
      verification: "VoiceOver reads the trail name, distance, elevation and the next waypoint; checks passed on the final change.",
    },
    findings: { S3: { title: "Map pins announce their index, not the trail name", detail: "Set the accessibility label to the trail name and distance.", file: "src/map/Pins.tsx", line: 33 } },
  },
  "WT-009": {
    outputs: {
      reproduction: "Reproduced: killing the app during an edit loses the plan in 3 of 3 runs; the draft is kept in memory only.",
      "S2.change": "Saves a draft of the plan on every edit and restores it on launch (+58 −7, 3 files)",
      "S2.handoff": "The draft lives in local storage keyed by trip id; the restore prompt shows once.",
      "S4.change": "Clears the draft after a successful save (+6 −1, 1 file)",
      verification: "Killing the app mid-edit no longer loses the plan: the reproduction passes; checks passed on the final change.",
    },
    findings: { "*": { title: "The restored draft is not cleared after a successful save", detail: "Clear the draft once the plan is saved, or it reappears on the next launch.", file: "src/trip/draft.ts", line: 24 } },
  },
  "WT-010": {
    outputs: {
      "S1.change": "Weather alert for the trip day on the trip page (+66 −5, 3 files)",
      "S1.handoff": "Alerts come from the forecast service once a day; nothing is fetched offline.",
      "S3.change": "Hides the alert when the forecast is older than a day (+8 −2, 1 file)",
      verification: "A weather alert shows for the trip day and hides when stale; checks passed on the final change.",
    },
    findings: { "*": { title: "A stale forecast is shown as current", detail: "Hide the alert when the forecast is older than a day.", file: "src/trip/Weather.tsx", line: 27 } },
  },
  // ORC-021: an Investigation. The result is a spec, not code; the review of the evidence leaves one note that blocks nothing.
  "WT-012": {
    outputs: {
      report: "GPS is polled once a second for the whole hike, screen off included, and every fix redraws the hidden map: together 61% of the drain over a 5-hour recording (GPS 38%, redraws 23%). Tile loading and the rest account for the remainder.",
      "S2.findings": "No gaps that block a spec. One note: the figures come from one phone on one hike.",
      brief: "Proposed follow-up: a Change task that polls the location every 30 seconds while the screen is off and stops redrawing the map while it is hidden. Expected to cut the drain by about half; its acceptance is a second phone's recording of the same hike.",
    },
    findings: { S2: { title: "Figures from one phone on one hike", detail: "The recording is one phone on one hike. The shares are large enough to act on; the follow-up should confirm the saving on a second phone." } },
  },
  // ORC-021: a Design. The UX review's one finding is revised away; the lead's brief hands the design to the invite-link part of trip sharing.
  "WT-013": {
    outputs: {
      "S1.design": "An invite sheet from a Share button on the trip page: the link, who it is for and when it expires, with Copy and Share. States: no link yet (Make a link), link ready, link expired (Make a new link). Plain copy; no account mentioned anywhere.",
      "S2.findings": "1 finding: the expiry reads as a date.",
      "S3.design": "Revised: the sheet says “Expires in 6 days” with “After that, make a new link” under it; the expired state leads with Make a new link and keeps the old link out of reach.",
      "S2-i2.findings": "No findings: the expiry reads as time left, and each state has one clear action.",
      brief: "Build the invite sheet as designed: a Share button on the trip page, the link with the time left before it expires, Copy and Share, and an expired state that leads with Make a new link. The invite-link part of trip sharing builds from this.",
    },
    findings: { S2: { title: "The expiry is shown as a date only", detail: "A date under a trip link reads as the trip date. Say how long is left (“Expires in 6 days”) and what happens after it." } },
  },
};

/** Ideas a simulated planning run proposes, in order; one that is already on the board is skipped. */
export const PLANNING_IDEAS: { title: string; area: string; whyNow: string; outcome: string; benefit: string; approach: string; acceptance: string[] }[] = [
  {
    title: "Remember the last trail you looked at",
    area: "Offline maps",
    whyNow: "The map opens on the whole region every time, so people search for the same trail again.",
    outcome: "The map opens on the trail you last looked at.",
    benefit: "One tap less at the trailhead.",
    approach: "Store the last trail id and restore the map position on launch",
    acceptance: ["Opening the app shows the last trail", "Clearing the trail returns to the region view"],
  },
  {
    title: "Show sunrise and sunset for the trip day",
    area: "Reliability",
    whyNow: "Groups plan their start from memory and misjudge the light.",
    outcome: "The trip page shows sunrise and sunset for its day and place.",
    benefit: "A start time that fits the daylight.",
    approach: "Compute sun times locally from the trailhead coordinates and the date",
    acceptance: ["Times match a reference within two minutes", "Works offline"],
  },
  {
    title: "Export a packing list as plain text",
    area: "Packing lists",
    whyNow: "People paste their lists into chats by hand.",
    outcome: "A packing list can be copied as plain text.",
    benefit: "The list travels to any chat or notes app.",
    approach: "A Copy button that writes the list as one line per item",
    acceptance: ["Copied text lists every item with its checked state"],
  },
];

/** The neutral fallback summary for an output kind; "(simulated)" stays because nothing else labels the text. */
export function neutralSummary(kind: ArtifactKind, o: { found?: number; items?: number } = {}): string {
  switch (kind) {
    case "code-change":
      return "Implemented the change (simulated)";
    case "handoff":
      return "Notes for the reviewer (simulated)";
    case "design":
      return "Design notes for the implementer (simulated)";
    case "plan":
      return "Plan (simulated)";
    case "breakdown":
      return o.items ? `Split into ${o.items} part${o.items === 1 ? "" : "s"} (simulated)` : "Goal met (simulated)";
    case "review-findings":
      return o.found ? `${o.found} finding${o.found === 1 ? "" : "s"} (simulated)` : "No blocking findings (simulated)";
    case "verification":
      return "Verified against the acceptance criteria (simulated)";
    case "report":
      return "Report (simulated)";
    case "brief":
      return "Brief (simulated)";
    case "check-results":
      return "Check results (simulated)";
  }
}

/** The scripted summary for a task's output, if the story has one. */
export function scriptedSummary(taskId: string, stepId: string, output: string): string | undefined {
  const t = DEMO_SCRIPT[taskId];
  return t?.outputs?.[`${stepId}.${output}`] ?? t?.outputs?.[output];
}

/** The one finding a first review round of this task's step reports, if the story has one. */
export function scriptedFinding(taskId: string, stepId: string): ScriptFinding | undefined {
  const f = DEMO_SCRIPT[taskId]?.findings;
  return f?.[stepId] ?? f?.["*"];
}

/** The neutral finding a first review round reports when the story has none. */
export const NEUTRAL_FINDING: ScriptFinding = { title: "A small defect for the repair step to fix", detail: "In live mode a real reviewer names the file, the line and the smallest fix." };

/**
 * The breakdown items a goal step proposes: the story's for this step, else two neutral parts named after
 * the goal ("Part 1 of <goal title>"), never after a run. `undefined` for a later iteration means the goal is met.
 */
export function breakdownItems(taskId: string, stepId: string, goalTitle: string | undefined): ScriptBreakdownItem[] {
  const scripted = DEMO_SCRIPT[taskId]?.breakdown?.[stepId];
  if (scripted) return structuredClone(scripted);
  const of = goalTitle ? ` of ${goalTitle}` : "";
  return [
    { title: `Part 1${of}`, outcome: `The first part${of} is done (simulated)`, approach: "A small change", acceptance: ["The first part is verified"], flowId: "change", priority: 3 },
    { title: `Part 2${of}`, outcome: `The second part${of} is done (simulated)`, approach: "A small change", acceptance: ["The second part is verified"], flowId: "change", priority: 3, dependsOn: [0] },
  ];
}
