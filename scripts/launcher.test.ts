// The launcher's pure parts. Saved answers never hold a secret; credentials come from the
// environment first and the Keychain second; explicit variables beat saved answers.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM module without type declarations
import * as L from "./launcher.mjs";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "orch-launcher-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("saved answers", () => {
  it("round-trip without secrets, drop unknown values, and are readable only by the user", () => {
    const path = L.settingsPath(home);
    expect(L.loadSettings(path)).toBeNull();
    const saved = L.saveSettings(path, { runtime: "real", claude: "subscription", port: 5400, token: "sk-ant-oat01-secret", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(saved).toEqual({ version: 1, runtime: "real", claude: "subscription", port: 5400 });
    expect(readFileSync(path, "utf8")).not.toMatch(/sk-ant/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(L.loadSettings(path)).toEqual(saved);
    expect(L.validateSettings({ runtime: "cloud", claude: "maybe", port: 70000 })).toEqual({ version: 1 });
    writeFileSync(path, "{not json");
    expect(L.loadSettings(path)).toBeNull();
  });
});

describe("Claude credentials", () => {
  const noKeychain = () => undefined;
  const keychain = (values: Record<string, string>) => (service: string) => values[service];

  it("prefer the environment, then the Keychain, and never put a secret in the description", () => {
    const fromEnv = L.resolveClaude("api-key", { ANTHROPIC_API_KEY: "sk-ant-env" }, keychain({ "orchestrator.anthropic-api-key": "sk-ant-kc" }));
    expect(fromEnv).toMatchObject({ ok: true, add: {} });
    expect(fromEnv.note).toMatch(/in this terminal/);
    const fromKc = L.resolveClaude("api-key", {}, keychain({ "orchestrator.anthropic-api-key": "sk-ant-kc\n" }));
    expect(fromKc).toMatchObject({ ok: true, add: { ANTHROPIC_API_KEY: "sk-ant-kc" } });
    expect(fromKc.note).toMatch(/Keychain/);
    for (const r of [fromEnv, fromKc]) expect(r.note).not.toMatch(/sk-ant/);
    const missing = L.resolveClaude("api-key", {}, noKeychain);
    expect(missing.ok).toBe(false);
    expect(missing.note).toMatch(/npm run setup/);
  });

  it("the subscription choice always adds the opt-in switch, with the token from the Keychain if needed", () => {
    const r = L.resolveClaude("subscription", {}, keychain({ "orchestrator.claude-oauth-token": "sk-ant-oat01-tok" }));
    expect(r).toMatchObject({ ok: true, add: { ORCHESTRATION_CLAUDE_AUTH: "subscription", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-tok" } });
    expect(r.note).not.toMatch(/sk-ant/);
    const env = L.resolveClaude("subscription", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-env" }, noKeychain);
    expect(env).toMatchObject({ ok: true, add: { ORCHESTRATION_CLAUDE_AUTH: "subscription" } });
    expect(env.add.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // already in the environment
  });

  it("Codex only and cloud choices add nothing; cloud says when no flag is set", () => {
    expect(L.resolveClaude("none", {}, noKeychain)).toMatchObject({ ok: true, add: {} });
    expect(L.resolveClaude("cloud", { CLAUDE_CODE_USE_BEDROCK: "1" }, noKeychain)).toMatchObject({ ok: true, add: {} });
    expect(L.resolveClaude("cloud", { CLAUDE_CODE_USE_BEDROCK: "0" }, noKeychain).ok).toBe(false);
  });
});

describe("service environment", () => {
  it("uses saved answers, but explicit variables win", () => {
    const claude = L.resolveClaude("subscription", {}, () => "sk-ant-oat01-kc");
    const env = L.serviceEnv({ version: 1, runtime: "real", claude: "subscription", port: 5400 }, { PATH: "/bin" }, claude);
    expect(env).toMatchObject({ ORCHESTRATION_RUNTIME: "real", ORCHESTRATION_PORT: "5400", ORCHESTRATION_STATIC: "dist", ORCHESTRATION_CLAUDE_AUTH: "subscription", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-kc", PATH: "/bin" });
    const explicit = L.serviceEnv({ version: 1, runtime: "real" }, { ORCHESTRATION_RUNTIME: "fake", ORCHESTRATION_PORT: "6000" }, claude);
    expect(explicit).toMatchObject({ ORCHESTRATION_RUNTIME: "fake", ORCHESTRATION_PORT: "6000" });
    expect(explicit.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // the demo never receives a credential
  });

  it("with no saved answers it starts the demo on the default port, as npm start did before", () => {
    expect(L.serviceEnv(null, {}, undefined)).toMatchObject({ ORCHESTRATION_RUNTIME: "fake", ORCHESTRATION_PORT: "5319" });
  });

  it("never adds the subscription switch unless that choice was made", () => {
    const claude = L.resolveClaude("api-key", {}, () => "sk-ant-kc");
    const env = L.serviceEnv({ version: 1, runtime: "real", claude: "api-key" }, {}, claude);
    expect(env.ORCHESTRATION_CLAUDE_AUTH).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-kc");
  });
});

describe("Codex only and arguments", () => {
  it("makes Codex the lead, the project default and every role's default", () => {
    const cmds = L.codexOnlyCommands();
    expect(cmds.map((c: { name: string }) => c.name)).toEqual(["setLeadSelection", "setProjectDefault", ...L.ROLES.map(() => "setRoleDefault")]);
    expect(cmds.every((c: { args: { selection: unknown } }) => JSON.stringify(c.args.selection) === JSON.stringify({ provider: "codex", model: "auto" }))).toBe(true);
  });

  it("parses commands and options, and rejects unknown ones", () => {
    expect(L.parseArgs([])).toMatchObject({ command: "start", open: true });
    expect(L.parseArgs(["start", "--real", "--no-open", "--port", "5400"])).toMatchObject({ command: "start", runtime: "real", open: false, port: 5400 });
    expect(L.parseArgs(["setup"]).command).toBe("setup");
    expect(() => L.parseArgs(["--port", "x"])).toThrow(/--port/);
    expect(() => L.parseArgs(["deploy"])).toThrow(/Unknown command/);
    expect(() => L.parseArgs(["--force"])).toThrow(/Unknown option/);
  });
});
