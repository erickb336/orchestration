// HTTP API for the local service. Binds to loopback only. Every request must carry an allowed
// Host header (defeats DNS rebinding); state-changing requests must also carry the client header
// and, when a browser sends an Origin, an allowed Origin. No CORS headers are ever sent, so other
// sites can neither read responses nor make preflighted requests.

import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { CLIENT_HEADER, type AckMode, type ChangeError, type ChangeResponse, type CheckSuggestions, type CommandError, type ServiceInfo, type StatePayload, type VisionDocUploadOk } from "../src/api";
import { suggestChecks, type RepoFile } from "../src/domain/checks";
import { SERVICE_COMMANDS } from "../src/domain/commands";
import { exportMarkdown, trustedBaseRef } from "../src/domain/model";
import type { State } from "../src/domain/types";
import type { FakeRuntimeConfig } from "./runtimes/fake";
import type { Scheduler } from "./scheduler";
import type { VisionDocStore } from "./visiondocs";
import type { WorkspaceManager } from "./workspaces";
import { CommandFailure, type CommandResult, type Store } from "./store";

interface HttpOptions {
  store: Store;
  scheduler: Scheduler;
  /** Shared simulation settings of the fake adapters (fake mode only). */
  fakeConfig?: FakeRuntimeConfig;
  workspaces?: WorkspaceManager;
  /** Where POST /api/vision-docs keeps copies of the user's documents. Without it uploads are refused. */
  visionDocs?: VisionDocStore;
  /** The service's data directory; check logs are served from <dataDir>/check-logs. */
  dataDir?: string;
  startedAt: string;
  /** host:port values accepted in the Host header (the service's own address plus the dev UI). */
  allowedHosts: string[];
  /** Directory with the built UI to serve, if any. */
  staticDir?: string;
  /**
   * The prototype server's port (server/studio/serve.ts). The UI's pages may then frame its origins only: a
   * prototype's own policy cannot stop it navigating its frame elsewhere, the page's frame-src does.
   */
  prototypePort?: number;
  /** The prototype listener itself: while it is listening, the state and health payloads name its port (`service.prototypePort`). */
  prototypeServer?: Server;
  log?: (msg: string) => void;
}

