// ORC-018 §5.4: the Traces card's pure helpers, the loopback rule above all.

import { describe, expect, it } from "vitest";
import type { TelemetryStatus } from "../api";
import { buildSeed } from "../domain/seed";
import type { Task, TaskOutcome } from "../domain/types";
import { confirmedFor, LANGFUSE_ENDPOINT, PHOENIX_ENDPOINT, backfillCount, endpointProblem, hostOf, isLoopbackHost, needsRemoteConfirm, statusLine } from "./telemetryView";

describe("the loopback rule (mirrors setTelemetry, design §5.1)", () => {
  it("treats localhost, 127.0.0.1, [::1] and *.localhost as this computer", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", "phoenix.localhost", "a.b.localhost"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["phoenix.example.com", "10.0.0.5", "127.0.0.2", "localhost.example.com", "cloud.langfuse.com", "::2"]) expect(isLoopbackHost(h), h).toBe(false);
  });

  it("reads the host of an http(s) endpoint and nothing else", () => {
    expect(hostOf(PHOENIX_ENDPOINT)).toBe("localhost");
    expect(hostOf("http://[::1]:4318/v1/traces")).toBe("[::1]");
    expect(hostOf("https://Cloud.Langfuse.com/api/public/otel/v1/traces")).toBe("cloud.langfuse.com");
    expect(hostOf("ftp://localhost/x")).toBeUndefined();
    expect(hostOf("not a url")).toBeUndefined();
    expect(hostOf("")).toBeUndefined();
  });

  it("requires the confirmation for another host only", () => {
    expect(needsRemoteConfirm(PHOENIX_ENDPOINT)).toBe(false);
    expect(needsRemoteConfirm(LANGFUSE_ENDPOINT)).toBe(false);
    expect(needsRemoteConfirm("http://[::1]:4318/v1/traces")).toBe(false);
    expect(needsRemoteConfirm("http://phoenix.localhost:6006/v1/traces")).toBe(false);
    expect(needsRemoteConfirm("https://cloud.langfuse.com/api/public/otel/v1/traces")).toBe(true);
    expect(needsRemoteConfirm("http://192.168.1.20:4318/v1/traces")).toBe(true);
    // Not a URL: nothing to confirm; Save is refused for the problem instead.
    expect(needsRemoteConfirm("nonsense")).toBe(false);
  });
});

describe("endpointProblem", () => {
  it("accepts an http or https URL without credentials", () => {
    expect(endpointProblem(PHOENIX_ENDPOINT)).toBeUndefined();
    expect(endpointProblem(" https://cloud.langfuse.com/api/public/otel/v1/traces ")).toBeUndefined();
  });

  it("names the problem otherwise", () => {
    expect(endpointProblem("")).toMatch(/Enter the endpoint/);
    expect(endpointProblem("   ")).toMatch(/Enter the endpoint/);
    expect(endpointProblem("localhost:6006")).toMatch(/full URL/);
    expect(endpointProblem("ftp://localhost/v1/traces")).toMatch(/http:\/\/ or https:\/\//);
    expect(endpointProblem("http://user:secret@host.example/v1/traces")).toMatch(/must not contain credentials/);
    expect(endpointProblem("http://user@host.example/v1/traces")).toMatch(/must not contain credentials/);
    // The same rules as the command (review L3): no query string.
    expect(endpointProblem("http://localhost:6006/v1/traces?api_key=x")).toMatch(/must not have a query string/);
  });
});

/** Only the record's presence counts here, so a partial outcome is enough. */
const outcome = (settledAt: string): TaskOutcome => ({ v: 1, result: "done", settledAt }) as unknown as TaskOutcome;

describe("confirmedFor", () => {
  it("binds the remote confirmation to the host it was given for (review M3)", () => {
    expect(confirmedFor("collector.example", "https://collector.example/v1/traces")).toBe(true);
    expect(confirmedFor("collector.example", "https://other.example/v1/traces")).toBe(false);
    expect(confirmedFor(undefined, "https://collector.example/v1/traces")).toBe(false);
    expect(confirmedFor("collector.example", "not a url")).toBe(false);
  });
});

describe("backfillCount", () => {
  const base = buildSeed(Date.parse("2026-09-30T12:00:00Z"));
  const settled = (t: Task, lifecycle: Task["lifecycle"], withOutcome: boolean): Task => ({ ...structuredClone(t), lifecycle, ...(withOutcome ? { outcome: outcome("2026-09-20T10:00:00Z") } : {}) });

  it("uses the service's count of unqueued settles (review M1), and every settled task with an outcome before it reports", () => {
    const [a, b, c, d] = base.tasks;
    const tasks: Task[] = [settled(a, "done", true), settled(b, "cancelled", true), settled(c, "done", false), settled(d, "active", true)];
    expect(backfillCount(tasks, undefined)).toBe(2);
    const status = (unqueued: number): TelemetryStatus => ({ enabled: true, sent: 2, pending: 0, failed: 0, unqueued, headersFromEnv: false });
    // Rows per settle can outnumber tasks (a task that settled twice); the service's count is the truth.
    expect(backfillCount(tasks, status(1))).toBe(1);
    expect(backfillCount(tasks, status(0))).toBe(0);
  });
});

describe("statusLine", () => {
  it("says what was sent, what waits and what failed, and when the last one went", () => {
    expect(statusLine(undefined, undefined)).toBe("Nothing sent yet.");
    expect(statusLine({ enabled: true, sent: 41, pending: 0, failed: 0, unqueued: 0, lastSentAt: "2026-09-30T11:58:00Z", headersFromEnv: true }, "2m ago")).toBe("Sent 41 · waiting 0 · failed 0 · last sent 2m ago");
    expect(statusLine({ enabled: false, sent: 0, pending: 0, failed: 2, unqueued: 0, headersFromEnv: false }, undefined)).toBe("Sent 0 · waiting 0 · failed 2");
  });
});
