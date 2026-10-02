# ORC-029 pass 3: the designer's prototypes, made and shown safely

**What this is.** The design for pass 3 of ORC-029. It covers how a designer agent's prototypes are written, stored, served, screenshotted, recorded (terminal demos) and shown in the app, without letting agent-written code reach the network or Orchestrator itself. It ends with real trials.

**Where it fits.**
- **Pass 2** (PR #26) built the studio's records: rounds, artifacts, feedback, PE verdicts, probes and the blueprint, plus budgets and the owner-only start.
- **This pass** makes the artifacts real.
- **Pass 4** adds the lead's studio brief, the PE's own runs and the studio screen.

**The owner's approvals (2026-10-02):**
- Real trials in this pass, capped at about **$5** of estimated Claude usage, plus some Codex usage.
- **VHS** installed with Homebrew: vhs 0.12.1 and ttyd 1.7.7. ffmpeg and Chrome were already there.
- No Penpot for now, because it needs Docker. Mockups are HTML in device frames, as approved in pass 1.

## Units

At most three implementers at once, on disjoint files; the lead integrates. Each unit is verified before it merges.

| Unit | Contents | Main files |
| --- | --- | --- |
| 3a | Studio runs and the studio workspace: designer, PE and probe runs during Vision; the manifest; importing a run's output as an artifact version | `server/studio/runs.ts` (new), `server/scheduler.ts` (studio dispatch), `src/domain/studio/**` |
| 3b | The prototype server and screenshots | `server/studio/serve.ts`, `server/studio/shots.ts` (new), `server/http.ts` |
| 3c | Terminal demos and TUIs: VHS in a sandbox | `server/studio/terminal.ts` (new) |
| 3d | The artifact viewer in the app | `src/ui/studio/**` (new), route `#/vision` |
| 3e | Real trials and their records | `scripts/real-run-test.mjs --studio` or a sibling script; `docs/real-runs/` |

3a, 3b and 3c run in parallel. 3d follows 3a and 3b. 3e is last.

## 3a. Studio runs and the workspace

- **Studio runs are their own records,** like lead runs, not task attempts.
  - Each is a `StudioRun` in `state.studio.runs`, with: `id`; `kind: "designer" | "pe" | "probe"`; `round`; `artifactId?`; `provider` and `model`; `status`; `usage`; `startedAt` and `endedAt`; `workspace`.
  - They run during Vision. That is the one kind of work that does, and it never touches the product's branches.
  - Pause, stop and stale-result rules match other runs.
- **They count toward the building budget** (spec r5: Vision's work counts in it). `buildingSpend` includes them, and the budget stop applies to them.
- **The workspace** lives under the data directory: `<data>/studio/<projectId>/`.
  - A run writes only into its own staging folder, `staging/<runId>/`. Claude's workspace guard and Codex's writable roots point there.
  - The product repository is readable, so the designer can look at an existing app.
- **Native publishing is off.** Claude's tool list already excludes the Artifact tool. Studio runs never use Codex's "local setup" mode, so plugins such as Sites stay off. A test checks both.
- **The manifest:** a designer run ends by writing `studio.json`, which lists:
  - the artifacts it made: `kind`, `title`, `devices`;
  - each artifact's variants: `id`, `label`, `entry` file;
  - its files.

  The service validates it:
  - kinds from the studio's list;
  - file types from an allowlist (html, css, js, svg, png, jpg, webp, woff2, json, txt, md, mmd, tape, ans);
  - size caps;
  - no paths outside the folder and no symlinks.

  It then copies each artifact version into an immutable folder, `artifacts/<artifactId>/v<n>/`, with sha256 hashes, and records it with `addStudioArtifact`.
- **The simulated runtime** writes a small sample prototype, so the demo and tests work without real agents.

### 3a as built (136b0b3..f26af2a, merged in 6bc6e34)

- **Run lifecycle.** Studio runs are queued (with `askedAt`) and dispatched only by the scheduler, only in Vision, and never while paused or at the budget.
  - A paused run is asked again on resume, as a new queued run with `retryOf`.
  - A run whose round closed, or whose artifact moved on, is stale (`baseVersion`). That is checked at dispatch and at completion.
  - When the factory starts, running studio work finishes and is imported, and queued runs wait for Back to vision.
- **Tools.** Studio runs never get a shell or connections.
- **The manifest.** Beyond the design: 1–6 variants, lowercase extensions only, no hard links, reserved names (`manifest.json`, `studio.json`), at most 10 artifacts.
- **Revisions and staging.** A revision hands in one artifact, and its staging folder starts from the version it revises. Staging is removed after a successful import and kept after a failure, for inspection.
- **The read-only product.**
  - **Claude:** a read-only checkout beside the run, readable through the workspace guard and removed afterwards. Whether the real CLI allows those reads is verified in the 3e trials.
  - **Codex 0.159.2:** it has no readable-roots setting, so the checkout is only named in the brief. Reads are not confined, as for every Codex run.
- **Follow-ups:**
  - Studio runs are not counted in the task dispatch limits, so for a short time after Start the factory, finishing studio work can exceed "Agents at once". To fix in the pass 3 review.
  - The PE and probe runs are refused until pass 4.
  - An old project's studio folders are not cleaned up.

## 3b. Serving and screenshots

- **A second listener** for prototypes runs on 127.0.0.1 on its own port.
  - Every artifact version has its own hostname: `p-<artifactId>-v<n>.localhost:<port>`. Cookies are shared across ports on one host, so a separate hostname matters.
  - A request for any other host is refused.
  - Only files listed in the manifest are served, with no directory listing.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:<appPort>`;
  - `X-Content-Type-Options: nosniff`;
  - no cookies.
- **The app frames prototypes with `sandbox="allow-scripts"`,** never `allow-same-origin`. Pins come from a small script the service injects. It posts only `{type: "pin", x, y, selector}` to the parent, and the app accepts only those messages, only from that frame.
- **Escape tests** use a hostile prototype. It tries:
  - `fetch` to the app's API and to the internet;
  - top navigation;
  - `document.cookie`;
  - forms;
  - `postMessage` with other types;
  - reading a sibling artifact.

  Every attempt must fail, and the tests check it in a real browser (Playwright with the system Chrome).
- **Verify early:** does `*.localhost` resolve to 127.0.0.1 in Chrome and Safari? If Safari does not, fall back to one hostname with a path per artifact. The sandbox without same-origin already gives each frame an opaque origin, and that stays the guard.
- **Screenshots:** Playwright, from the existing `playwright-core` with the system Chrome, captures each variant on each of the project's devices:
  - desktop 1280×800;
  - mobile 390×844 at 3×.

  The PNGs are stored with the artifact version, for history and for the PE in pass 4. If no Chrome is found, there are no screenshots, and the UI says so.

## 3c. Terminal demos and TUIs

- **The designer writes a VHS `.tape`, and a script that prints the planned output** for a CLI that does not exist yet. A TUI is either a VHS recording of a scripted TUI, or text frames (`.ans`) the app draws in a terminal window frame. Sizes are 80×24, 100×30 and 120×40.
- **The service runs VHS** with a fixed argument list, and never `vhs publish`, so nothing leaves the machine. A tape is refused when:
  - an `Output` points outside its folder;
  - it uses a `Source` or `Require` of paths outside the folder;
  - it changes `Set Shell` to anything but bash or zsh.
- **The sandbox.** VHS runs a real shell, so the recording runs sandboxed: no network beyond loopback, and no file writes outside the run's output and temp folders.
  - **The open question is whether VHS (ttyd plus Chrome) works there.** The first thing 3c does is test VHS under a macOS `sandbox-exec` profile, then under the checks sandbox from ORC-013, and report.
  - If neither works, terminal demos fall back to hand-written asciicast files played by asciinema-player (Apache-2.0), with no recording. The fallback is labelled.
- **The outputs** are WebM and GIF, and a text transcript the tests can compare.

## 3d. The artifact viewer

- **A new route, `#/vision`,** is a first slice of the studio screen approved in pass 1 (the canvas layout). It shows:
  - the rounds and the round's artifacts (left);
  - the artifact (centre), with Desktop or Mobile limited to the project's device scope, the variants, Keep, Change or Drop, and Pin a comment;
  - a simple feedback summary with **Send feedback**, which calls `sendFeedback` (right).

  The lead's panel and PE review come in pass 4.
- **Terminal artifacts** play in a window frame, at their recorded size.
- **Built from the component kit** (ORC-025): no inline font sizes or colours, and no `confirm()`.

## 3e. Real trials

All within the owner's cap of about $5 of estimated Claude usage. The trial script stops at the cap.

1. **A web prototype.** The designer (Claude, the default) makes the Weekend Trips trip plan in 2–3 variants, for desktop and mobile. The checks: it is served sandboxed, screenshots exist, and the escape tests pass against it.
2. **A terminal demo and a TUI** for the `trips` CLI.
3. **One PE review** of each, by Codex, the other provider, through the PE brief. Pass 4 makes the PE's runs first-class; here a single verdict per artifact is enough evidence.
4. **A record** in `docs/real-runs/`: costs, screenshots or links, verdicts.

## Checks

- Unit and integration tests for each unit.
- The escape tests in a real browser.
- The VHS sandbox result, reported either way.
- `npm test`, the typecheck, the build and `npm run test:integration` pass.
- An independent review.
- The real trials' record committed.
