# The project environment: checks and evidence for any language

**What this is.** The design for running a project's checks and capturing its evidence in the project's own environment, for any language. It replaces per-language rules.

**Why.** The owner, 2026-10-03: "Really this should be language agnostic for what we build." Today:
- **The checks** (ORC-013) give the network only to npm, pnpm and yarn installs with every hook off; every other install runs offline. So a Python, Go, Rust or Ruby project cannot install its dependencies, and its tests cannot run.
- **Evidence capture** (ORC-029 pass 5, U2) runs the built product in the recorder image, which has Node and nothing else.

Each new language would need its own flags and its own image. That does not scale, and every rule is a special case.

## Decisions

**1. One environment per project, for the checks and the evidence.** Where it comes from, first match wins:
1. **The repository's dev container:** `.devcontainer/devcontainer.json`, with `image` or `build.dockerfile` (the open Dev Container specification, containers.dev; many repositories already have one).
2. **A base image the owner confirmed in Settings:** the lead proposes one from the repository's files, from a table of data (for example `package.json` → a Node image, `pyproject.toml` or `requirements.txt` → a Python image, `go.mod` → Go, `Cargo.toml` → Rust, `Gemfile` → Ruby). Each image in the table is pinned by digest. The table is data, not code paths.

Without Docker, the checks keep today's host sandbox (npm, pnpm and yarn installs only) and say why other languages cannot run; evidence capture says "not set up".

**2. Two phases, with containment instead of per-tool flags.**
- **Prepare** (the project's install and setup commands, for example `uv sync`, `npm ci`, `go mod download`, `bundle install`): the network goes only through **an allowlisting egress proxy** to package registries (a data list: npm, PyPI, crates.io, the Go module proxy, RubyGems, Maven Central; the owner can add hosts). Install code may run here, but only inside the container: a copy of the worktree, a non-root user, no capabilities, no host mounts but the copy and a cache, no route to the host or its loopback, and no secrets.
- **Run** (the checks, the preview, the capture): **no network.**

Rejected:
- per-tool flags (`--ignore-scripts`, `--no-build`, `--only-binary`): language by language, and not every tool has such a flag;
- the network without a proxy during prepare: install code could reach any host;
- one image with every toolchain: huge, and still not every language.

**3. Evidence for any language.**
- **Screens:** the built app runs in the project's container on a private Docker network with no internet; the recorder's browser container joins that network and takes the screenshots.
- **CLIs and TUIs:** the tape's commands run in the project's container with a pseudo-terminal, and the service records the session as an asciicast (the app already plays `.cast` files). A GIF from VHS is optional later.

**4. The owner's view.** Settings › Project › Environment: where the environment comes from (the dev container, or the confirmed image), the prepare commands, the allowed registries, and the last prepare's result. The lead proposes, and only the owner's settings command sets it.

## Units

1. **E1, the environment and the prepare phase (built, 2026-10-02):** the environment's source, the image table, the egress proxy, the two phases, and the checks in the project's container when Docker is present. Real tests with a Node, a Python and a Go fixture, and a hostile fixture whose install code tries to reach a host that is not a registry and the Mac. The decisions it made are below.
2. **E2, evidence in the project's environment (built, 2026-10-03):** screens from a preview with no network, shot by the recorder's browser on the preview's loopback, and CLIs recorded as asciicasts in a pseudo-terminal, for the same three fixtures and the hostile one. The decisions it made are below.

## E1 decisions

**The egress proxy: a small allowlist proxy, in the official Node image.** Compared:

| Option | Licence | Allowlist by name, CONNECT only | Refuses IP literals | Refuses a listed name that resolves to a private address | Fit |
| --- | --- | --- | --- | --- | --- |
| Squid (`ubuntu/squid`, pinned) | GPL-2.0 | Yes (`dstdomain`, `CONNECT`, `SSL_ports`) | Yes (`dstdomain -n`) | Yes, with a `dst` deny list | Mature, but runs as `proxy`, wants writable cache and log folders, and comes with a long default configuration to cut down. Not a permissive licence. |
| tinyproxy | GPL-2.0 | Yes (filter, default deny, `ConnectPort 443`) | Only by the filter's pattern | No | No official image: it would be built from distribution packages, with the network, at build time. |
| Envoy (pinned) | Apache-2.0 | Yes (CONNECT routes, dynamic forward proxy) | Yes, by route | Not without more filters | Mature and permissive, but about 100 lines of configuration for one rule, and a large image. |
| **A small Node script (`server/environment/egress-proxy.mjs`)** | MIT (this project) | Yes, exact names, port 443 | Yes, before any lookup | Yes: it resolves the name, refuses a private or local address, and connects to the address it checked | About 150 lines, standard library only. The same file runs in the tests on this computer and, as an argument, in the official Node image that the recorder's Dockerfile already pins: no image to build. |

The Node script is chosen: it is the only option that refuses a listed name resolving to this computer without extra parts, it is tested on the host with a canary, and it adds no image. Its risk is that it is code of our own; it does no TLS and no HTTP parsing beyond one request line.

**Two networks per prepare.** The private network is `--internal` with the isolated gateway mode, so a container on it has no route out and cannot reach the Docker VM's address on it (measured: without the isolated mode, the VM's SSH port answered). The proxy joins it and a plain bridge network of its own. Container DNS on the private network does not resolve outside names (measured: `EAI_AGAIN`), so names are resolved only by the proxy.

