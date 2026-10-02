// ORC-029 2c, at the service's boundary: the studio's service commands (rounds, artifacts, PE verdicts, probes) are
// recorded by the service and refused from a client, while the owner's studio commands go through as usual. And in
// the code, only the command table approves anything into the blueprint, so no runtime or lead path can.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_HEADER } from "../src/api";
import { SERVICE_COMMANDS } from "../src/domain/commands";
import { ABC, DESIGNER, sha } from "../src/domain/testing/studio";
import type { State } from "../src/domain/types";
import { createHttpServer } from "./http";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

describe("the studio's service commands at the HTTP boundary", () => {
  let dir: string;
  let store: Store;
  let scheduler: Scheduler;
  let base = "";
  let close: () => void = () => {};
  let key = 0;
  const now = () => new Date(Date.parse("2026-10-02T09:00:00Z") + key * 1000).toISOString();
  const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, now());
  const state = (): State => store.read().state;
  const post = (body: unknown) => fetch(`${base}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", [CLIENT_HEADER]: "1" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orc029-studio-"));
    store = new Store(join(dir, "db.sqlite"));
    scheduler = new Scheduler(store, { claude: new ScriptedAdapter("claude"), codex: new ScriptedAdapter("codex") }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000, ackTimeoutMs: 10_000 });
    const probe = createHttpServer({ store, scheduler, startedAt: now(), allowedHosts: [] });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, startedAt: now(), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
    cmd("initProject", { name: "Trips", repoPath: join(dir, "repo"), vision: "Weekend trips for a small group of friends.", focus: "" });
  });
  afterEach(async () => {
    close();
    await scheduler.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a client cannot open a round, add an artifact, record a verdict, report a probe or record a PE review; the service can, and the owner's commands go through", async () => {
    // The service records a round and an agreed screen, as the studio's runs will.
    const n = (cmd("openRound", { focus: "experience" }).result as { n: number }).n;
    const added = cmd("addStudioArtifact", { round: n, kind: "screen", title: "Trip plan", variants: ABC, files: [{ path: "trip-plan/index.html", sha256: sha("a") }], devices: ["desktop"], madeBy: DESIGNER }).result as { artifactId: string };
    cmd("addPeVerdicts", { artifactId: added.artifactId, version: 1, verdicts: ABC.map((v) => ({ variant: v.id, verdict: "feasible", reasons: "Fine." })) });
    const probeId = (cmd("addProbe", { question: "Which forecast sources allow caching?" }).result as { probeId: string }).probeId;
    const before = JSON.stringify(state());
    const tries: Record<string, object> = {
      openRound: { focus: "data" },
      closeRound: { round: n },
      addStudioArtifact: { round: n, kind: "screen", title: "Sneaky", variants: [], files: [{ path: "x.html", sha256: sha("b") }], devices: [], madeBy: { role: "user" } },
      addPeVerdicts: { artifactId: added.artifactId, version: 1, verdicts: [{ verdict: "feasible", reasons: "Fine." }] },
      addProbe: { question: "Anything?" },
      setProbeStatus: { probeId, status: "failed", failure: "client says so" },
      recordPeReview: { taskId: "T-001", verdict: "agree", reasons: "client says so", specRev: 1 },
    };
    expect(Object.keys(tries).sort()).toEqual([...SERVICE_COMMANDS].sort());
    for (const [name, args] of Object.entries(tries)) {
      const r = await post({ name, args, idempotencyKey: `client-${name}` });
      expect(r.status, name).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe(`${name} is recorded by the service from its agents' runs; a client cannot send it.`);
    }
    expect(JSON.stringify(state())).toBe(before);
    // The owner's studio commands are ordinary commands.
    const fb = await post({ name: "sendFeedback", args: { entries: [{ artifactId: added.artifactId, version: 1, mark: "keep", pickedVariant: "B", pins: [], note: "" }] }, idempotencyKey: "owner-1" });
    expect(fb.status).toBe(200);
    const ok = await post({ name: "approveArtifact", args: { artifactId: added.artifactId, version: 1 }, idempotencyKey: "owner-2" });
    expect(ok.status).toBe(200);
    expect(state().blueprint.revisions.map((r) => r.items.map((i) => [i.title, i.variant, i.status]))).toEqual([[["Trip plan", "B", "approved"]]]);
  });
});

describe("in the code, only the command table approves into the blueprint", () => {
  const ROOT = resolve(import.meta.dirname, "..");
  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const rel = relative(ROOT, p);
        if (e.isDirectory()) {
          if (rel === join("src", "domain", "testing") || rel === join("server", "runtimes", "codex-protocol")) continue;
          walk(p);
        } else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
      }
    };
    for (const d of ["src", "server", "scripts"]) walk(join(ROOT, d));
    return out;
  };
  const files = sources();
  const where = (re: RegExp) => files.filter((f) => re.test(readFileSync(join(ROOT, f), "utf8"))).sort();

  it("approveArtifact and approveRound are called from the command table only: no scheduler, runtime or lead code calls them", () => {
    expect(files).toContain(join("server", "scheduler.ts"));
    expect(where(/(?<!function )\bapprove(Artifact|Round)\(/)).toEqual([join("src", "domain", "commands.ts")]);
  });

  it("only the blueprint module writes a blueprint revision", () => {
    expect(where(/blueprint\.revisions\.push\(/)).toEqual([join("src", "domain", "studio", "blueprint.ts")]);
  });
});
