// The repository's dev container as the service reads it at the trusted base (devcontainer.ts): the file, the
// Dockerfile it names (checked: no BuildKit frontend, no cache mount), and the digest the owner confirms (review
// finding 3).

import { describe, expect, it } from "vitest";
import { devcontainerDigest, dockerfileRefusal } from "../../src/domain/environment";
import { readDevcontainer } from "./devcontainer";

const FROM = "FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4\n";
const repo = (files: Record<string, string>) => (path: string) => (path in files ? { text: files[path], truncated: false } : undefined);

describe("the Dockerfile a dev container names", () => {
  it("refuses a BuildKit frontend (# syntax=), which the builder would fetch and run", () => {
    for (const head of ["# syntax=docker/dockerfile:1.7\n", "#syntax=evil/frontend\n", "  # SYNTAX = x/y\n", "# check=error=true\n# syntax=docker/dockerfile:1\n"]) expect(dockerfileRefusal(`${head}${FROM}`, "Dockerfile"), head).toMatch(/Dockerfile: a "# syntax=" line chooses a BuildKit frontend/);
    expect(dockerfileRefusal(`# a comment about syntax\n${FROM}RUN echo "# syntax=x"\n`, "Dockerfile")).toBeUndefined();
  });

  it("refuses a cache mount, which every build on the daemon would share", () => {
    for (const run of ["RUN --mount=type=cache,target=/root/.npm npm ci", "RUN --mount=target=/c,type=cache,id=x true", "run --MOUNT=TYPE=CACHE,target=/c true", "RUN --mount=type=bind,source=a,target=/a \\\n  --mount=type=cache,target=/c true"]) expect(dockerfileRefusal(`${FROM}${run}\n`, "Dockerfile"), run).toMatch(/Dockerfile: a cache mount/);
    expect(dockerfileRefusal(`${FROM}RUN --mount=type=bind,source=a,target=/a true\nRUN echo type=cache\n`, "Dockerfile")).toBeUndefined();
  });
});

describe("readDevcontainer", () => {
  const dc = JSON.stringify({ build: { dockerfile: "Dockerfile" } });
  it("an image: the digest covers the file", () => {
    const text = JSON.stringify({ image: "node:22" });
    expect(readDevcontainer(repo({ ".devcontainer/devcontainer.json": text }))).toEqual({ file: ".devcontainer/devcontainer.json", parsed: { image: "node:22" }, sha256: devcontainerDigest(text) });
  });

  it("a Dockerfile: read, checked, and in the digest", () => {
    const r = readDevcontainer(repo({ ".devcontainer/devcontainer.json": dc, ".devcontainer/Dockerfile": `${FROM}RUN true\n` }));
    expect(r).toEqual({ file: ".devcontainer/devcontainer.json", parsed: { build: { dockerfile: ".devcontainer/Dockerfile", context: ".devcontainer" } }, sha256: devcontainerDigest(dc, { path: ".devcontainer/Dockerfile", text: `${FROM}RUN true\n` }), dockerfile: `${FROM}RUN true\n` });
    // Another Dockerfile, the same devcontainer.json: another digest.
    expect(readDevcontainer(repo({ ".devcontainer/devcontainer.json": dc, ".devcontainer/Dockerfile": `${FROM}RUN false\n` }))!.sha256).not.toBe(r!.sha256);
  });

  it("refuses a Dockerfile that is missing, too large, or uses a frontend or a cache mount", () => {
    const refused = (files: Record<string, string>) => readDevcontainer(repo({ ".devcontainer/devcontainer.json": dc, ...files }))!.parsed;
    expect(refused({})).toEqual({ refused: ".devcontainer/devcontainer.json names the Dockerfile .devcontainer/Dockerfile, which is not in the repository at the trusted base." });
    expect(refused({ ".devcontainer/Dockerfile": `# syntax=docker/dockerfile:1\n${FROM}` })).toMatchObject({ refused: expect.stringMatching(/syntax/) });
    expect(refused({ ".devcontainer/Dockerfile": `${FROM}RUN --mount=type=cache,target=/c true\n` })).toMatchObject({ refused: expect.stringMatching(/cache mount/) });
    expect(readDevcontainer((p) => (p === ".devcontainer.json" ? { text: "{", truncated: true } : undefined))).toEqual({ file: ".devcontainer.json", parsed: { refused: ".devcontainer.json is larger than 256 KB." } });
  });

  it("finds nothing in a repository without one", () => {
    expect(readDevcontainer(repo({}))).toBeUndefined();
  });
});