**The prepared image.** Toolchains write outside the copy (the Go image's `GOPATH` is `/go`; pip's `--user` installs go to `HOME`). So the prepare containers are not removed when they end: each is committed, and the run phase runs on the last image. Without this, the run phase would lose what the prepare installed, or each language would need its own folder list. `HOME` is `/var/tmp/home`, inside the image, so it is kept the same way. The image's root is therefore writable inside the containers (no `--read-only`); those writes never reach this computer.

**Reuse: once per prepare key.** The key is a hash of the image's id, the prepare commands, the allowed hosts and the content of the prepare inputs (a data list of manifests and lockfiles, at any depth). A later commit with the same key reuses the prepared image and the entries the prepare added to the copy (found by comparing the copy before and after, so `node_modules`, `.venv` or `vendor/bundle` need no names). The newest three keys per project are kept.

**What the checks' own prepare commands become.** In the environment, the prepare phase runs the environment's prepare commands; the checks' "prepare" commands (the host sandbox's npm installs) are not run there. They stay for the host sandbox. A Final checks step therefore does not reuse an environment run of the same commit by its command ids; it runs again, and the prepare is reused by its key.

**Where the dev container is read.** At the trusted base, as the project conventions and the check suggestions are, so a change cannot choose the image its own checks run in. A `build.dockerfile`'s text comes from the trusted base too; the build context is the checked copy, and `RUN` steps have no network.

**Not done in E1:** a sweep of what a crashed service leaves (labelled networks, containers and `runs/` folders under `~/.cache/orchestrator/environment`); the held state of checks still follows the host sandbox's probe; Rust, Ruby and Java rows of the table are proposed but not run.

Both replace what they supersede: the Node-only evidence path and the npm-only network rule, when Docker is present.

## E2 decisions

**Which path runs.** A project with an environment (a dev container, or a confirmed image) is captured in it, and only there: the recorder's npm install never runs for it. When the environment cannot run (no Docker, a failed probe, an image that cannot be pulled), every item says why; nothing falls back to the recorder. A project without an environment keeps the recorder's path. The run's record names the path: `{ via: "environment", from, image, imageId, prepare, key }` or `{ via: "recorder", image }`, and the record per blueprint item carries it, with the commit and the design version as before.

**The prepare.** The capture borrows the checks' runner (`withPrepared`): the same setup probe, copy, image and prepare, reused by the same key, in the same one-at-a-time turn. The preview setting's install does not run; the record has a note when the setting has one.

**Screens: one loopback, no network.** Compared:

| | (a) A private network, reached by the container's name | (b) No network; the browser shares the preview's loopback (chosen) |
| --- | --- | --- |
| The preview's container | `--internal` network, isolated gateway | `--network none` |
| The browser's container | joins the private network | `--network container:<preview>` |
| What either can reach | each other and Docker's DNS on that network | one loopback, nothing else |
| An app that listens on 127.0.0.1 (Vite, Flask, Django and Rails do by default) | cannot be reached | works |
| The browser's hardening | new: a resolver rule and a proxy exception for the name | unchanged: `app.localhost`, the dead proxy, the resolver rule |
| Networks to make and remove | one per capture | none |

