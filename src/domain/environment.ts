// The project environment (docs/design/project-environment.md): where a project's checks run when Docker is present,
// for any language. Pure, from data and state only:
//   - the owner's setting (a confirmed base image, the prepare commands, the hosts added to the registries);
//   - the image proposal, from a table of data (the only place a language is named);
//   - the repository's dev container (.devcontainer/devcontainer.json: `image`, or `build.dockerfile` with
//     `build.context`, and nothing else);
//   - the source of a run's environment: the dev container first, else the confirmed image;
//   - the inputs whose hashes key a prepared copy, and the record of a run's environment.
//
// No language is a code path here or in the runner (server/environment/): languages appear only as rows of data.

import { draft, event } from "./model/core";
import { ControlError, type State } from "./types";

// ---------- data ----------

/**
 * The hosts the egress proxy lets the prepare phase reach (HTTPS, by name, port 443). The owner may add hosts in the
 * setting; nothing else is reachable.
 */
export const REGISTRY_HOSTS: readonly { host: string; what: string }[] = [
  { host: "registry.npmjs.org", what: "npm" },
  { host: "registry.yarnpkg.com", what: "npm, through Yarn's address" },
  { host: "pypi.org", what: "PyPI" },
  { host: "files.pythonhosted.org", what: "PyPI's file host" },
  { host: "crates.io", what: "crates.io" },
  { host: "index.crates.io", what: "crates.io's index" },
  { host: "static.crates.io", what: "crates.io's static host" },
  { host: "proxy.golang.org", what: "the Go module proxy" },
  { host: "sum.golang.org", what: "the Go checksum database" },
  { host: "rubygems.org", what: "RubyGems" },
  { host: "index.rubygems.org", what: "RubyGems' index" },
  { host: "repo.maven.apache.org", what: "Maven Central" },
  { host: "repo1.maven.org", what: "Maven Central" },
];

/** One row of the proposal table: when one of `markers` is at the repository's root, propose `image` (pinned by digest). */
export interface ImageRow {
  label: string;
  markers: readonly string[];
  image: string;
  /** Prepare commands to start from (the owner edits them). */
  prepare: readonly (readonly string[])[];
}

/**
 * The proposal table: data, read top to bottom, first match wins. Official Docker Hub images, each pinned by the
 * digest of its multi-platform index (2026-10-02).
 */
export const IMAGE_TABLE: readonly ImageRow[] = [
  { label: "Node", markers: ["package.json"], image: "node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4", prepare: [["npm", "ci"]] },
  { label: "Python", markers: ["requirements.txt"], image: "python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81", prepare: [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]] },
  { label: "Python", markers: ["pyproject.toml", "setup.py"], image: "python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81", prepare: [["python3", "-m", "pip", "install", "--user", "-e", "."]] },
  { label: "Go", markers: ["go.mod"], image: "golang:1.26-trixie@sha256:eae2aaa6add2936cbf350dd0d2628b363461542f0c4b3c0b558957e0f2997379", prepare: [["go", "mod", "download"]] },
  { label: "Rust", markers: ["Cargo.toml"], image: "rust:1-slim-trixie@sha256:70d3b1a5e21806b8615c3fb2a59abea6e931aa29bf93f0a9d9c46e743beae096", prepare: [["cargo", "fetch"]] },
  { label: "Ruby", markers: ["Gemfile"], image: "ruby:3.4-slim-trixie@sha256:4677fd16f2b54ef534d18b0e34e20a15726b62c203cb996fd70297a058864c60", prepare: [["bundle", "config", "set", "--local", "path", "vendor/bundle"], ["bundle", "install"]] },
  { label: "Java", markers: ["pom.xml"], image: "maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320", prepare: [["mvn", "-B", "dependency:go-offline"]] },
];

/**
 * The files a prepare depends on: a prepared copy is reused by a later commit only when the hashes of these files
 * (at any depth), the image and the prepare commands are all the same. `*` matches within a name.
 */
export const PREPARE_INPUTS: readonly string[] = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc", ".yarnrc.yml",
  "requirements*.txt", "constraints*.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock", "setup.py", "setup.cfg",
  "go.mod", "go.sum", "go.work", "go.work.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "Gemfile", "Gemfile.lock", ".ruby-version",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.lockfile",
];

