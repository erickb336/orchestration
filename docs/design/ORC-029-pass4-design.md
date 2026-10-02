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
