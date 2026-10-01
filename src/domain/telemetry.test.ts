// ORC-018 B1 §5.1: the trace export's configuration command. The endpoint must be an http or https URL
// without credentials; a host other than loopback needs the confirmation; a stale revision is refused;
// `enabledAt` is set on the off → on transition only.

import { describe, expect, it } from "vitest";
import { InvalidCommandError, runCommand } from "./commands";
import { buildSeed } from "./seed";
import { describeEndpoint, isLoopbackHost, setTelemetry, telemetryEndpointProblem } from "./telemetry";
import { ControlError, StaleWriteError } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const PHOENIX = "http://localhost:6006/v1/traces";

describe("telemetryEndpointProblem", () => {
  it("accepts http and https URLs to this computer", () => {
    for (const u of [PHOENIX, "https://127.0.0.1:4318/v1/traces", "http://[::1]:4318/v1/traces", "http://phoenix.localhost:6006/v1/traces", "http://localhost:3000/api/public/otel/v1/traces"]) expect(telemetryEndpointProblem(u, false), u).toBeUndefined();
  });

  it("refuses anything that is not an http or https URL", () => {
    expect(telemetryEndpointProblem("", false)).toMatch(/full URL/);
    expect(telemetryEndpointProblem("localhost:6006", false)).toMatch(/http:\/\/ or https:\/\//);
    expect(telemetryEndpointProblem("ftp://localhost/x", false)).toMatch(/http:\/\/ or https:\/\//);
    expect(telemetryEndpointProblem("grpc://localhost:4317", false)).toMatch(/http:\/\/ or https:\/\//);
    expect(telemetryEndpointProblem("not a url", false)).toMatch(/full URL/);
  });

  it("refuses credentials in the URL", () => {
    expect(telemetryEndpointProblem("http://pk:sk@localhost:3000/api/public/otel/v1/traces", false)).toMatch(/credentials/);
    expect(telemetryEndpointProblem("http://user@localhost:3000/", true)).toMatch(/credentials/);
  });

  it("needs the confirmation for a host other than loopback", () => {
    expect(telemetryEndpointProblem("https://cloud.langfuse.com/api/public/otel/v1/traces", false)).toMatch(/cloud\.langfuse\.com is not this computer/);
    expect(telemetryEndpointProblem("https://cloud.langfuse.com/api/public/otel/v1/traces", true)).toBeUndefined();
    expect(telemetryEndpointProblem("http://192.168.1.20:6006/v1/traces", false)).toMatch(/not this computer/);
    expect(telemetryEndpointProblem("http://localhost.evil.com/v1/traces", false)).toMatch(/not this computer/);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
  });

  it("describes an endpoint without its query string", () => {
    expect(describeEndpoint("http://localhost:6006/v1/traces?key=secret")).toBe("http://localhost:6006/v1/traces");
  });
});

describe("setTelemetry", () => {
  it("turns the export on, recording when, and leaves the state untouched when nothing changes", () => {
    const s0 = seed();
    expect(s0.project.telemetry).toBeUndefined();
    const s1 = setTelemetry(s0, { enabled: true, endpoint: PHOENIX, allowRemote: false }, 0, at(1));
    expect(s1.project.telemetry).toEqual({ enabled: true, endpoint: PHOENIX, allowRemote: false, enabledAt: at(1), rev: 1 });
    expect(s1.events.at(-1)!.message).toMatch(/Traces on: finished tasks are sent to http:\/\/localhost:6006\/v1\/traces/);
    expect(setTelemetry(s1, { enabled: true, endpoint: PHOENIX, allowRemote: false }, 1, at(2))).toBe(s1);
    expect(s0.project.telemetry).toBeUndefined();
  });

  it("sets enabledAt on the off → on transition only", () => {
    let s = setTelemetry(seed(), { enabled: true, endpoint: PHOENIX, allowRemote: false }, 0, at(1));
    // The endpoint changes while on: the moment it went on is kept.
    s = setTelemetry(s, { enabled: true, endpoint: "http://localhost:4318/v1/traces", allowRemote: false }, 1, at(2));
    expect(s.project.telemetry).toMatchObject({ enabledAt: at(1), rev: 2 });
    // Off keeps the record; on again starts afresh, so tasks settled while off are not sent by themselves.
    s = setTelemetry(s, { enabled: false, endpoint: "http://localhost:4318/v1/traces", allowRemote: false }, 2, at(3));
    expect(s.project.telemetry).toMatchObject({ enabled: false, enabledAt: at(1), rev: 3 });
    expect(s.events.at(-1)!.message).toBe("Traces off: nothing is sent");
    s = setTelemetry(s, { enabled: true, endpoint: "http://localhost:4318/v1/traces", allowRemote: false }, 3, at(4));
    expect(s.project.telemetry).toMatchObject({ enabled: true, enabledAt: at(4), rev: 4 });
  });

  it("refuses a stale revision with the typed error", () => {
    const s = setTelemetry(seed(), { enabled: true, endpoint: PHOENIX, allowRemote: false }, 0, at(1));
    expect(() => setTelemetry(s, { enabled: false, endpoint: PHOENIX, allowRemote: false }, 0, at(2))).toThrow(StaleWriteError);
    expect(() => setTelemetry(seed(), { enabled: false, endpoint: "", allowRemote: false }, 3, at(2))).toThrow(StaleWriteError);
  });

  it("refuses a bad endpoint, credentials, and a remote host without the confirmation", () => {
    expect(() => setTelemetry(seed(), { enabled: true, endpoint: "localhost:6006", allowRemote: false }, 0, at(1))).toThrow(ControlError);
    expect(() => setTelemetry(seed(), { enabled: true, endpoint: "http://a:b@localhost:6006/v1/traces", allowRemote: false }, 0, at(1))).toThrow(/credentials/);
    expect(() => setTelemetry(seed(), { enabled: true, endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces", allowRemote: false }, 0, at(1))).toThrow(/not this computer/);
    const s = setTelemetry(seed(), { enabled: true, endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces", allowRemote: true }, 0, at(1));
    expect(s.project.telemetry).toMatchObject({ enabled: true, allowRemote: true });
    expect(s.events.at(-1)!.message).toMatch(/a host other than this computer, as you confirmed/);
    // Off with an endpoint still kept: the endpoint is still checked; off with none is fine.
    expect(() => setTelemetry(seed(), { enabled: false, endpoint: "nope", allowRemote: false }, 0, at(1))).toThrow(ControlError);
    expect(setTelemetry(seed(), { enabled: false, endpoint: "", allowRemote: false }, 0, at(1)).project.telemetry).toBeUndefined();
  });

  it("refuses a query string, where keys tend to go, so none is ever stored or shown (review L3)", () => {
    expect(() => setTelemetry(seed(), { enabled: true, endpoint: "http://localhost:6006/v1/traces?api_key=SECRET", allowRemote: false }, 0, at(1))).toThrow(/must not have a query string/);
    expect(() => setTelemetry(seed(), { enabled: false, endpoint: "http://localhost:6006/v1/traces?x=1", allowRemote: false }, 0, at(1))).toThrow(/must not have a query string/);
  });

  it("is reachable as the setTelemetry command, which checks the argument shapes", () => {
    const out = runCommand(seed(), "setTelemetry", { config: { enabled: true, endpoint: PHOENIX, allowRemote: false }, expectedRev: 0 }, at(1));
    expect(out.state.project.telemetry).toMatchObject({ enabled: true, endpoint: PHOENIX, rev: 1 });
    expect(() => runCommand(seed(), "setTelemetry", { config: { enabled: "yes", endpoint: PHOENIX, allowRemote: false }, expectedRev: 0 }, at(1))).toThrow(InvalidCommandError);
    expect(() => runCommand(seed(), "setTelemetry", { config: { enabled: true, endpoint: PHOENIX, allowRemote: false } }, at(1))).toThrow(/expectedRev must be a number/);
    expect(() => runCommand(seed(), "setTelemetry", { expectedRev: 0 }, at(1))).toThrow(/config must be an object/);
    expect(() => runCommand(out.state, "setTelemetry", { config: { enabled: false, endpoint: PHOENIX, allowRemote: false }, expectedRev: 0 }, at(2))).toThrow(StaleWriteError);
  });
});
