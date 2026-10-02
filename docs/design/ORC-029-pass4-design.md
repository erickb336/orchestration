# ORC-029 pass 4: driving the studio by talking to the lead

**What this is.** The design for pass 4 of ORC-029: the owner drives the vision studio by chatting with the lead, on a new idea or on an existing repository. The designer revises until the PE agrees. Vision gets its own place in the navigation.

**Where it fits.** Pass 3 made the studio's artifacts real: designer runs, sandboxed prototypes and terminal demos, the viewer, and a minimal PE review. Today a designer run can only be started by the service (the trial script stands in for the lead), so the owner cannot drive the studio from the app. The owner wants to try it on their old projects (2026-10-02, "in the morning we can walk through with a demo and test it out on some of my old projects"), so this pass is the slice that makes that possible.

The draft and Lock in (r10), the factory status with evidence (r12) and the lead adjusting tasks after Lock in go to pass 5. Full import (ORC-032) is a later milestone; this pass only gives existing repositories a first "as it is today" round.

## Units

At most three implementers, on disjoint files; the lead integrates. Each unit ends verified.

| Unit | Contents | Main files |
| --- | --- | --- |
| 4a | Vision in the main navigation; the lead's panel in the studio's right column; artifact kinds shown as documents | `src/ui/**` only |
| 4b | The lead in Vision: conversation-driven rounds, designer briefs, project domains, and an "as it is today" first round for an existing repository | `server/envelope.ts`, `src/domain/model/leadOutput.ts` and lead modules, `server/studio/runs.ts` (starting designer runs from the lead), `src/domain/studio/**` (domains, kinds) |
| 4c | The PE loop: the designer revises after an objection, up to three passes; `lastPass` removed | `server/studio/pe.ts`, the PE-related parts of `src/domain/studio/studio.ts`, the revision brief |

4b and 4c both touch the studio domain. 4c owns the verdict and loop functions, and 4b owns rounds, domains and kinds, with the boundary named in each brief. 4a needs only the domain's shapes.

## 4a. Vision in the navigation, and the lead's panel

- **Navigation (r12).** Vision is an item in the main navigation, beside Home, Tasks, Results and Settings, always one click away. Opening it never stops or changes the factory. Pause the factory stays where it is.
  - **The lead's decision:** the "Back to vision" stage switch stays until pass 5. Until pass 5 adds the draft and Lock in, the vision can only be revised while the project is in Vision, so removing the switch now would leave no way to revise it after the start.