const inputPatterns = PREPARE_INPUTS.map((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
/** Is this file (a path inside the repository) one of the prepare's inputs? */
export const isPrepareInput = (path: string) => inputPatterns.some((re) => re.test(path.split("/").pop() ?? ""));

export const ENV_LIMITS = { prepareCommands: 4, argv: 32, argLength: 400, hosts: 20 } as const;

// ---------- the owner's setting ----------

/** The project's environment setting (desired state; only the owner's `setEnvironment` writes it). */
export interface EnvironmentSetting {
  /** Bumps on each change. */
  rev: number;
  /** The base image the owner confirmed, pinned by digest. Used when the repository has no dev container. */
  image?: string;
  /** The project's setup commands, run in order in the prepare phase, as argv lists (never shell strings). */
  prepare: string[][];
  /** Hosts the owner added to the registries the prepare phase may reach. */
  hosts: string[];
}

export interface EnvironmentInput {
  image?: string;
  prepare?: string[][];
  hosts?: string[];
}

const NAME = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REGISTRY = "(?:[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+(?::[0-9]{1,5})?/|localhost:[0-9]{1,5}/)?";
const TAG = "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?";
const DIGEST = "@sha256:[0-9a-f]{64}";
/** An image reference pinned by digest: `name[:tag]@sha256:<64 hex>`. */
export const PINNED_IMAGE = new RegExp(`^${REGISTRY}${NAME}(?:/${NAME})*${TAG}${DIGEST}$`);
/** Any image reference (a dev container may name a tag). Never starts with "-", so it cannot pass as a docker option. */
export const IMAGE_REF = new RegExp(`^${REGISTRY}${NAME}(?:/${NAME})*${TAG}(?:${DIGEST})?$`);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A host name the owner may add: lowercase DNS labels with at least one dot; never an address or a local name. */
export function hostRefusal(h: string): string | undefined {
  if (IPV4.test(h) || h.includes(":") || /^[0-9.]+$/.test(h) || /^0x/i.test(h)) return `"${h.slice(0, 60)}" is an IP address; the proxy allows host names only.`;
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) return `"${h.slice(0, 60)}" is not a host name (lowercase letters, digits, "-" and dots, for example "pkgs.example.com").`;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain)$/.test(h)) return `"${h}" names this computer or its local network, which the prepare phase never reaches.`;
  return undefined;
}

/** Why a prepare command is refused, or undefined. The container is the boundary, so any program may run; only the shape is checked. */
export function prepareRefusal(argv: unknown, n: number): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > ENV_LIMITS.argv) return `Prepare command ${n}: 1–${ENV_LIMITS.argv} arguments.`;
  for (const a of argv) if (typeof a !== "string" || a.length === 0 || a.length > ENV_LIMITS.argLength || /[\0\n\r]/.test(a)) return `Prepare command ${n}: every argument is 1–${ENV_LIMITS.argLength} characters, with no newline.`;
  if ((argv[0] as string).startsWith("-")) return `Prepare command ${n}: the first argument is the program, not an option.`;
  return undefined;
}

/** The setting as it is stored (without its revision), or why it is refused. Pure. */
export function normalizeEnvironment(input: EnvironmentInput): Omit<EnvironmentSetting, "rev"> | { refused: string } {
  const image = input.image?.trim() || undefined;
  if (image !== undefined && !PINNED_IMAGE.test(image)) return { refused: `The image "${image.slice(0, 80)}" is not pinned by digest: name it as name:tag@sha256:<64 hex digits>.` };
  const prepare = input.prepare ?? [];
  if (!Array.isArray(prepare) || prepare.length > ENV_LIMITS.prepareCommands) return { refused: `At most ${ENV_LIMITS.prepareCommands} prepare commands.` };
  for (let i = 0; i < prepare.length; i++) {
    const why = prepareRefusal(prepare[i], i + 1);
    if (why) return { refused: why };
  }
  const hosts: string[] = [];
  for (const raw of input.hosts ?? []) {
    const h = String(raw).trim().toLowerCase().replace(/\.$/, "");
    const why = hostRefusal(h);
    if (why) return { refused: why };
    if (!hosts.includes(h) && !REGISTRY_HOSTS.some((r) => r.host === h)) hosts.push(h);
  }
  if (hosts.length > ENV_LIMITS.hosts) return { refused: `At most ${ENV_LIMITS.hosts} added hosts.` };
  return { ...(image ? { image } : {}), prepare: prepare.map((c) => [...c]), hosts };
}

