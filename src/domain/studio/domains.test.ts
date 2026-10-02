// ORC-029 pass 4 (r9): the product's domains, which the owner confirms and the lead only proposes, and the studio
// kinds a code product and an infrastructure system add (interface, algorithm, topology), as plain documents.

import { describe, expect, it } from "vitest";
import { InvalidCommandError, SERVICE_COMMANDS, runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import { DESIGNER, openRound, peAgrees, run, sha } from "../testing/studio";
import { ControlError } from "../types";
import { domainLines } from "./domains";
import * as R from "./runs";
import * as S from "./studio";
import { DESIGNER_KINDS, DOCUMENT_KINDS, STUDIO_ARTIFACT_KINDS } from "./types";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips engine", repoPath: "/tmp/trips", vision: "A routing engine for weekend trips.", focus: "" }, at(0));
const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};

describe("the product's domains", () => {
  it("a new project has none chosen; the owner sets at least one, each once, in a fixed order, recorded", () => {
    let s = fresh();
    expect(s.project.domains).toEqual([]);
    s = runCommand(s, "setDomains", { domains: ["infrastructure", "code", "code"] }, at(1)).state;
    expect(s.project.domains).toEqual(["code", "infrastructure"]);
    expect(s.events.at(-1)).toMatchObject({ actor: "user", message: "Domains: a code product and an infrastructure system" });
    // The same set again changes nothing and records nothing.
    expect(runCommand(s, "setDomains", { domains: ["code", "infrastructure"] }, at(2)).state).toBe(s);
    expect(failure(() => runCommand(s, "setDomains", { domains: [] }, at(3)))).toEqual(new ControlError("Choose at least one domain: screen, code or infrastructure."));
    expect(failure(() => runCommand(s, "setDomains", { domains: ["screen", "games"] }, at(3)))).toEqual(new InvalidCommandError("unknown domain games: choose screen, code or infrastructure"));
    expect(failure(() => runCommand(s, "setDomains", { domains: "screen" }, at(3)))).toBeInstanceOf(InvalidCommandError);
  });

  it("is the owner's command: a client may send it, and it is no service command", () => {
    expect(SERVICE_COMMANDS.has("setDomains")).toBe(false);
  });

  it("says what the designer makes for each domain chosen, or that none is chosen", () => {
    expect(domainLines([])).toEqual(["Not chosen yet by the owner."]);
    const lines = domainLines(["infrastructure", "screen"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^A screen product \(screen, terminal-demo, tui\): clickable screens/);
    expect(lines[1]).toMatch(/^An infrastructure system \(topology\): the topology .*failure and recovery.*scaling and cost/);
    expect(domainLines(["code"])[0]).toMatch(/^A code product \(interface, algorithm\): the interface \(names, signatures, the error model, usage examples/);
  });
});

describe("the document kinds: interface, algorithm and topology", () => {
  it("are studio kinds a designer makes, shown as documents with no screenshots or recording, and reviewed by the PE", () => {
    for (const k of ["interface", "algorithm", "topology"] as const) {
      expect(STUDIO_ARTIFACT_KINDS).toContain(k);
      expect(DESIGNER_KINDS).toContain(k);
      expect(DOCUMENT_KINDS).toContain(k);
    }
    expect(DOCUMENT_KINDS).toEqual(["contract", "flow", "interface", "algorithm", "topology"]);
    const r = openRound(fresh(), "experience", at(1));
    const added = run<{ artifactId: string; version: number }>(
      r.state,
      "addStudioArtifact",
      {
        round: r.n,
        kind: "algorithm",
        title: "Route planner",
        variants: [{ id: "a", label: "A · Greedy by distance", entry: "planner/algorithm.md" }],
        files: [
          { path: "planner/algorithm.md", sha256: sha("a") },
          { path: "planner/trace.mmd", sha256: sha("b") },
        ],
        devices: [],
        madeBy: DESIGNER,
      },
      at(2),
    );
    const a = S.getArtifact(added.state, added.result.artifactId, 1);
    expect(a).toMatchObject({ kind: "algorithm", devices: [] });
    expect(S.mediaKind(a)).toBeUndefined();
    // Not shown to the owner until the PE has reviewed it, like any designer's artifact.
    expect(S.readyForOwner(added.state, a)).toBe(false);
    expect(R.peRunDue(added.state, a)).toBe(true);
    expect(S.readyForOwner(peAgrees(added.state, a.id, 1, ["a"], at(3)), a)).toBe(true);
  });
});