(b) is chosen: it reaches less and works with more apps. Its risk is the shared loopback: the app can connect to the browser's ports. The browser opens none (Playwright drives Chromium through a pipe); only the dead proxy listens, and a connection to it counts as refused. It also closes U2's known gap: the app no longer runs as the capture's user in the capture's container, and it has no `/out` mount, so it cannot plant a picture.

**CLIs: a pseudo-terminal from Docker itself.** Compared:
- `docker run -t`: a terminal, but no way to type into it;
- `docker run -it` with the commands piped in: the docker command refuses ("the input device is not a TTY");
- `script` from util-linux in the image: not in every image, and nothing is installed into the project's image;
- `script` or a native pseudo-terminal on the host: different on macOS and Linux, or a native add-on;
- **chosen:** `docker create --tty --interactive`, then the service attaches to the container's terminal through the daemon's own API on its local socket (as the docker command does), starts it and sets its size.

The shell is bash with VHS's prompt (`> `), so the failure scan skips typed commands as in VHS's transcripts; `TERM` is xterm-256color; `CI` and `NO_COLOR` are emptied. The service types the tape's steps (Type with VHS's speed, keys, Sleep, Wait with `+Screen`, `+Line` and `@time`, Hide and Show, Source); the look of a VHS recording, Output and Require type nothing. Wait patterns that could backtrack for long (groups, back-references, more than three repeats) are refused, because the service runs them on untrusted output. A tape a session cannot type is refused for its item only.

**The recording.** Asciicast v2: one output event per chunk, with its time. Only the escapes the app's player draws stay (the studio's `.cast` rule); titles, modes, bracketed paste and device queries go. It is validated like the studio's `.cast` files (version 2), at most 2 MB, and comes back with a plain transcript, which is scanned for failures. The files take the tape's own name (`demo.gif` becomes `demo.cast` and `demo.txt`). "Design and reality" draws the cast with the studio's terminal renderer. No GIF is made in the environment.

**Real tests** (2026-10-03, Colima with 2 CPUs and 2 GB, each with a fresh prepare, in two runs): Node from its dev container 26–27 s, Python 28 s, Go 44–59 s (it compiles its preview and builds its CLI in the recording), the hostile fixture 31 s. Each page and CLI uses its dependency with no network. After E1's checks of the same project, a capture reused their prepare by its key, and its preview, which ended at once, was reported in 1.2 s with its log. The hostile preview and CLI tried 1.1.1.1, 192.168.5.2 (the Mac through Colima), 172.17.0.1, `host.docker.internal`, `host.lima.internal`, their own loopback and an outside name: all refused (`ENETUNREACH`, `EAI_AGAIN`, `ECONNREFUSED`). Its page tried the same from the browser, and WebRTC: all blocked. The canary on the Mac's loopback saw no connection; a control container on Docker's ordinary network did reach it.

**Not done in E2:** images without bash; zsh tapes (the recorder refuses them too); a daemon reached by `tcp://` or `ssh://` (a CLI then says it needs the local socket); mobile shots in the real tests (the browser code is the recorder's, unchanged); a sweep of preview and session containers a crashed service leaves (they are labelled `orchestrator.environment=preview` and `=session`).

**Removing the recorder's path.** When the projects that capture evidence have environments (the lead proposes an image from the table; the owner confirms it), migrate, then delete:
1. Propose an environment for each project that still captures on the recorder's path (the record's `via: "recorder"` finds them).
2. Remove the recorder's install (`installArgs`, `INSTALL_ENV`, the yarn check in `captureEvidence`), the preview start and the VHS tapes in `CAPTURE_SCRIPT`, and the GIF outputs of evidence.
3. Drop the preview setting's `install` field, with a state migration, and its form field.
4. Keep only Chromium and playwright-core in the recorder's image; VHS stays only while studio demos use it.