const argvText = (argv: readonly string[]) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** The setting in one line, for events and briefs. */
export function environmentWords(e: EnvironmentSetting): string {
  return [
    e.image ? `image ${e.image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, "@sha256:$1…")}` : "no confirmed image",
    e.prepare.length ? `prepare ${e.prepare.map((c) => `\`${argvText(c)}\``).join(", then ")}` : "no prepare commands",
    e.hosts.length ? `added hosts ${e.hosts.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The owner's command: set the environment setting, or clear it (`null`). The lead may propose an image in its
 * message; only this command sets one. A check run already under way keeps the environment it started with.
 */
export function setEnvironment(state: State, input: EnvironmentInput | null, now: string): State {
  const prev = state.project.environment;
  if (input === null) {
    if (!prev) return state;
    const s = draft(state);
    delete s.project.environment;
    event(s, now, "user", "config", "Environment cleared: checks use the repository's dev container, or run on this computer as before");
    return s;
  }
  const next = normalizeEnvironment(input);
  if ("refused" in next) throw new ControlError(next.refused);
  if (prev && JSON.stringify({ rev: prev.rev, ...next }) === JSON.stringify(prev)) return state;
  const s = draft(state);
  s.project.environment = { rev: (prev?.rev ?? 0) + 1, ...next };
  event(s, now, "user", "config", `Environment r${s.project.environment.rev}: ${environmentWords(s.project.environment)}`);
  return s;
}

// ---------- the proposal ----------

export interface ImageProposal {
  label: string;
  image: string;
  prepare: string[][];
  /** The file at the repository's root that matched. */
  because: string;
}

/** The image the table proposes for a repository whose root holds `rootFiles`, or undefined. First row wins. */
export function proposeImage(rootFiles: readonly string[]): ImageProposal | undefined {
  const have = new Set(rootFiles);
  for (const row of IMAGE_TABLE) {
    const because = row.markers.find((m) => have.has(m));
    if (because) return { label: row.label, image: row.image, prepare: row.prepare.map((c) => [...c]), because };
  }
  return undefined;
}

/** Every marker of the table: the root files the service reads to make a proposal. */
export const PROPOSAL_MARKERS: readonly string[] = [...new Set(IMAGE_TABLE.flatMap((r) => r.markers))];

// ---------- the dev container ----------

/** Where the service looks for a dev container, in order (the open Dev Container specification, containers.dev). */
export const DEVCONTAINER_FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"] as const;

export type DevcontainerSource = { image: string } | { build: { dockerfile: string; context: string } };

/** JSON with comments and trailing commas (devcontainer.json's format) as plain JSON text. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      // A comment between the comma and the bracket was already dropped from `out`, but not from `text`: skip it too.
      while (text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
        if (text[j + 1] === "/") while (j < n && text[j] !== "\n") j++;
        else j = text.indexOf("*/", j + 2) < 0 ? n : text.indexOf("*/", j + 2) + 2;
        while (j < n && /\s/.test(text[j])) j++;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `rel`, relative to the folder `dir` (both inside the repository), as a path from the repository's root; undefined when it leaves the repository. */
export function insideRepo(dir: string, rel: string): string | undefined {
  if (rel.startsWith("/") || rel.includes("\\") || /[\0-\x1f]/.test(rel)) return undefined;
  const parts: string[] = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/") || ".";
}

/**
 * The environment a dev container file names, or why it is refused. Reads `image`, or `build.dockerfile` with
 * `build.context` (both relative to the file's folder), and nothing else: no features, no lifecycle commands, no
 * mounts, no run arguments. A path that leaves the repository is refused.
 */
export function parseDevcontainer(text: string, file: string): DevcontainerSource | { refused: string } {
  let v: unknown;
  try {
    v = JSON.parse(stripJsonc(text));
  } catch {
    return { refused: `${file} is not valid JSON (comments and trailing commas are allowed).` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { refused: `${file} is not a JSON object.` };
  const o = v as { image?: unknown; build?: unknown; dockerComposeFile?: unknown };
  if (o.image !== undefined) {
    if (typeof o.image !== "string" || !IMAGE_REF.test(o.image)) return { refused: `${file} names an image that is not a plain image reference: ${JSON.stringify(o.image).slice(0, 80)}.` };
    return { image: o.image };
  }
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  if (o.build !== undefined) {
    const b = o.build as { dockerfile?: unknown; context?: unknown };
    if (!b || typeof b !== "object" || typeof b.dockerfile !== "string" || !b.dockerfile) return { refused: `${file}: build.dockerfile is missing.` };
    if (b.context !== undefined && typeof b.context !== "string") return { refused: `${file}: build.context is not a path.` };
    const dockerfile = insideRepo(dir, b.dockerfile);
    const context = insideRepo(dir, (b.context as string | undefined) ?? ".");
    if (!dockerfile || dockerfile === ".") return { refused: `${file}: build.dockerfile "${b.dockerfile.slice(0, 80)}" is outside the repository.` };
    if (!context) return { refused: `${file}: build.context "${String(b.context).slice(0, 80)}" is outside the repository.` };
    return { build: { dockerfile, context } };
  }
  if (o.dockerComposeFile !== undefined) return { refused: `${file} uses Docker Compose, which the checks do not run; name an image or a Dockerfile instead.` };
  return { refused: `${file} names no image and no build.dockerfile.` };
}

// ---------- the source of a run's environment ----------

export type EnvironmentSource =
  | { from: "devcontainer"; file: string; image: string }
  | { from: "devcontainer"; file: string; build: { dockerfile: string; context: string } }
  | { from: "setting"; image: string };

/** What the service found in the repository: the first dev container file there, as parsed. */
export interface DevcontainerFound {
  file: string;
  parsed: DevcontainerSource | { refused: string };
}

/**
 * Where a run's environment comes from, first match wins: the repository's dev container, else the image the owner
 * confirmed. A dev container that is refused does not match; its reason goes with the answer.
 */
export function environmentSource(found: DevcontainerFound | undefined, setting: EnvironmentSetting | undefined): { source?: EnvironmentSource; note?: string } {
  const note = found && "refused" in found.parsed ? found.parsed.refused : undefined;
  if (found && !("refused" in found.parsed)) return { source: { from: "devcontainer", file: found.file, ...found.parsed } };
  if (setting?.image) return { source: { from: "setting", image: setting.image }, ...(note ? { note } : {}) };
  return note ? { note } : {};
}

/** What a check run gets: its environment's source, the prepare commands and every host the proxy allows. */
export interface EnvironmentPlan {
  source: EnvironmentSource;
  prepare: string[][];
  hosts: string[];
}

export function environmentPlan(source: EnvironmentSource, setting: EnvironmentSetting | undefined): EnvironmentPlan {
  return { source, prepare: (setting?.prepare ?? []).map((c) => [...c]), hosts: [...REGISTRY_HOSTS.map((r) => r.host), ...(setting?.hosts ?? [])] };
}

// ---------- a run's record ----------

/** How a check run used the project's environment (CheckRunRecord.environment). */
export type EnvironmentRunRecord =
  | {
      ran: "container";
      from: EnvironmentSource["from"];
      /** The image reference, or the tag the service built from the dev container's Dockerfile. */
      image: string;
      /** The image Docker ran (its id). */
      imageId?: string;
      /** The prepare phase: run now, reused from an earlier commit with the same inputs, or failed. */
      prepare: "ran" | "reused" | "failed";
      /** The hash of the image, the prepare commands, the hosts and the prepare inputs (16 hex). */
      key: string;
      /** The commit whose prepared copy was reused. */
      reusedFrom?: string;
      /** How long the prepare phase took (0 when reused). */
      prepareMs: number;
      /** Hosts the proxy refused during the prepare phase (at most 20). */
      refused?: string[];
    }
  | {
      ran: "host";
      /** Why the checks ran in the host sandbox instead (no Docker, no image, or a build that failed). */
      reason: string;
    };

/** The newest check run's use of the environment, for the settings card: its time, commit and record. */
export function lastEnvironmentRun(s: State): { at: string; sha: string; record: EnvironmentRunRecord } | undefined {
  let best: { at: string; sha: string; record: EnvironmentRunRecord } | undefined;
  for (const a of s.artifacts) {
    const rec = a.checkRun?.environment;
    if (!rec || a.checkRun?.reusedFrom) continue;
    if (!best || a.createdAt > best.at) best = { at: a.createdAt, sha: a.checkRun!.sha, record: rec };
  }
  return best;
}