const MAX_BODY = 5 * 1024 * 1024;
const HEARTBEAT_MS = 5000;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function createHttpServer(opts: HttpOptions): Server {
  const { store, scheduler, fakeConfig } = opts;
  const real = !scheduler.isFake;
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const log = opts.log ?? (() => {});
  /** The copies a batch names, so a refused file's copy can go at once. */
  const stagedHashes = (state: State, args: unknown): string[] => {
    const ids = (args as { docIds?: unknown } | undefined)?.docIds;
    if (!Array.isArray(ids)) return [];
    return state.project.visionDocs.filter((d) => ids.includes(d.id)).map((d) => d.hash);
  };
  const sweepDocs = (immediate: string[]) => {
    try {
      opts.visionDocs?.sweep(store.read().state, { immediate });
    } catch (e) {
      log(`Vision documents: cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Repository checks run git; cache them so every state push does not spawn processes.
  let repoCache: { path: string; at: number; result: ReturnType<WorkspaceManager["check"]> } | undefined;
  const repoCheckCached = (path: string) => {
    if (!repoCache || repoCache.path !== path || Date.now() - repoCache.at > 5000) repoCache = { path, at: Date.now(), result: opts.workspaces!.check(path) };
    return repoCache.result;
  };

  const info = (): ServiceInfo => {
    const providers = {} as ServiceInfo["providers"];
    for (const [p, a] of Object.entries(scheduler.adapters) as [keyof ServiceInfo["providers"], (typeof scheduler.adapters)[keyof typeof scheduler.adapters]][]) {
      providers[p] = { label: a.label, capabilities: a.capabilities, health: scheduler.health[p], connections: scheduler.connections[p] };
    }
    const out: ServiceInfo = {
      startedAt: opts.startedAt,
      scheduler: scheduler.active ? "active" : "observer",
      runtime: real ? "real" : "fake",
      sim: { auto: scheduler.auto, ackMode: fakeConfig?.ackMode ?? "normal" },
      dbPath: store.path,
      providers,
      leadBlocked: scheduler.leadBlocked,
    };
    // From the listener, not the configuration: a port that was busy at start serves nothing, and the app says so.
    const proto = opts.prototypeServer?.listening ? opts.prototypeServer.address() : null;
    if (proto && typeof proto === "object") out.prototypePort = proto.port;
    if (real && opts.workspaces) {
      const project = store.read().state.project;
      if (project.sample) out.repo = { ok: false, reason: "This is the sample project; real runs are disabled for it. Start a new project below." };
      else {
        const c = repoCheckCached(project.repoPath);
        out.repo = { ok: c.ok, reason: c.reason, branch: c.branch };
      }
    }
    return out;
  };
  const payload = (): StatePayload => ({ ...store.read(), service: info() });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(json);
  };
  const fail = (res: ServerResponse, status: number, kind: CommandError["kind"], error: string) => send(res, status, { error, kind } satisfies CommandError);

  /**
   * What a landed task changed, for the Review list. Takes a task id only, never a commit: the commit
   * comes from the task's own landed record. Read-only and capped.
   */
  const change = (res: ServerResponse, taskId: string) => {
    const { state } = store.read();
    const integration = state.tasks.find((t) => t.id === taskId)?.integration;
    const landed = integration?.landed;
    // An open pull request shows its head against the base it contains; a landed task shows its commit.
    const pr = !landed && integration?.status === "integrated" && integration.pr && integration.pr.phase !== "closed" ? integration.pr : undefined;
    if (!landed && !pr) return fail(res, 404, "invalid", "This task has no landed change and no pull request.");
    if ((landed ?? pr)!.simulated || !opts.workspaces) return fail(res, 404, "invalid", "This change is simulated: there is no commit to show.");
    const commit = landed ? landed.commit : pr!.headSha;
    const url = landed ? landed.pr?.url : pr!.url;
    let out: ReturnType<WorkspaceManager["changeDiff"]>;
    try {
      out = opts.workspaces.changeDiff({ repoPath: state.project.repoPath, commit, ...(pr ? { from: pr.baseSha } : {}) });
    } catch {
      return fail(res, 500, "internal", "The changes could not be read from the repository.");
    }
    if (!out) return send(res, 404, { error: `Commit ${commit.slice(0, 12)} is not in the local repository.`, kind: "invalid", ...(url ? { url } : {}) } satisfies ChangeError);
    return send(res, 200, { taskId, commit, target: landed ? landed.target : `${pr!.repo} ${pr!.base}`, diff: out.diff, truncated: out.truncated } satisfies ChangeResponse);
  };

  /** The check commands the repository's own files suggest, read at the trusted base. Nothing is saved. */
  const suggest = (res: ServerResponse) => {
    const { state } = store.read();
    if (!real || !opts.workspaces) return send(res, 200, { commands: [], ref: "", reason: "Suggestions read the repository's files; the simulated runtime has none. The sample project's commands are simulated." } satisfies CheckSuggestions);
    if (state.project.sample || !state.project.repoPath) return send(res, 200, { commands: [], ref: "", reason: "This is the sample project; start a project of your own to read its repository." } satisfies CheckSuggestions);
    const ref = trustedBaseRef(state);
    const files: RepoFile[] = [];
    for (const path of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.toml", "go.mod", "pyproject.toml"]) {
      try {
        const r = opts.workspaces.readFileAt({ repoPath: state.project.repoPath, ref, path, maxBytes: 256 * 1024 });
        if (r) files.push({ path, text: r.text });
      } catch {
        /* unreadable: no suggestion from it */
      }
    }
    const commands = suggestChecks(files);
    return send(res, 200, { commands, ref, ...(commands.length ? {} : { reason: `No package.json scripts, lockfile, Cargo.toml, go.mod or pyproject.toml with pytest at ${ref}.` }) } satisfies CheckSuggestions);
  };

  /** The full (redacted) log of one check of one run, from the service's own directory. Ids are validated; nothing else is served. */
  const checkLog = (res: ServerResponse, run: string, check: string) => {
    const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
    if (!ID.test(run) || !ID.test(check) || !opts.dataDir) return fail(res, 404, "invalid", "No such log.");
    const { state } = store.read();
    const file = join(opts.dataDir, "check-logs", state.project.id.replace(/[^A-Za-z0-9._-]/g, "_"), run, `${check}.log`);
    if (!existsSync(file)) return fail(res, 404, "invalid", "No log was kept for this check (it may have been pruned).");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return res.end(readFileSync(file));
  };

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new CommandFailure("invalid", "Request body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new CommandFailure("invalid", "Body is not valid JSON"));
        }
      });
      req.on("error", reject);
    });

  const stream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const push = () => res.write(`event: state\ndata: ${JSON.stringify(payload())}\n\n`);
    push();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.onChange(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        push();
      }, 50);
    });
    // A named event (not a comment) so clients can detect a silently dead connection, for example
    // through a proxy that keeps the browser side open after the service has gone away.
    const heartbeat = setInterval(() => res.write("event: ping\ndata: {}\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
    });
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    if (!opts.staticDir) return fail(res, 404, "invalid", "Not found");
    const root = realpathSync(resolve(opts.staticDir));
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return fail(res, 400, "invalid", "Malformed path");
    }
    const inside = (f: string) => f === root || f.startsWith(root + sep);
    let file = resolve(join(root, urlPath));
    if (!inside(file)) return fail(res, 403, "forbidden", "Forbidden");
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
    if (!existsSync(file)) return fail(res, 404, "invalid", "UI not built. Run npm run build.");
    file = realpathSync(file); // symlinks must still resolve inside the static root
    if (!inside(file)) return fail(res, 403, "forbidden", "Forbidden");
    const body = createReadStream(file);
    body.on("error", () => {
      if (!res.headersSent) fail(res, 404, "invalid", "Not found");
      else res.destroy();
    });
    body.on("open", () => {
      const frames = opts.prototypePort ? { "Content-Security-Policy": `frame-src http://*.localhost:${opts.prototypePort}` } : {};
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", ...frames });
      body.pipe(res);
    });
  };

  return createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? "").toLowerCase();
      if (!hosts.has(host)) return fail(res, 403, "forbidden", "Unexpected Host header");
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;

      // Reject cross-site browser requests to the API, reads included: the state is private.
      const origin = req.headers.origin;
      const crossSite = req.headers["sec-fetch-site"] === "cross-site";
      if (path.startsWith("/api/") && ((origin !== undefined && !origins.has(origin.toLowerCase())) || crossSite)) {
        return fail(res, 403, "forbidden", "Cross-origin requests are not allowed");
      }

      if (!path.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "invalid", "Method not allowed");
        return serveStatic(req, res);
      }

      if (req.method === "GET") {
        if (path === "/api/health") return send(res, 200, { ok: true, service: info() });
        if (path === "/api/state") return send(res, 200, payload());
        if (path === "/api/stream") return stream(req, res);
        if (path === "/api/export.md") {
          res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="orchestration-board.md"', "Cache-Control": "no-store" });
          return res.end(exportMarkdown(store.read().state));
        }
        if (path === "/api/change") return change(res, url.searchParams.get("task") ?? "");
        if (path === "/api/checks/suggest") return suggest(res);
        if (path === "/api/checks/log") return checkLog(res, url.searchParams.get("run") ?? "", url.searchParams.get("check") ?? "");
        return fail(res, 404, "invalid", "Not found");
      }

      if (req.method !== "POST") return fail(res, 405, "invalid", "Method not allowed");
      if (req.headers[CLIENT_HEADER.toLowerCase()] !== "1") return fail(res, 403, "forbidden", `Missing ${CLIENT_HEADER} header`);
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return fail(res, 415, "invalid", "Content-Type must be application/json");
      const raw = await readJson(req);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(res, 400, "invalid", "Body must be a JSON object");
      const body = raw as Record<string, unknown>;

      if (path === "/api/commands") {
        if (typeof body.name !== "string" || typeof body.idempotencyKey !== "string") return fail(res, 400, "invalid", "name and idempotencyKey are required");
        if (real && body.name === "resetSampleData") return fail(res, 400, "control", "Sample data is only available with the fake runtime.");
        // A document is recorded together with its copy: the upload endpoint does both.
        if (body.name === "stageVisionDoc" || body.name === "addVisionDoc") return fail(res, 400, "invalid", "Attach documents through POST /api/vision-docs, which stores the file first.");
        // The studio's rounds, artifacts, PE verdicts and probes, and PE review of new work, come from agents' runs, recorded by the service.
        if (SERVICE_COMMANDS.has(body.name)) return fail(res, 400, "invalid", `${body.name} is recorded by the service from its agents' runs; a client cannot send it.`);
        // A sample project never contacts GitHub: neither the delivery setting nor Start the factory turns pull requests on for it.
        const asksForPrs =
          (body.name === "setDeliveryMode" && (body.args as { mode?: unknown } | undefined)?.mode === "pr") ||
          (body.name === "startFactory" && (body.args as { settings?: { delivery?: { mode?: unknown } } } | undefined)?.settings?.delivery?.mode === "pr");
        if (real && asksForPrs && store.read().state.project.sample)
          return fail(res, 400, "control", "This is the sample project; pull-request delivery needs a project of your own. Start a new project in Settings.");
        // The sample project has no repository to run checks on; nothing of it ever runs on this computer.
        if (real && body.name === "setChecks" && ((body.args as { config?: { enabled?: unknown } } | undefined)?.config?.enabled === true) && store.read().state.project.sample)
          return fail(res, 400, "control", "This is the sample project; checks run a repository's commands, and it has no repository. Start a project of your own in Settings.");
        // Once a batch commits (refused files lose their records) and once a project is replaced, copies
        // no record refers to are deleted. A batch's own copies go at once; others wait out the grace
        // period in case their batch is still uploading.
        const sweepAfter = !!opts.visionDocs && (body.name === "attachVisionDocs" || body.name === "initProject");
        const batchHashes = sweepAfter && body.name === "attachVisionDocs" ? stagedHashes(store.read().state, body.args) : [];
        let r: CommandResult;
        try {
          r = store.command(body.name, body.args, body.idempotencyKey, new Date().toISOString());
        } finally {
          if (sweepAfter) sweepDocs(batchHashes);
        }
        if (body.name === "resetSampleData") scheduler.resetRuntime();
        return send(res, 200, { version: r.version, result: r.result });
      }
      // One file per request. The same host, origin and client-header checks as every other
      // state change already ran above; the body cap (MAX_BODY) bounds the base64 upload.
      if (path === "/api/vision-docs") {
        if (typeof body.path !== "string" || typeof body.content !== "string" || typeof body.idempotencyKey !== "string") return fail(res, 400, "invalid", "path, content and idempotencyKey are required");
        if (!opts.visionDocs) return fail(res, 400, "control", "This service has no place to keep documents.");
        // Every field, the idempotency key and the project's caps are checked, and the command
        // recorded, before any byte reaches the disk. A retry replays the recorded outcome (a different
        // file under the same key is refused by the store). The copy is written, or found already
        // present, only once the command succeeded; nothing is attached until `attachVisionDocs`.
        if (!body.idempotencyKey || body.idempotencyKey.length > 200) return fail(res, 400, "invalid", "idempotencyKey is required (at most 200 characters)");
        const upload = opts.visionDocs.inspect(body.path, body.content);
        const r = store.command("stageVisionDoc", upload.input, body.idempotencyKey, new Date().toISOString());
        const result = (r.result ?? {}) as { docId?: string; status?: "staged" | "unchanged"; replaces?: string };
        opts.visionDocs.store(store.read().state.project.id, upload.input.hash, upload.buf);
        return send(res, 200, { version: r.version, docId: result.docId ?? "", status: result.status ?? "staged", ...(result.replaces ? { replaces: result.replaces } : {}) } satisfies VisionDocUploadOk);
      }
      if (path.startsWith("/api/sim") && (real || !fakeConfig)) return fail(res, 400, "control", "Simulation controls are only available with the fake runtime.");
      if (path === "/api/maintenance/prune") {
        if (!real) return fail(res, 400, "control", "Workspace cleanup applies to real runs only.");
        return send(res, 200, { removed: scheduler.prune() });
      }
      if (path === "/api/health/refresh") {
        await scheduler.refreshHealth();
        return send(res, 200, { ok: true, service: info() });
      }
      if (path === "/api/sim") {
        if (typeof body.auto === "boolean") scheduler.auto = body.auto;
        if (body.ackMode === "normal" || body.ackMode === "never") fakeConfig!.ackMode = body.ackMode as AckMode;
        store.emit();
        return send(res, 200, { ok: true, service: info() });
      }
      if (path === "/api/sim/step") {
        if (!scheduler.step(Date.now())) return fail(res, 409, "control", "This service instance does not hold the scheduler lease");
        return send(res, 200, { ok: true });
      }
      if (path === "/api/sim/reset") {
        const r = store.command("resetSampleData", {}, `reset-${Date.now()}-${Math.random()}`, new Date().toISOString());
        scheduler.resetRuntime();
        return send(res, 200, { version: r.version });
      }
      return fail(res, 404, "invalid", "Not found");
    } catch (e) {
      if (e instanceof CommandFailure) {
        const status = e.kind === "stale" ? 409 : e.kind === "internal" ? 500 : 400;
        if (e.kind === "internal") log(`Command failed: ${e.message}`);
        return fail(res, status, e.kind, e.message);
      }
      log(`Request failed: ${e instanceof Error ? e.stack : String(e)}`);
      return fail(res, 500, "internal", "Internal error");
    }
  });
}