- **The lead's panel.** The studio's right column shows the lead's message for the round, its questions (with option chips, as in ORC-012), and a box for "Message the lead" that posts to the same conversation as the header button. PE review and the feedback summary stay below it. The owner's feedback and answers go together as one message (ORC-012's "Send answers" pattern).
- **Document artifacts.** The kinds `interface`, `algorithm`, `topology`, `contract` and `flow` are shown as documents: Markdown with code blocks, Mermaid for diagrams (rendered by the app, never by the prototype server), and tables. They have no device frame.
- **Kit only;** a browser pass at 1280 and 375 wide.

## 4b. The lead in Vision

- **The lead's studio brief** goes into its envelope during Vision. It covers:
  - the vision text and documents;
  - the project's domains;
  - the open round and its artifacts;
  - the owner's marks, pins and notes since the last round;
  - the PE's verdicts;
  - the order of focus (experience, then data, then flows; r8 completeness: the product's things and how they relate, and every rule and edge case decided).
- **The lead's output gains a `studio` block** (validated, capped):
  - `openRound: { focus, summary }`;
  - `designerRuns: [{ brief, kinds, variants (1–3), devices }]` (at most 3 per reply);
  - `questions` (as in ORC-012);
  - `closeRound`.

  The service starts the designer runs through the existing service-only path. **The lead can never approve, overrule, lock in or start the factory;** only the owner's commands do (the tests from pass 2 must still hold).
- **Project domains (r9).** `project.domains: ("screen" | "code" | "infrastructure")[]`, which the lead proposes from the vision and the repository and the owner confirms (Settings, and a question in the first round).
  - Designer briefs follow the domain:
    - screens, terminal demos and TUIs for screen products;
    - interface, usage examples and algorithms for code products;
    - topology, failure and recovery, and scale and cost for infrastructure.
  - The studio artifact kinds gain `interface`, `algorithm` and `topology` (plain files: Markdown, Mermaid, code blocks).
- **An existing repository** (the project's repository has code). Unless the owner says otherwise, the lead's first round is **"as it is today"**:
  - the designer reproduces the key screens, or the interface and core algorithms, or the topology, from the code, as artifacts labelled "as is";
  - each artifact carries its provenance: the files it came from;
  - the owner corrects them, and later rounds revise them.

  It is a first slice of ORC-032. Designers read the repository read-only (a Claude designer through the read-only checkout; Codex reads are not confined, as for every Codex run).
- **The simulated runtime:** the fake lead plans a round and asks for one designer run, so the demo shows the loop.

## 4c. The PE loop

- **When the PE objects to a variant** (not-feasible), or asks for a change (feasible-if), the service queues a **designer revision run**. Its brief holds the PE's reasons and changes, plus the owner's feedback so far. The revision is a new version of the artifact, and the PE reviews it again.
- **Up to three passes per round** (2c's rule). After the third, any remaining objection goes to the owner, shown and never dropped, and the owner may overrule it.
- **`lastPass` is removed;** the interim rule from pass 3 goes.
- **Spend:** each pass counts in the building budget. A revision is not started past the budget stop.
- **The simulated runtime:** the fake PE objects once to one variant, and the fake designer revises it, so the loop is visible in the demo and the tests.

## Real trial (within the overnight budget)

One real round on a small sample repository with an existing screen, with these checks:
- the lead plans an "as it is today" round;
- the designer reproduces the screen with its provenance;
- the PE reviews it;
- one revision, if the PE asks for it.

The estimated Claude spend stays within what is left of the owner's $5 cap for pass 3 trials (about $4.70). The record goes to `docs/real-runs/`.

## Checks

- **Tests per unit:** the lead's studio block is validated; the lead cannot approve, overrule, lock in or start; the loop stops at three passes; past-budget revisions are not started.
- `npm test`, the typecheck, the build, `npm run test:integration` and `npm run trial:studio -- --fake` (extended for the lead's round and the loop).
- A browser pass at 1280 and 375 wide.
- An independent review, then a pull request.

## Started (2026-10-02)

- **Before the units:** the recorder fixes from the real trial (root-relative paths, and "recorded-with-errors") are merged. Real terminal recording is paused in the service until recordings run in a container (pass 3 review finding 1). Demos fall back to their hand-written files, with the reason shown.
- **The three units run in parallel.** Pass 3's remaining review findings ride along where the units own the files:
  - finding 4 (the "not independent" label) in 4a;
  - findings 8 (the trial cap) and 9 (ASCII paths) in 4b;
  - findings 5 (no media while paused), 6 (the Codex PE temp folder), 7 (retry counting) and 10 (the PE's data-not-instructions line) in 4c.
- **After pass 4:** findings 1–3 (the container recorder, other folders, WebRTC) and 11 (duplication).

## 4a and 4c as built (merged in 29ca9d5 and eb4e408)

**4a, the UI:**
- Vision is a navigation tab with a badge counting artifacts that wait for the owner. The Home Studio card is removed.
- **The lead's panel:** the message, questions with chips, Message the lead, and Open the conversation.
- **One "Send to the lead" button** records the marks first, then posts one message with the answers and the marks.
- **Documents:** `react-markdown` 10.1.0 and `remark-gfm` 4.0.1 (no raw HTML); `mermaid` 11.17.2 at `securityLevel: "strict"`, loaded on first use.
- The PE review shows "not independent" when the PE ran on the designer's provider.
- **Version history:** each version with its PE pass.
- **The browser pass** at 1280 and 375 wide had no horizontal scroll and no console errors.
- **For ORC-030's audit:** the right column is long, and the canvas has empty space under the prototype.

**4c, the PE loop:**
- **The loop:** a designer revision follows a feasible-if or not-feasible verdict, up to three passes per round. Objections then go to the owner. `lastPass` is removed.
- After the third pass, feasible-if counts as agreed, with its change shown. Only not-feasible needs an overrule.
- **Budget:** revisions count in the building budget, and wait at the stop.
- **Review findings 5, 6, 7 and 10 are fixed:** no media while paused; the PE's temp folder lives outside the version; pause stops don't count as retries; the PE treats the designer's work as data, not instructions.

**Follow-ups:**
- the "Objects" and "Revising" wording should use the loop's state;
- a revision that no provider can run shows nothing to the owner;
- revision runs are logged with the actor "lead", because they go through 4b's `requestStudioRun`;
- the trial's per-run Claude cap does not cover service-started revisions; only the building budget does;
- stored verdicts from before 4c, which carry `lastPass`, re-enter the loop if their round is open.

**Load-sensitive test (for ORC-030's stabilization):** `server/runtimes/codex.test.ts`, "a note before the turn exists is held, then steered…". It failed once in a full run while three implementers loaded the machine, then passed 3 times in 3 alone.

## 4b as built (merged in 80dce53)

**Stored shapes:**
- `round.lead?: { message, questions: { text, reason?, options? }[] }`: the lead's newest reply about the round.
- A designer run that the lead asked for records `fromLead: { leadRunId, kinds, variants, devices }`.
- `project.domains: ("screen" | "code" | "infrastructure")[]`. It is empty until the owner chooses, for new and migrated projects. Only the owner's `setDomains` command sets it, in either stage.
- `StudioArtifact.provenance?: { asIs: true; files: string[] }`, also written into the version's `manifest.json`, so the PE sees it.

**Decisions:**
- **"As it is today" is round 0** (focus `material`). Designer and PE runs may now run in round 0. A designer artifact in round 0 must carry provenance, and provenance is refused in any other round, because later rounds are proposals.
- **Provenance is checked at import:** each file must exist in the repository at HEAD. An artifact that names a missing file is refused.
- **The lead's `studio` block** applies only to replies to the owner's messages, in Vision. Fields that it does not know (approve, overrule, lock in, start, feedback, domains) are named in a note and ignored. An optional `revises` field asks for an artifact's next version, which carries the owner's open pins.
- **The trial's cap** counts each Claude run with no recorded cost at its run limit (review finding 8). Simulated runs count as $0.
- Review finding 9 is fixed: manifest path segments allow only `[A-Za-z0-9._ -]`. The file route serves `md` and `mmd` as UTF-8 plain text with `nosniff`.

**At the merge:** a feasible-if verdict now starts a revision (4c). So the lead's brief says "the designer revises for the PE", with the objections and the asked-for changes. The trial waits for the PE's loop in both modes.

**Checks after the merge (2026-10-02):**
- `npm test`: 105 files, 1,590 passed, 1 skipped. One earlier run had one failure under load, while other implementers ran tests; the next two runs were clean.
- The typecheck passes.
- `npm run test:integration`: 16 of 16.
- `npm run trial:studio -- --fake`: 9 of 9.
- `npm run trial:studio -- --fake --lead`: 9 of 9. The simulated PE asked for one change, and the designer revised the screen to version 2.

**Not done:** the lead's brief shows the PE's status per artifact, not the full history of verdicts.

## The real trial (2026-10-02T17-41-38Z, record in `docs/real-runs/`)

`npm run trial:studio -- --lead --cap-usd 3 --codex-usd 1`, with Claude on the owner's subscription and Codex on its ChatGPT sign-in. **Result: 7 of 9 checks passed.** The estimated Claude spend was $0.20. With pass 3's trial, the trials spent about $0.46 of the owner's $5.

**"As it is today" worked end to end:**
- The lead (claude-sonnet-5-5) read `index.html` and `style.css`, opened round 0 with a correct summary, and asked for one designer run.
- The designer reproduced the Trip board on desktop and mobile, labelled "as is" with both files.
- The PE (Codex, gpt-6.1-sol) agreed. The prototype was sandboxed, and the owner could send feedback.

**The short idea failed (2 checks).** Findings:
1. **High: one missing brace loses the lead's whole reply.** The lead wrote a good reply: a vision draft, four questions, round 1 and a designer brief. Its JSON block left the `vision` object open, so the block did not parse, and nothing was applied. **The root-cause fix:** schema-constrained output for the lead's reply. The Claude Agent SDK has `outputFormat: { type: "json_schema" }` (with retries), and Codex has `codex exec --output-schema`. A repair parser (for example `jsonrepair`) is rejected: it closes the brace in the wrong place and silently changes the structure.
2. **Medium: the service's note is false.** It said "The reply had no machine-readable block". There was a block, and it was not valid JSON. The note must say what failed, and where.
3. **Medium: the lead misread "domain".** In both projects it asked about a subject domain ("Travel and group planning", "Web app") instead of the product domain (screen, code, infrastructure). **The fix:** the lead proposes domains as a structured field with a reason, and the app shows a fixed domain choice with the lead's recommendation selected. A fixed choice is a control, not a free-text question.
4. **Low (pass 4d): the lead's messages are long.** Many sentences have more than 25 words.

The trial also caught a setup mistake (mine): without `ORCHESTRATION_CLAUDE_AUTH=subscription`, Claude reported "not-configured". The trial now prints each provider's reason.


## The container recorder (pass 3 findings 1 and 2)

**What this is.** Terminal demos now record in a Docker container, not under macOS `sandbox-exec`. This closes pass 3 review findings 1 (the tape's shell could write to every `/dev/ttys*`) and 2 (shell reads were denied only in the home folder). The service records again: `TERMINAL_RECORDING_PAUSED` is removed.

**What runs where.**
- **The service** (on the Mac) checks the tape, copies the artifact version into a new stage folder, and starts one `docker run` per tape. It writes the tape to the container's stdin.
- **The container** (in the Colima VM) runs VHS, ttyd, Chromium, ffmpeg, bash and Node. It sees two folders of the stage and nothing else from the host: the copy at `/work` and an empty output folder at `/out`.
- **After VHS**, the service copies only the outputs the tape declared into `recording/<variant>/`. Each must be a regular file within the cap, with no link on its way.

**The image.** `docker/recorder/Dockerfile`, tagged `orchestrator-recorder:1` by `npm run recorder:build`:
- VHS 0.12.1 (Debian 13) and Node 22.23.3 (one binary from `node:22-trixie-slim`), both pinned by digest;
- a `ttyd` wrapper first on PATH, which starts the tape's shell at `/work` (VHS itself runs in the tape's folder);
- the user `recorder` (10001).

The service never builds or pulls an image (`--pull never`). The image is 1.01 GB (3.35 GB on disk, with the VHS layers).

**The flags** (`containerArgs` in `server/studio/container.ts`, an argument list, never a shell string):
- `--network none`;
- `--read-only`, with tmpfs for `/tmp` (512 MB) and HOME (64 MB), and an empty read-only tmpfs over the VHS image's `/vhs` volume;
- `--cap-drop ALL` and `--security-opt no-new-privileges`;
- `--user 10001:10001`;
- `--pids-limit 512`, `--memory 1g` with no swap, and `--cpus 1.5` (one recording of the terminal sample peaked at 517 MB and 116 processes);
- `--rm` and a unique `--name`;
- two `--mount type=bind`: the copy and the output folder. No Docker socket.

**Stops.** The service's limits stay (`RECORD_DEFAULTS`: 120 s, 25 MB per output, 512 MB on disk). On a timeout or a stop, the service runs `docker kill <name>`, then `docker rm --force <name>`. Inside, VHS runs under `timeout` (the service's limit plus 15 s), so a container also ends when the service is gone.

**The stage folder.** Colima shares only the home folder with its VM: a bind mount of the system temp folder mounts an empty folder. So stages go in `~/.cache/orchestrator/recorder`, one per recording, removed afterwards. The probe proves that Docker sees them.

**The probe** (`probeRecorder`) runs before anything records. First it asks whether Docker runs and whether the image is there. Then it runs a container with the same flags (plus a hosts entry for the host gateway) and service-owned commands. All of these must hold:
1. a user other than root, no capabilities, no new privileges, a seccomp filter;
2. its own processes;
3. only the loopback interface, and 1.1.1.1:443 refused;
4. the host gateway refused, and no connection to a port the service opens on the Mac;
5. no host path (the home folder, `/Users`, the stage folder, the Docker socket), and no disk mounts but the two;
6. it reads the service's file in the copy, and the service sees the files it writes;
7. writes to `/`, `/etc` and `/usr/local/bin` refused;
8. only Docker's own devices in `/dev`, no open terminal in `/dev/pts`, and no terminal at `/dev/tty`;
9. the limits in place: processes, memory, swap and CPU.

A passed probe is cached per docker command, image and stage root. When Docker is not running, the image is missing, or a check fails, the variant falls back to its hand-written files, with the reason.

**Decisions.**
- **Bind mounts, not a tar stream on stdin and stdout.** The mounts are what the brief asked for, and the probe proves them. A tar stream needs no shared folder, but it needs a tar reader for untrusted output.
- **The image's user, not the host's user ID.** Docker Desktop and Colima map file owners on shared folders, so 10001 can write the mounts. On a Linux host the probe would fail this check (not verified).
- **The stage in the home folder, not in the data directory.** `systemMedia` does not know the data directory, and tests must not write under `~/.orchestration`.
- **The tape's shell and VHS run as one user,** so the shell can write to `/out`. That gives it nothing it does not have already: only declared outputs leave, as regular files.
- **`Set Shell zsh` does not record:** the image has bash only, and adding zsh needs a package download at build time. The variant falls back, with the reason. The tape rules still allow zsh.

**What was removed.** The two `sandbox-exec` profiles, the ttyd broker and wrapper, the reaper, the shell's read rules, and their tests; `TERMINAL_RECORDING_PAUSED` and the `recording` opt-in.

**Verified (2026-10-02; Colima 0.10.3, Docker 29.8.2 client, 29.5.2 engine):**
- the probe passes its 10 checks in under 0.5 s;
- a docker that drops `--network none`, `--read-only` and `--cap-drop ALL` fails the probe, and nothing records;
- the terminal sample (`TERMINAL_SAMPLE_FILES`) records into WebM, GIF and a transcript in about 11 s;
- a hostile tape: no network, no DNS, no connection to the service's port, no `/dev/ttys000`, no host file or home folder, writes outside the copy refused, and a file planted in `/out` not copied out; the recording still finished;
- a tape that swaps an output folder for a link gets nothing copied out;
- a timeout kills the container by its name; no container and no stage folder stays;
- through the scheduler (`runs.test.ts`) and the studio trial, the service records the demo in the container.

**Not verified:** Docker Desktop, a Linux host, and a recording at 120×40 near the memory limit.

**Follow-ups:**
- A crash can leave a stage folder in `~/.cache/orchestrator/recorder`. Nothing sweeps it yet.
- The designer's brief (`runs.ts`) still says the service records "in a sandbox". It is still true, but it could name zsh's fallback.

## The independent review of pass 4 (2026-10-02)

The diff `0391420..80dce53`, read by a reviewer that did not write it. **No agent output can call an owner command:** the lead's block, the designer manifests and the PE answers cannot approve, overrule, lock in, start the factory, set domains or send feedback. All five 4c follow-ups are real defects. Findings:

1. **Medium: the lead's `closeRound` ends PE review early.** A version that waits for the PE then waits forever, and a feasible-if version shows "agreed".
2. **Medium: designer Mermaid loads remote URLs in the owner's app** (`themeCSS` with `url(…)`, image shapes). The app's pages have only a `frame-src` policy.
3. **Medium: stored verdicts with `lastPass` re-enter the loop** after the upgrade (follow-up 5). The loop can then start a paid designer run.
4. **Medium: the budget stop counts unknown costs as $0.**
5. **Medium: "as it is today" is not shown as such,** the PE is not told that the artifact is a reproduction, and the loop asks the designer to redesign it.
6. **Medium: the `PeReview` shape misstates the loop** (follow-ups 1 and 2): "objected" for a change request, "agreed" after two failed revisions, nothing when no provider can revise, and one test that passes for the wrong reason.
7. **Medium: the owner has no way to set domains.** With the real trial's finding 3, the lead also asks about the wrong kind of domain.
8. **Low: revisions started by the service are logged as the lead's** (follow-up 3).
9. **Low: the trial's cap does not bound the runs that the service starts** (follow-up 4).
10. **Low: duplicated rules:** the path check (four copies), `MAX_PROVENANCE`, `DOCUMENT_KINDS`, the round's question types, the verdict words and the "under way" statuses.
11. **Low: `git ls-tree` runs synchronously,** also inside the store transaction of a round-0 import.

**The fix round.** Two units, beside the schema unit for the lead's reply (real trial finding 1):
- **F1, the domain and the server:** findings 1, 3, 4, 5 (server part), 6 (the shape), 8, 9, 10 and 11. The lead's brief explains the product domains and does not ask about them in free text.
- **F2, the app and its security:** findings 2, 5 (the "As is" label), 7 (the owner's domain control), and pass 3 finding 3 (WebRTC and DNS prefetch). The recorder's stage folders are swept at start. Finding 6's wording follows F1's shape, after F1 merges.

## The lead's reply as schema-constrained output (real trial finding 1; merged 2026-10-02)

- **One JSON Schema** (`src/domain/model/leadReplySchema.ts`) covers every field that the lead sends. Every field is required, and null means "left out", because Codex's strict mode refuses optional fields. Claude accepts the same schema, so there is one schema, not two.
- **The runtimes enforce it:** Claude through `outputFormat` (the answer comes back as `structured_output`), and Codex through `outputSchema` on `turn/start`. The Claude guard allows the SDK's `StructuredOutput` tool, only on a run with a schema; the tool touches no file.
- **On arrival,** `parseLeadOutput` reads the JSON, never repairs it, and checks it again with ajv. Each note names the failure: no JSON, JSON that does not parse (with the line and column), not an object, or a schema mismatch. The trial's broken reply is the regression fixture.
- **A failed reply keeps its raw text** on the lead run (`rawAnswer`, at most 64 KB, on the newest 5 runs), so diagnosis needs no personal history.

**No personal history from runs** (the owner, 2026-10-02: runs left "a lot of codex chats stranded"). Codex threads start with `ephemeral: true`. Claude runs set `persistSession: false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; without the second setting, a run still made an empty memory folder. The owner chose a clean-up: 16 of the 20 old Codex threads were archived (reversible), and the ChatGPT app held 4 open. 44 Claude session folders went to the Trash.

**Real checks:** one lead-shaped call per provider, with the schema. Both returned valid JSON, left no history, and delivered a note on the run. The estimated cost was $0.14 for Claude and about $0.06 for Codex. The trials and checks have now spent about $0.60 of the owner's $5 for Claude.

**Not verified:** Claude's retry-limit path, a full-size lead envelope under the schema on real models (the next real trial checks it), and a view of `rawAnswer` in the app.

**Load:** the real recording tests can time out when other test runs share Colima's 2-CPU, 2 GB machine. They pass alone (34 of 34). F2 adds one recording at a time.

## F2 as built (2026-10-02)

**What this is.** The record of fix unit F2: the app's own security (review finding 2, pass 3 finding 3), the "as is" label (finding 5, UI part), the owner's domain control (finding 7, real trial finding 3), the recorder's stage sweep, and one recording at a time (the lead's added item). Finding 6's wording waits for F1's `PeReview` shape. Every test named here runs in `npm test`.

### 1. Mermaid and the app's pages (review finding 2)

**What was wrong.** Mermaid drew a designer's `.mmd` in the owner's live page, and some of its syntax loads URLs while it lays the diagram out. A browser check reproduced it: `themeCSS` in an init directive or in front matter (`fill: url(…)`, `background-image: url(…)`) and an image shape (`a@{ img: "…" }`) each made a request. The old header comment said nothing could load; that was false during the drawing.

**Layer 1: Mermaid runs in a frame that can reach nothing** (`src/ui/studio/diagrams.ts`, `diagramFrame.js`).
- One hidden `<iframe sandbox="allow-scripts" srcdoc>`, never `allow-same-origin`: an opaque origin, with no way into the app's page, cookies, storage or API.
- Its own `<meta>` policy: `default-src 'none'`, scripts only `mermaid.min.js` and `diagramFrame.js` (by path), inline styles for the SVG. As a srcdoc document, it also inherits the app page's policy.
- The frame posts back the SVG text. The app checks the sender and the shape, and shows the SVG as an `<img>` from a `data:` URL, where nothing runs or loads.
- Defence in depth: `secure` now also locks `themeCSS`, `fontFamily`, `altFontFamily`, `arrowMarkerAbsolute`, `legacyMathML` and `forceLegacyMathML`, so a directive or front matter cannot add CSS or a URL.

**Layer 2: a policy on every app page** (`appPagePolicy` in `server/http.ts`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src` the prototype origins (else `'none'`)`; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The live updates (`/api/stream`) are on the app's origin, so `connect-src 'self'` covers them.

**Decisions.**

| Choice | Chosen | Rejected, and why |
| --- | --- | --- |
| Where Mermaid runs | A sandboxed frame with no network | Lock keys and strip `url(` and image shapes in the page: a list of syntax is never complete (CSS escapes such as `u\72l(`, `image-set`, C4 sprites, the next diagram type), and a Mermaid bug would run with the app's API. The frame is the smallest attack surface: whatever Mermaid does, it has no network and no app. |
| Mermaid's build in the frame | `mermaid.min.js`, a classic script | Mermaid's ES modules: a module in an opaque origin needs CORS, and `Access-Control-Allow-Origin: null` would let any sandboxed page on the web read the app's files. |
| The frame's document | `srcdoc` | A page of its own: it needs a route in both servers, and `frame-src` would have to allow the app's own origin. A srcdoc frame inherits the app's policy, and `frame-src` does not apply to it. |

**Tests (real Chrome, the real built app; `server/http.browser.test.ts`).**
- Hostile `.mmd` (themeCSS, front matter, an image shape, a C4 sprite and link, a click link) and hostile `.md` (remote and reference images, raw `<img>`, `<link>`, `<iframe>`, `<style>`, links, a Mermaid block) in a studio document: no request reaches an outside server, and the browser refused every request to another origin before it left. This holds with the app's policy, and also without it (the frame alone).
- The control: Mermaid in a plain page reaches the outside server (`/theme-fill`, `/theme-bg`, `/image-shape.png`); under the app's policy alone it does not.
- Unlocking `themeCSS` makes the test fail (checked once by hand).
- Every screen of the demo (12 routes) and Vision loads under the policy with no console error.
- `studio.test.tsx`: the frame's policy and document, and the strict reading of its replies.
- `escape.test.ts`: its stand-in app page now keeps its script in a file, as the app does; all its cases pass under the new policy.

### 2. WebRTC, DNS prefetch and preconnect (pass 3 finding 3)

**The screenshot Chrome is closed** (`noNetworkArgs` in `server/studio/shots.ts`): `--webrtc-ip-handling-policy=disable_non_proxied_udp`, a dead proxy of the service's own (a loopback port that closes every connection), and `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE *.localhost`. Chrome never sends `*.localhost` or loopback through a proxy, so the version's own origin still loads.

**Tests** (listeners on this machine's network address stand in for servers on the internet; Chrome's own network log shows what it looked up):
- `shots.test.ts`: `captureShots` on a hostile page that holds its load for 5 s: no STUN packet, no connection, no DNS query. Without the flags, the same capture sent STUN packets and looked up the STUN server's name (checked once by hand).
- `escape.test.ts`, in a Chrome profile of its own (an incognito context never prefetches): with the flags, nothing; without them, everything below.

**What the owner's own browser still allows.** In the owner's Chrome (154.0.8037.95, a normal profile), a prototype in the studio's sandboxed frame can still:

| Way out | What leaves | Stopped by the app? |
| --- | --- | --- |
| WebRTC to a STUN server | UDP packets | No |
| WebRTC to a TURN server over TCP | a connection, and later the TURN user name the page chose | No |
| `<link rel="dns-prefetch">`, in the page or added by a script | a DNS query for any name the page chose | No |
| `<link rel="preconnect">` | a TCP connection to an address, or a DNS query for a name | No |

The prototype's policy (`connect-src 'none'`), the sandbox and `frame-src` do not cover these, and Chrome 154 ignores a `webrtc 'block'` directive. `X-DNS-Prefetch-Control: off` does not stop `<link rel="dns-prefetch">`, so the app does not send it. (Both checked once by hand.) What these carry out: a few bytes chosen by the page (a host name, a TURN user name) and the owner's address. The page can read only its own files, which the designer wrote. Chrome settings reduce it: with "Preload pages" off and the WebRTC IP policy `disable_non_proxied_udp` (Chrome's `WebRtcIPHandling` policy), no DNS prefetch, preconnect or STUN left, but TURN over TCP still connected (checked once by hand, with both set in a test profile). Only a proxy or a firewall closes TURN over TCP. The app changes nothing in the owner's browser.

### 3. "As it is today" (finding 5, the UI part)

- A round 0 that holds the designer's "as is" artifacts is named **As it is today**, not "What you brought". A round 0 with only the owner's material keeps its name.
- The artifact's line starts with "as is". Above the stage: "The designer made this from the code, to show what the product does now. It is not a proposal. Correct what it gets wrong: mark it, pin comments or write a note.", and the repository files it came from (six shown, the rest behind a Disclosure).
- **Decision:** the label comes from the round's content (`provenance.asIs`), not from a new round focus, because the domain keeps round 0 as `material` (F1 owns the domain).
- **Tests:** `studio.test.tsx`, "as it is today".

### 4. The kind of product (finding 7, real trial finding 3)

- **Settings › Project › Kind of product** (`#/settings/project/domains`): three checkboxes, any combination. Each says who uses it and what the designer makes. It saves with the section. Once some are chosen, none is refused ("Choose at least one kind.").
- **In the studio**, while none is chosen: one compact prompt with the same three kinds. Each click saves at once, so one click answers it. Then it shows "Saved: a code product." and stays, so the owner can add a second kind, until Done. The only chosen kind keeps its chosen look and refuses a click (it cannot be cleared there).
- **Decision:** each click saves, not toggles plus a Save button: the owner answers in one click, and most products have one kind.
- **The words** (`DOMAIN_CHOICES`): "Screen product: people use it on a screen: in a browser, on a desktop or a phone, or in a terminal." "Code product: other programs use it: a library, an engine or a compiler." "Infrastructure: it runs other software: servers, queues or deployment." A test keeps each sentence at 20 words or fewer.
- **Tests:** `studio.test.tsx` (the prompt, its command against the real command table, the order), `settings.test.tsx` (the card, `domainsError`, the card's address). The browser pass clicked "Code product": it saved, Settings showed it checked, and after a reload the prompt was gone.

### 5. The recorder

- **The stage sweep** (`sweepStages` in `container.ts`, called in `server/app.ts` at start): removes `orc-rec-` and `orc-probe-` folders with mkdtemp's six characters, older than an hour, never through a link (a link root and a link entry are left alone; links inside a folder are unlinked, not followed). `makeStage` takes only those two prefixes, so a new prefix cannot slip past the pattern. It closes the container recorder's first follow-up. **Tests:** `container.test.ts`, with a temporary root.
- **One recording at a time** (`startRecording` in `container.ts`; `terminal.ts` starts its container through it): a process-wide queue; the time limit starts when the container starts, not when it is queued; a failed or stopped recording frees the turn; one stopped while it waits never starts. The probe stays outside the queue. **Tests:** `container.test.ts`, "one recording at a time", with a stand-in docker: two recordings started together run one after the other and neither times out. Without the queue, all three tests fail (checked once by hand).

### Checks (2026-10-02)

- `npm test`: 107 files, 1,622 passed, 2 skipped (the Codex CLI smoke test and the real-sandbox test, which need their environment).
- The typecheck and the build pass.
- `npm run test:integration`: 16 of 16. `npm run trial:studio -- --fake`: 9 of 9.
- **Browser pass** (the built app on the real service, a seeded project): Vision (the domain prompt, a document with two diagrams, the "as is" screen) and Settings › Project, at 1280 and 375 wide: no horizontal scroll, no console error, no policy violation. Vite's dev server also draws the diagrams. Its only console error is a missing favicon, which is not new.

### Not verified

- Browsers other than Chrome 154 on macOS. Safari's and Firefox's handling of the srcdoc frame and of the ways out above is not tested.
- The flags of the screenshot Chrome on Linux.
- A recording queue across two services on one machine: the queue is per process.

### Changes outside F2's files

- `server/app.ts`: the stage sweep at start (6 lines). No unit owns this file.
- `server/studio/terminal.ts`: its container starts through `startRecording` (the lead's added item). No unit owns this file.

### Follow-ups

- The kit gallery puts a `<details>` in a `<p>` (React warns in a development build only).

