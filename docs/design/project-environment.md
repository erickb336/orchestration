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
2. **E2, evidence in the project's environment:** screens over the private network, and CLIs recorded as asciicasts, for the same three fixtures.

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
