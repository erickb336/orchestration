// ORC-018 §5.1: the trace export's configuration, pure. Where finished tasks are sent as OpenTelemetry
// traces, and whether a host other than this computer was confirmed. Credentials never live here: the
// server reads headers from OTEL_EXPORTER_OTLP_HEADERS and never stores them.

import { event } from "./model";
import { ControlError, StaleWriteError, type State, type TelemetryConfig } from "./types";

export interface TelemetryInput {
  enabled: boolean;
  endpoint: string;
  allowRemote: boolean;
}

/** The export before it was ever configured: off. */
export const TELEMETRY_OFF: TelemetryConfig = { enabled: false, endpoint: "", allowRemote: false, rev: 0 };

/** `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`: traffic that stays on this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

/**
 * Why an endpoint cannot be used, or undefined: it must be an `http:` or `https:` URL without
 * credentials, and a host other than loopback needs `allowRemote` (you confirmed what leaves the computer).
 */
export function telemetryEndpointProblem(endpoint: string, allowRemote: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "The endpoint must be a full URL, for example http://localhost:6006/v1/traces.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The endpoint must start with http:// or https://.";
  if (url.username || url.password) return "The endpoint must not contain credentials. Put headers in OTEL_EXPORTER_OTLP_HEADERS instead.";
  if (!url.hostname) return "The endpoint must name a host.";
  if (!isLoopbackHost(url.hostname) && !allowRemote) return `${url.hostname} is not this computer. Confirm that task titles, pattern and model names, timings, token counts and cost may be sent there.`;
  return undefined;
}

/** The endpoint as it is safe to record: origin and path, never credentials or a query string. */
export function describeEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid endpoint)";
  }
}

/**
 * Set the export's configuration, compare-and-set on its revision. `enabledAt` is set when the export
 * goes from off to on; only tasks that settle after it are sent automatically (the server's backfill
 * sends earlier ones on request). An unchanged configuration is a no-op.
 */
export function setTelemetry(state: State, input: TelemetryInput, expectedRev: number, now: string): State {
  const prev = state.project.telemetry ?? TELEMETRY_OFF;
  if (prev.rev !== expectedRev) throw new StaleWriteError(expectedRev, prev.rev);
  const endpoint = input.endpoint.trim();
  if (input.enabled || endpoint) {
    const why = telemetryEndpointProblem(endpoint, input.allowRemote);
    if (why) throw new ControlError(why);
  }
  const same = prev.enabled === input.enabled && prev.endpoint === endpoint && prev.allowRemote === input.allowRemote;
  if (same) return state;
  const s = structuredClone(state);
  const next: TelemetryConfig = {
    enabled: input.enabled,
    endpoint,
    allowRemote: input.allowRemote,
    ...(prev.enabledAt ? { enabledAt: prev.enabledAt } : {}),
    rev: prev.rev + 1,
  };
  if (input.enabled && !prev.enabled) next.enabledAt = now;
  s.project.telemetry = next;
  const host = endpoint ? new URL(endpoint).hostname : "";
  const remote = endpoint && !isLoopbackHost(host) ? " (a host other than this computer, as you confirmed)" : "";
  event(s, now, "user", "config", next.enabled ? `Traces on: finished tasks are sent to ${describeEndpoint(endpoint)}${remote}` : "Traces off: nothing is sent");
  return s;
}
