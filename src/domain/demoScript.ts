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
  patternId?: string;
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
          approach: "Signed invite links that expire after 7 days",
          acceptance: ["A link opens the trip", "An expired link says so"],
          patternId: "change",
        },
        {
          title: "See who is coming",
          area: "Trip sharing",
          whyNow: "Invited friends have no way to answer.",
          outcome: "The trip page lists who is coming, who might, and who is not.",
          benefit: "No separate group chat to count heads.",
          approach: "An attendee list with yes, maybe and no, stored with the trip",
          acceptance: ["Each invitee can answer once and change it", "The list updates for everyone"],
          patternId: "change",
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
          patternId: "change",
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
          patternId: "change",
        },
      ],
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
};

// ---------- the history (ORC-018 §7) ----------
//
// Twenty-four earlier tasks, settled between 30 and 9 days before the demo starts, so the board folds them
// under "Done earlier" and the Compare page has groups to show. The words are here; the mechanics (runs,
// checks, reviews, pull requests, outcomes) are built by `demo.ts` through the real domain functions, and
// every number that is not a word comes from a generator seeded by the task's number, never from Math.random.

/** One review round that found something: the findings, and the repair that answered them. */
export interface HistoryRound {
  findings: ScriptFinding[];
  /** The repair's change summary (the size is added by the builder). */
  repair: string;
  /** Files the repair touched; the task's first file when absent. */
  paths?: string[];
}

/** A first check run that fails `test`; the service turns it into an error finding the repair fixes. */
export interface HistoryFailingTest {
  file: string;
  name: string;
  message: string;
}

/** The fix task a send-back from the Review list creates (a Bug fix pipeline, chosen by the service). */
export interface HistoryFix {
  reproduction: string;
  change: string;
  files: string[];
  handoff: string;
  rounds: HistoryRound[];
  verified: string;
}

export interface HistoryTask {
  id: string;
  pattern: "change" | "change-cross-review" | "bugfix";
  area: (typeof DEMO_AREAS)[number];
  title: string;
  whyNow: string;
  outcome: string;
  benefit: string;
  /** Option A, chosen: [name, approach]; option B: [name, approach, benefit, risks]. */
  option: [string, string];
  alternative: [string, string, string, string];
  rationale: string;
  acceptance: string[];
  /** Bug fix only: the reproduction report. */
  reproduction?: string;
  change: string;
  files: string[];
  handoff: string;
  failingTest?: HistoryFailingTest;
  /** Review rounds that found something, in order. After the last one the review is clean. */
  rounds: HistoryRound[];
  /** The verification, without the closing "checks passed" clause the builder adds. */
  verified: string;
  /** You asked Claude to write it; the pattern then has Codex review it. Cross-review tasks only. */
  claudeWrites?: true;
  /** How it left: merged in the app at your request (absent), merged by you on GitHub, or closed there without merging. */
  delivery?: "github-merge" | "github-close";
  /** You cancelled it while the repair ran, for this reason. */
  cancelled?: string;
  /** It ran the version of the pattern before the fix step wrote a handoff for the reviewer. */
  olderVersion?: true;
}

/** A landed task you sent back as a fix from the Review list, after `after` had run; the fix runs next. */
export interface HistorySendBack {
  origin: string;
  after: string;
  note: string;
  fix: HistoryFix;
}

