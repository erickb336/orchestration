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

1. **E1, the environment and the prepare phase:** the environment's source, the image table, the egress proxy (a mature, maintained, open-source proxy, pinned; or a small allowlist proxy in the service if none fits: decide and justify), the two phases, and the checks in the project's container when Docker is present. Real tests with a Node, a Python and a Go fixture, and a hostile fixture whose install code tries to reach a host that is not a registry and the Mac.
2. **E2, evidence in the project's environment:** screens over the private network, and CLIs recorded as asciicasts, for the same three fixtures.

Both replace what they supersede: the Node-only evidence path and the npm-only network rule, when Docker is present.
