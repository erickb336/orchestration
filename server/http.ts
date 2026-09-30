// HTTP API for the local service. Binds to loopback only. Every request must carry an allowed
// Host header (defeats DNS rebinding); state-changing requests must also carry the client header
// and, when a browser sends an Origin, an allowed Origin. No CORS headers are ever sent, so other
// sites can neither read responses nor make preflighted requests.

import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { CLIENT_HEADER, type AckMode, type CommandError, type ServiceInfo, type StatePayload } from "../src/api";
import { exportMarkdown } from "../src/domain/model";
import type { FakeRuntimeConfig } from "./runtimes/fake";
import type { Scheduler } from "./scheduler";
import type { WorkspaceManager } from "./workspaces";
import { CommandFailure, type Store } from "./store";

export interface HttpOptions {
  store: Store;
  scheduler: Scheduler;
  /** Shared simulation settings of the fake adapters (fake mode only). */
  fakeConfig?: FakeRuntimeConfig;
  workspaces?: WorkspaceManager;
  startedAt: string;
  /** host:port values accepted in the Host header (the service's own address plus the dev UI). */
  allowedHosts: string[];
  /** Directory with the built UI to serve, if any. */
  staticDir?: string;
  log?: (msg: string) => void;
}

const MAX_BODY = 5 * 1024 * 1024;
export const HEARTBEAT_MS = 5000;
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
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
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
        const r = store.command(body.name, body.args, body.idempotencyKey, new Date().toISOString());
        if (body.name === "resetSampleData") scheduler.resetRuntime();
        return send(res, 200, { version: r.version, result: r.result });
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