export const HISTORY: HistoryTask[] = [
  // ---- Change ----
  {
    id: "WT-101",
    pattern: "change",
    area: "Offline maps",
    title: "Trail list with distance and elevation",
    whyNow: "The app opens on an empty screen; the trail data is loaded but nothing shows it.",
    outcome: "A list of trails with the distance and the climb of each, sorted by name.",
    benefit: "The first screen answers the first question: which hikes are there?",
    option: ["A plain list", "One row per trail with name, distance and climb"],
    alternative: ["A map first", "Open on the map with every trail drawn", "Shows where trails are", "Slow to read on a phone; the map comes next anyway"],
    rationale: "A list is readable at a glance; the map follows on the trail page.",
    acceptance: ["Every trail in the data appears once", "Distance and climb use the region's units"],
    change: "Trail list screen with distance and climb per row",
    files: ["src/trails/TrailList.tsx", "src/trails/TrailRow.tsx", "src/trails/format.ts", "src/trails/TrailList.test.tsx"],
    handoff: "The list reads the bundled trail data; sorting is by name for now.",
    rounds: [],
    verified: "The list shows every trail with its distance and climb",
  },
  {
    id: "WT-102",
    pattern: "change",
    area: "Offline maps",
    title: "Trail page with the route on the map",
    whyNow: "A trail is a name and two numbers; nobody can see where it goes.",
    outcome: "Tapping a trail opens a page with the route drawn on the map and the key facts above it.",
    benefit: "You see the route before you commit a weekend to it.",
    option: ["Route on the map", "Draw the route as a line on the map tile layer, facts in a header"],
    alternative: ["Static route image", "Render the route once to an image", "Cheap to show", "No zoom, no position; a dead end for offline maps"],
    rationale: "The live map is the base every later map feature builds on.",
    acceptance: ["The route is drawn on the map", "The header shows distance, climb and the trailhead"],
    change: "Trail page with the route drawn on the map and a facts header",
    files: ["src/trails/TrailPage.tsx", "src/map/MapView.tsx", "src/map/RouteLayer.tsx", "src/map/RouteLayer.test.tsx", "src/trails/TrailHeader.tsx"],
    handoff: "The route layer takes a list of points; the map centres on the route's bounds when the page opens.",
    rounds: [
      {
        findings: [{ title: "The route is redrawn on every map move", detail: "The layer rebuilds its path on each pan; memoise it on the trail id so panning stays smooth on older phones.", file: "src/map/RouteLayer.tsx", line: 27 }],
        repair: "Memoised the route path on the trail id",
        paths: ["src/map/RouteLayer.tsx", "src/map/RouteLayer.test.tsx"],
      },
    ],
    verified: "A trail opens with its route drawn and the facts above it",
  },
  {
    id: "WT-103",
    pattern: "change",
    area: "Trip sharing",
    title: "Create a trip from a trail",
    whyNow: "There is no notion of a trip yet, only trails; a plan has nowhere to live.",
    outcome: "From a trail page, one tap creates a trip with that trail, a date and a name.",
    benefit: "The plan starts where the decision is made.",
    option: ["Trip from the trail page", "A Create trip button on the trail page that makes a trip record with the trail"],
    alternative: ["Trips first", "A separate trips screen where you pick a trail from a list", "Keeps trips in one place", "Two screens for one decision"],
    rationale: "People choose a trail and then plan; the button belongs on the trail.",
    acceptance: ["A trip is created with the trail, a date and a default name", "The new trip opens"],
    change: "Create trip from the trail page, with a trip record and a trip page",
    files: ["src/trip/createTrip.ts", "src/trip/createTrip.test.ts", "src/trip/TripPage.tsx", "src/trails/TrailPage.tsx"],
    handoff: "Trip ids are random and local for now; the record shape is in trip/types.ts.",
    rounds: [],
    verified: "A tap on the trail page creates and opens a trip",
    delivery: "github-merge",
  },
  {
    id: "WT-104",
    pattern: "change",
    area: "Trip sharing",
    title: "Pick a trip date, with the next weekend as the default",
    whyNow: "A new trip takes today's date, which is never the day of the hike.",
    outcome: "A new trip defaults to the coming Saturday, and the date can be changed with the system picker.",
    benefit: "One tap less for the common case, and the right date for most trips.",
    option: ["Default to Saturday", "Compute the next Saturday in the phone's time zone; use the platform date picker"],
    alternative: ["Ask every time", "Open the picker on creation", "No wrong default", "An extra step on every trip"],
    rationale: "Weekend trips happen on weekends; a good default beats a question.",
    acceptance: ["A trip created on a weekday defaults to the coming Saturday", "The date can be changed and is saved"],
    change: "Next-Saturday default and a date picker on the trip page",
    files: ["src/trip/dates.ts", "src/trip/dates.test.ts", "src/trip/TripPage.tsx", "src/trip/DatePicker.tsx"],
    handoff: "The weekend rule lives in trip/dates.ts; the picker is the platform's.",
    failingTest: { file: "src/trip/dates.test.ts", name: "dates › next Saturday from a Saturday is the following week", message: "AssertionError: expected 2026-09-05, got 2026-08-29" },
    rounds: [
      {
        findings: [{ title: "The time zone is read from the device, not the trip", detail: "Next Saturday is computed in the device zone; a trip planned abroad shifts by a day. Use the trailhead's zone when the trail has one.", file: "src/trip/dates.ts", line: 14 }],
        repair: "Next Saturday is computed in the trailhead's time zone, and a Saturday rolls to the following week",
        paths: ["src/trip/dates.ts", "src/trip/dates.test.ts"],
      },
    ],
    verified: "A new trip defaults to the coming Saturday and keeps a changed date",
  },
  {
    id: "WT-105",
    pattern: "change",
    area: "Reliability",
    title: "Keep trips on the phone",
    whyNow: "Trips live in memory and are gone when the app closes.",
    outcome: "Trips are saved on the phone and are there again after the app restarts.",
    benefit: "A plan made on Tuesday is still there on Saturday.",
    option: ["A local store", "Write each trip to a local database on every change; load all at start"],
    alternative: ["Server first", "Save trips to a server and cache them", "Works across devices", "Needs accounts and a connection; both are out of scope for now"],
    rationale: "Local first is what the research asks for; sync can come later.",
    acceptance: ["A trip survives a restart", "Deleting a trip removes it from the store"],
    change: "Local trip store with load at start and write on change",
    files: ["src/storage/tripStore.ts", "src/storage/tripStore.test.ts", "src/trip/createTrip.ts", "src/app/boot.ts"],
    handoff: "Writes are debounced by 300 ms; the store is opened once at boot.",
    failingTest: { file: "src/storage/tripStore.test.ts", name: "tripStore › a deleted trip is not loaded again", message: "AssertionError: expected [] to have length 0, got 1" },
    rounds: [
      {
        findings: [{ title: "A delete during the debounce window is written back", detail: "The debounced write of the deleted trip lands after the delete; cancel the pending write when a trip is removed.", file: "src/storage/tripStore.ts", line: 58 }],
        repair: "Cancels a trip's pending write when the trip is deleted",
        paths: ["src/storage/tripStore.ts", "src/storage/tripStore.test.ts"],
      },
    ],
    verified: "Trips survive a restart and a deleted trip stays deleted",
  },
  {
    id: "WT-106",
    pattern: "change",
    area: "Packing lists",
    title: "A packing list the organiser can edit",
    whyNow: "Packing is decided from memory and lost in chat.",
    outcome: "Every trip has a packing list; the organiser adds, renames and removes items.",
    benefit: "The list exists before anyone asks who brings the stove.",
    option: ["A list per trip", "A plain editable list stored with the trip"],
    alternative: ["A shared template", "One list for all trips", "Nothing to set up", "Every trip is different; the template is wrong for most"],
    rationale: "Start with the simplest thing that holds the information; suggestions and check-off come later.",
    acceptance: ["Items can be added, renamed and removed", "The list is saved with the trip"],
    change: "Editable packing list on the trip page, stored with the trip",
    files: ["src/packing/PackingList.tsx", "src/packing/items.ts", "src/packing/items.test.ts", "src/trip/TripPage.tsx"],
    handoff: "Items have ids, so a rename never loses a check-off later.",
    rounds: [],
    verified: "The organiser edits the packing list and it is kept with the trip",
  },
  {
    id: "WT-107",
    pattern: "change",
    area: "Accessibility",
    title: "Dynamic Type on every screen",
    whyNow: "Two screens use fixed font sizes; at the largest text size the trail name is cut off.",
    outcome: "Every screen scales with the system text size and nothing is clipped.",
    benefit: "Readable with the text size people actually use.",
    option: ["Scale everything", "Replace fixed sizes with text styles; let rows grow"],
    alternative: ["Cap the size", "Limit the app to a medium text size", "No layout work", "Overrides the person's choice; fails the people it is for"],
    rationale: "The system setting is the person's decision; the layout adapts to it.",
    acceptance: ["No fixed font size remains", "The trail list and the trip page fit at the largest size"],
    change: "Text styles instead of fixed sizes on the trail list, trail page and trip page",
    files: ["src/trails/TrailRow.tsx", "src/trails/TrailHeader.tsx", "src/trip/TripPage.tsx", "src/ui/text.ts", "src/trails/TrailRow.test.tsx"],
    handoff: "A shared text style table replaces the sizes; rows have no fixed height now.",
    rounds: [
      {
        findings: [
          { title: "The facts header truncates at the largest size", detail: "Distance and climb share one line and the climb is cut; wrap them to two lines above the accessibility sizes.", file: "src/trails/TrailHeader.tsx", line: 31 },
          { title: "The date picker label keeps a fixed size", detail: "The one remaining fixed size; use the body style.", file: "src/trip/TripPage.tsx", line: 88 },
        ],
        repair: "Wraps the facts header at large sizes and gives the date label the body style",
        paths: ["src/trails/TrailHeader.tsx", "src/trip/TripPage.tsx"],
      },
    ],
    verified: "Every screen scales with the system text size and nothing clips at the largest",
  },
  {
    id: "WT-108",
    pattern: "change",
    area: "Offline maps",
    title: "Search trails by name",
    whyNow: "The list has several hundred trails; finding one means scrolling.",
    outcome: "A search field above the list filters trails by name as you type.",
    benefit: "A known trail is found in a few letters.",
    option: ["Filter as you type", "A search field that filters the list on each keystroke, case and accents ignored"],
    alternative: ["Search screen", "A separate search page with results", "Room for filters later", "One more screen for one field"],
    rationale: "A field above the list is where people look for it.",
    acceptance: ["Typing filters the list", "Case and accents do not matter", "An empty field shows every trail"],
    change: "Search field above the trail list, filtering by normalised name",
    files: ["src/trails/TrailList.tsx", "src/trails/search.ts", "src/trails/search.test.ts"],
    handoff: "Names are normalised once when the data loads; the filter is a prefix match per word.",
    rounds: [
      {
        findings: [{ title: "The filter runs on the main thread for every keystroke", detail: "With 5,000 trails each keystroke takes about 40 ms on an older phone; debounce the input by 150 ms.", file: "src/trails/TrailList.tsx", line: 44 }],
        repair: "Debounces the search input by 150 ms",
        paths: ["src/trails/TrailList.tsx"],
      },
      {
        findings: [{ title: "The debounce drops the final keystroke on a fast clear", detail: "Clearing the field within the debounce window leaves the old filter; flush the debounce when the field becomes empty.", file: "src/trails/TrailList.tsx", line: 49 }],
        repair: "Flushes the debounce when the field is cleared",
        paths: ["src/trails/TrailList.tsx", "src/trails/search.test.ts"],
      },
    ],
    verified: "Typing filters the list, case and accents ignored, and clearing the field shows every trail",
  },
  {
    id: "WT-109",
    pattern: "change",
    area: "Trip sharing",
    title: "Open the trailhead in the phone's maps app",
    whyNow: "People copy the trailhead coordinates into a maps app by hand.",
    outcome: "A Directions button on the trip page opens the trailhead in the phone's maps app.",
    benefit: "Getting to the start takes one tap.",
    option: ["Hand off to the maps app", "A button that opens the platform maps URL with the trailhead coordinates"],
    alternative: ["Directions in the app", "Fetch and draw a driving route", "Everything in one app", "A routing service, a connection and a lot of screen"],
    rationale: "The phone already has a maps app; hand off to it.",
    acceptance: ["The button opens the maps app at the trailhead", "It is hidden when the trail has no trailhead"],
    change: "Directions button that opens the trailhead in the platform maps app",
    files: ["src/trip/Directions.tsx", "src/trip/mapsUrl.ts", "src/trip/mapsUrl.test.ts", "src/trip/TripPage.tsx"],
    handoff: "The URL scheme differs per platform; both are in trip/mapsUrl.ts.",
    rounds: [],
    verified: "The button opens the trailhead in the maps app and hides when there is none",
    delivery: "github-close",
  },
  {
    id: "WT-110",
    pattern: "change",
    area: "Trip sharing",
    title: "Track the group's position in the background",
    whyNow: "Two people lost the group at a junction; the organiser wants to see where everyone is.",
    outcome: "The trip page shows where each person on the trip is, updated in the background.",
    benefit: "Nobody is lost at a fork.",
    option: ["Background location", "Share each phone's position every minute while the trip is active"],
    alternative: ["Check in at waypoints", "Each person taps a waypoint when they reach it", "No tracking, no battery cost", "Only as current as the last tap"],
    rationale: "Live positions answer the question directly.",
    acceptance: ["Positions update while the app is in the background", "Sharing stops when the trip ends"],
    change: "Background location sharing for active trips",
    files: ["src/location/background.ts", "src/location/background.test.ts", "src/trip/GroupMap.tsx", "src/trip/TripPage.tsx"],
    handoff: "Positions are sent every 60 s while a trip is active; the permission prompt is on the trip page.",
    rounds: [
      {
        findings: [
          { title: "Background location drains the battery", detail: "A position every minute for a day of hiking costs about a third of the battery on the test phone; the research note rules out background tracking.", file: "src/location/background.ts", line: 22 },
          { title: "Positions are sent with no signal", detail: "Offline, every send fails and is retried at once; queue them, or do not collect them.", file: "src/location/background.ts", line: 41 },
        ],
        repair: "",
      },
    ],
    verified: "",
    cancelled: "The vision rules out background location; check-ins at waypoints instead, later",
  },
  // ---- Change, reviewed by the other provider ----
  {
    id: "WT-111",
    pattern: "change-cross-review",
    area: "Reliability",
    title: "A version number on every trip record",
    whyNow: "Sharing and check-off will need to merge edits; without a version, the last write wins silently.",
    outcome: "Every trip record carries a version that increases on each write, and a stale write is refused.",
    benefit: "Two edits to the same trip never overwrite each other without notice.",
    option: ["Optimistic versions", "An integer version per record, checked and incremented on write"],
    alternative: ["Last write wins", "Keep overwriting", "Nothing to build", "Silent data loss once two people edit"],
    rationale: "A version is cheap now and impossible to retrofit once records are shared.",
    acceptance: ["A write with a stale version is refused", "The version increases on each successful write"],
    change: "Version field on trip records, checked on every write",
    files: ["src/storage/tripStore.ts", "src/storage/tripStore.test.ts", "src/trip/types.ts", "src/trip/update.ts"],
    handoff: "A refused write throws StaleWrite; callers reload and retry once.",
    rounds: [],
    verified: "A stale write is refused and the version increases on each write",
    claudeWrites: true,
  },
  {
    id: "WT-112",
    pattern: "change-cross-review",
    area: "Offline maps",
    title: "Mark trails as favourites",
    whyNow: "The same five trails are searched for every weekend.",
    outcome: "A trail can be marked as a favourite, and favourites are listed first.",
    benefit: "The usual trails are one tap away.",
    option: ["A star on the trail page", "A star toggle on the trail page; favourites sort to the top of the list"],
    alternative: ["Recent trails", "Show the last opened trails first", "Nothing to mark", "Recent is not the same as usual"],
    rationale: "Explicit favourites say what the person means.",
    acceptance: ["A starred trail appears first in the list", "The star survives a restart"],
    change: "Favourite toggle on the trail page, favourites first in the list",
    files: ["src/trails/favourites.ts", "src/trails/favourites.test.ts", "src/trails/TrailPage.tsx", "src/trails/TrailList.tsx"],
    handoff: "Favourites are a set of trail ids in the local store.",
    rounds: [
      {
        findings: [{ title: "Favourites are read from the store on every list render", detail: "Load the set once and keep it in memory; the list re-renders on every keystroke of the search.", file: "src/trails/TrailList.tsx", line: 23 }],
        repair: "Keeps the favourite set in memory and reads the store once",
        paths: ["src/trails/TrailList.tsx", "src/trails/favourites.ts"],
      },
    ],
    verified: "A starred trail lists first and the star survives a restart",
  },
  {
    id: "WT-113",
    pattern: "change-cross-review",
    area: "Offline maps",
    title: "Elevation profile on the trail page",
    whyNow: "The climb is one number; where it happens decides how hard the day is.",
    outcome: "The trail page shows an elevation profile along the route.",
    benefit: "You see whether the climb is a long grind or one steep wall.",
    option: ["A profile chart", "Draw elevation against distance from the route's points"],
    alternative: ["Climb per kilometre", "A table of the climb per kilometre", "No chart code", "Harder to read than a line"],
    rationale: "A profile is what hikers know how to read.",
    acceptance: ["The profile shows elevation against distance", "It fits the width of the phone"],
    change: "Elevation profile under the trail header",
    files: ["src/trails/Profile.tsx", "src/trails/profile.ts", "src/trails/profile.test.ts", "src/trails/TrailPage.tsx"],
    handoff: "Points are resampled to 200 for the chart; the raw route is untouched.",
    rounds: [],
    verified: "The trail page shows the elevation profile at the width of the phone",
  },
  {
    id: "WT-114",
    pattern: "change-cross-review",
    area: "Trip sharing",
    title: "Copy a trip as plain text",
    whyNow: "Until links exist, people retype the plan into the group chat.",
    outcome: "A Copy button puts the trip's trail, date, trailhead and packing list on the clipboard as plain text.",
    benefit: "The plan reaches the chat in one paste.",
    option: ["Plain text to the clipboard", "Format the trip as short lines and copy them"],
    alternative: ["Share sheet", "Open the platform share sheet with the text", "Reaches any app", "The sheet adds a step; the chat is the only target today"],
    rationale: "Copy is the fastest path to the one place the plan goes.",
    acceptance: ["The copied text names the trail, date, trailhead and items", "It fits in one chat message"],
    change: "Copy trip as plain text",
    files: ["src/trip/asText.ts", "src/trip/asText.test.ts", "src/trip/TripPage.tsx"],
    handoff: "One line per fact, items as a comma list; no markdown.",
    rounds: [],
    verified: "The copied text carries the trail, date, trailhead and items",
    claudeWrites: true,
    delivery: "github-merge",
  },
  {
    id: "WT-115",
    pattern: "change-cross-review",
    area: "Offline maps",
    title: "Water sources on the trail page",
    whyNow: "Pine Saddle has water only at the hut, 11 km in; nobody knew.",
    outcome: "The trail page lists water sources along the route with their distance from the start.",
    benefit: "You know how much to carry.",
    option: ["Water from the trail data", "Read water points from the trail data and list them with the distance along the route"],
    alternative: ["Community notes", "Let people add water notes", "Always current", "Nothing to read until people write"],
    rationale: "The data has the points; show them.",
    acceptance: ["Each water source is listed with its distance along the route", "A trail without water says so"],
    change: "Water sources listed with their distance along the route",
    files: ["src/trails/water.ts", "src/trails/water.test.ts", "src/trails/TrailPage.tsx"],
    handoff: "The distance along the route is the nearest route point's cumulative distance.",
    failingTest: { file: "src/trails/water.test.ts", name: "water › a source past the end of the route is clamped", message: "AssertionError: expected 18.0, got 18.4" },
    rounds: [
      {
        findings: [{ title: "The nearest point is found by a full scan", detail: "Every source scans every route point; with 200 resampled points that is fine, with the raw route it is not. Use the resampled route.", file: "src/trails/water.ts", line: 19 }],
        repair: "Measures water sources against the resampled route and clamps to its end",
        paths: ["src/trails/water.ts", "src/trails/water.test.ts"],
      },
    ],
    verified: "Water sources are listed with their distance, and a trail without water says so",
  },
  {
    id: "WT-116",
    pattern: "change-cross-review",
    area: "Accessibility",
    title: "Respect reduced motion on the map",
    whyNow: "The map flies to a route with a two-second animation, which the system's reduced motion setting should turn off.",
    outcome: "With reduced motion on, the map moves without animation.",
    benefit: "The app follows the person's motion setting.",
    option: ["Read the system setting", "Check the reduced motion setting and skip animated moves"],
    alternative: ["An in-app switch", "A setting inside the app", "Independent of the system", "A second place to set the same thing"],
    rationale: "The system setting is the one people already set.",
    acceptance: ["With reduced motion on, the map jumps instead of flying", "Other animations are unaffected"],
    change: "Map moves without animation when reduced motion is on",
    files: ["src/map/MapView.tsx", "src/map/motion.ts", "src/map/motion.test.ts"],
    handoff: "The setting is read once and observed for changes.",
    rounds: [],
    verified: "The map jumps instead of flying with reduced motion on",
    delivery: "github-merge",
  },
  {
    id: "WT-117",
    pattern: "change-cross-review",
    area: "Accessibility",
    title: "Trip page layout for small phones",
    whyNow: "On the smallest phone the trip page's header and the date overlap.",
    outcome: "The trip page lays out in one column below 360 pt wide and nothing overlaps.",
    benefit: "Usable on the phones people actually bring.",
    option: ["One column below 360 pt", "Stack the header, the date and the list below 360 pt"],
    alternative: ["Shrink the text", "Smaller text on small phones", "No layout change", "Fights Dynamic Type"],
    rationale: "Stacking keeps the text size and removes the overlap.",
    acceptance: ["Nothing overlaps at 320 pt", "The layout is unchanged above 360 pt"],
    change: "One-column trip page below 360 pt",
    files: ["src/trip/TripPage.tsx", "src/trip/layout.ts", "src/trip/TripPage.test.tsx"],
    handoff: "The breakpoint is in trip/layout.ts; the test renders at 320 and 390 pt.",
    rounds: [
      {
        findings: [{ title: "The Directions button falls off the screen at 320 pt", detail: "The button keeps its fixed width in the one-column layout; let it fill the column.", file: "src/trip/TripPage.tsx", line: 61 }],
        repair: "The Directions button fills the column below 360 pt",
        paths: ["src/trip/TripPage.tsx", "src/trip/TripPage.test.tsx"],
      },
    ],
    verified: "Nothing overlaps at 320 pt and wider phones are unchanged",
    claudeWrites: true,
  },
  {
    id: "WT-118",
    pattern: "change-cross-review",
    area: "Offline maps",
    title: "Import a route from a GPX file",
    whyNow: "Half the group's favourite trails are not in the bundled data; they have GPX files from past hikes.",
    outcome: "A GPX file opened with the app becomes a trail with its route, distance and climb.",
    benefit: "Your own trails, in the same list.",
    option: ["Open GPX files", "Register for GPX files; parse track points into a trail record"],
    alternative: ["Draw a route", "Draw a route on the map by hand", "No file needed", "Slow and inaccurate on a phone"],
    rationale: "The files exist; parsing them is the direct path.",
    acceptance: ["A GPX file becomes a trail with route, distance and climb", "A malformed file shows an error, not a crash"],
    change: "GPX import: track points become a trail with distance and climb",
    files: ["src/import/gpx.ts", "src/import/gpx.test.ts", "src/import/openFile.ts", "src/trails/TrailList.tsx"],
    handoff: "Only trk/trkseg/trkpt are read; waypoints and routes are ignored for now.",
    rounds: [
      {
        findings: [
          { title: "Climb counts GPS noise", detail: "Summing every uphill metre between points doubles the climb on a noisy track; smooth elevations over 5 points first.", file: "src/import/gpx.ts", line: 73 },
          { title: "A file with no track points imports an empty trail", detail: "Refuse a file with fewer than two points and say why.", file: "src/import/gpx.ts", line: 40 },
        ],
        repair: "Smooths elevations before summing the climb and refuses files with fewer than two points",
        paths: ["src/import/gpx.ts", "src/import/gpx.test.ts"],
      },
      {
        findings: [{ title: "Smoothing shortens the profile by two points at each end", detail: "The 5-point window drops the ends; pad the series so the profile keeps the start and the finish.", file: "src/import/gpx.ts", line: 81 }],
        repair: "Pads the elevation series so smoothing keeps both ends",
        paths: ["src/import/gpx.ts", "src/import/gpx.test.ts"],
      },
    ],
    verified: "A GPX file becomes a trail with the right distance and climb, and a malformed file is refused with a message",
  },
  // ---- Bug fix ----
  {
    id: "WT-119",
    pattern: "bugfix",
    area: "Offline maps",
    title: "Trail distances show in metres",
    whyNow: "The trail list says 14000 m where it should say 14 km.",
    outcome: "Distances over a kilometre show in kilometres with one decimal.",
    benefit: "Numbers people can read at a glance.",
    option: ["Fix the formatter", "Format metres as kilometres above 1,000 m"],
    alternative: ["Store kilometres", "Convert the data", "No formatting", "Loses precision for short trails"],
    rationale: "The data is right; the display is wrong.",
    acceptance: ["14,000 m shows as 14.0 km", "800 m shows as 800 m"],
    reproduction: "Reproduced: the trail list shows 14000 m for Ridge Loop in 3 of 3 runs; the formatter never converts.",
    change: "Formats distances above a kilometre as kilometres with one decimal",
    files: ["src/trails/format.ts", "src/trails/format.test.ts"],
    handoff: "",
    rounds: [
      {
        findings: [{ title: "Climb uses the same formatter and now shows 0.6 km", detail: "Climb is always metres; give it its own formatter.", file: "src/trails/format.ts", line: 9 }],
        repair: "Separate formatter for climb, always in metres",
        paths: ["src/trails/format.ts", "src/trails/format.test.ts"],
      },
    ],
    verified: "Ridge Loop shows 14.0 km and 620 m of climb; the reproduction passes",
    olderVersion: true,
  },
  {
    id: "WT-120",
    pattern: "bugfix",
    area: "Reliability",
    title: "The trip date resets when the app reopens",
    whyNow: "A changed trip date is back to the default after a restart; it happened before two hikes.",
    outcome: "A changed date is saved and shown again after a restart.",
    benefit: "What you set is what you get on Saturday.",
    option: ["Save the date change", "Write the trip when the date changes, as every other edit does"],
    alternative: ["Recompute on load", "Recompute the default on every load", "Nothing to save", "That is the bug"],
    rationale: "The date change skipped the store; route it through the same write path.",
    acceptance: ["A changed date survives a restart"],
    reproduction: "Reproduced: changing the date and relaunching shows the default again in 3 of 3 runs; the date picker writes the record in memory only.",
    change: "Routes the date change through the trip store",
    files: ["src/trip/DatePicker.tsx", "src/storage/tripStore.test.ts"],
    handoff: "The picker now calls update(), like every other edit.",
    rounds: [],
    verified: "A changed date is there after a restart; the reproduction passes",
  },
  {
    id: "WT-121",
    pattern: "bugfix",
    area: "Reliability",
    title: "The elevation profile crashes on a trail with one point",
    whyNow: "Opening an imported trail with a single point closes the app.",
    outcome: "A trail with fewer than two points shows no profile and the page stays open.",
    benefit: "No crash on bad data.",
    option: ["Guard the profile", "Skip the profile below two points and show a short note"],
    alternative: ["Refuse the trail", "Hide such trails from the list", "No profile code touched", "Hides the person's own import"],
    rationale: "Show what can be shown; the import fix refuses such files from now on.",
    acceptance: ["A one-point trail opens without a profile", "A two-point trail still shows one"],
    reproduction: "Reproduced: a one-point trail divides by zero in the resampler and the page throws in 3 of 3 runs.",
    change: "The profile needs two points; below that the page shows a note instead",
    files: ["src/trails/profile.ts", "src/trails/profile.test.ts", "src/trails/Profile.tsx"],
    handoff: "The guard is in the resampler, so every caller is covered.",
    rounds: [],
    verified: "A one-point trail opens with a note and a two-point trail shows a profile; the reproduction passes",
    delivery: "github-merge",
  },
  {
    id: "WT-122",
    pattern: "bugfix",
    area: "Offline maps",
    title: "Favourites disappear after an update",
    whyNow: "After the last update everyone's favourites were gone.",
    outcome: "Favourites survive an app update.",
    benefit: "Nothing set by hand is lost by an update.",
    option: ["Migrate the key", "Read the old storage key once and move the set to the new one"],
    alternative: ["Accept the loss", "Document it", "No code", "Loses what people set"],
    rationale: "The key was renamed in WT-112; migrate once.",
    acceptance: ["Favourites written before the update are there after it"],
    reproduction: "Reproduced: the favourites key was renamed in WT-112 and the old key is never read; a store from the previous version loads an empty set in 3 of 3 runs.",
    change: "Reads the old favourites key once and moves the set to the new key",
    files: ["src/trails/favourites.ts", "src/trails/favourites.test.ts", "src/storage/migrate.ts"],
    handoff: "The migration runs at boot and deletes the old key when done.",
    rounds: [
      {
        findings: [{ title: "The migration runs on every boot", detail: "The old key is deleted only when the new set is non-empty; delete it after the move in every case, or the migration repeats.", file: "src/storage/migrate.ts", line: 17 }],
        repair: "Deletes the old key after the move in every case",
        paths: ["src/storage/migrate.ts", "src/trails/favourites.test.ts"],
      },
    ],
    verified: "A store from the previous version keeps its favourites; the reproduction passes",
  },
  {
    id: "WT-123",
    pattern: "bugfix",
    area: "Packing lists",
    title: "A packing item is added twice on a double tap",
    whyNow: "Lists have duplicate items; a double tap on Add inserts two.",
    outcome: "A double tap on Add adds one item.",
    benefit: "Clean lists.",
    option: ["Disable Add while adding", "Disable the button until the item is written"],
    alternative: ["Deduplicate by name", "Refuse an item with the same name", "Catches other duplicates too", "Two people may want two head torches"],
    rationale: "The double tap is the cause; stop it at the button.",
    acceptance: ["A double tap adds one item"],
    reproduction: "Reproduced: two taps within 200 ms add two items in 3 of 3 runs; Add stays enabled while the write runs.",
    change: "Add is disabled until the item is written",
    files: ["src/packing/PackingList.tsx", "src/packing/PackingList.test.tsx"],
    handoff: "The disabled state follows the pending write; no debounce.",
    rounds: [],
    verified: "A double tap adds one item; the reproduction passes",
  },
  {
    id: "WT-124",
    pattern: "bugfix",
    area: "Accessibility",
    title: "VoiceOver skips the trail list headings",
    whyNow: "The list's section headings are plain text, so the rotor finds no headings.",
    outcome: "VoiceOver's headings rotor stops at each section of the trail list.",
    benefit: "A long list can be skimmed by heading.",
    option: ["Mark the headings", "Give the section titles the header accessibility trait"],
    alternative: ["Flatten the list", "Remove the sections", "Nothing to mark", "Loses the grouping sighted users rely on"],
    rationale: "The headings exist; VoiceOver only needs to be told.",
    acceptance: ["The headings rotor lists every section"],
    reproduction: "Reproduced: the headings rotor finds nothing in the trail list; the section titles carry no header trait.",
    change: "Section titles carry the header trait",
    files: ["src/trails/SectionHeader.tsx", "src/trails/TrailList.test.tsx"],
    handoff: "",
    rounds: [],
    verified: "The headings rotor stops at each section; the reproduction passes",
  },
];

/** Two landed changes you sent back as fixes from the Review list, some days after they landed. */
export const HISTORY_SENT_BACK: HistorySendBack[] = [
  {
    origin: "WT-105",
    after: "WT-112",
    note: "A trip created in flight mode is gone after a restart.",
    fix: {
      reproduction: "Reproduced: a trip created with no connection is written to the store, but the boot load runs before the store is ready and shows the previous set in 3 of 3 runs.",
      change: "Boot waits for the trip store before loading trips",
      files: ["src/app/boot.ts", "src/storage/tripStore.ts", "src/storage/tripStore.test.ts"],
      handoff: "The store exposes a ready promise; boot awaits it before the first load.",
      rounds: [],
      verified: "A trip created offline is there after a restart; the reproduction passes",
    },
  },
  {
    origin: "WT-113",
    after: "WT-120",
    note: "The profile's labels overlap on trails over 15 km.",
    fix: {
      reproduction: "Reproduced: on Pine Saddle (18 km) the distance labels are drawn every kilometre and overlap below 390 pt in 3 of 3 runs.",
      change: "Distance labels are spaced by the width of the chart",
      files: ["src/trails/Profile.tsx", "src/trails/profile.ts", "src/trails/profile.test.ts"],
      handoff: "The label step is the smallest of 1, 2, 5 or 10 km that leaves 48 pt between labels.",
      rounds: [
        {
          findings: [{ title: "The last label can fall outside the chart", detail: "A step that does not divide the length draws a label past the right edge; drop a label whose centre is past the width.", file: "src/trails/Profile.tsx", line: 52 }],
          repair: "Drops a label whose centre is past the chart's width",
          paths: ["src/trails/Profile.tsx", "src/trails/profile.test.ts"],
        },
      ],
      verified: "Labels no longer overlap on Pine Saddle and the last one stays inside the chart; the reproduction passes",
    },
  },
];

/** The ids of the history tasks, and of the fix tasks the send-backs create (`<origin>-F1`). */
export const HISTORY_IDS = HISTORY.map((h) => h.id);
export const HISTORY_FIX_IDS = HISTORY_SENT_BACK.map((s) => `${s.origin}-F1`);

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
    { title: `Part 1${of}`, outcome: `The first part${of} is done (simulated)`, approach: "A small change", acceptance: ["The first part is verified"], patternId: "change", priority: 3 },
    { title: `Part 2${of}`, outcome: `The second part${of} is done (simulated)`, approach: "A small change", acceptance: ["The second part is verified"], patternId: "change", priority: 3, dependsOn: [0] },
  ];
}
