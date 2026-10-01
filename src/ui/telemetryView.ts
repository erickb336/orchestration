// ORC-018 §5.4: the pure helpers behind Settings → Traces. The loopback rule mirrors the domain's
// `setTelemetry` validation (§5.1) so the form can require the confirmation before Save; the command
// still checks it.

import type { TelemetryStatus } from "../api";
import type { Task } from "../domain/types";

export const PHOENIX_ENDPOINT = "http://localhost:6006/v1/traces";
export const LANGFUSE_ENDPOINT = "http://localhost:3000/api/public/otel/v1/traces";

/** The host part of an http(s) endpoint, lower-cased, without the port; undefined when it is not a URL. */
export function hostOf(endpoint: string): string | undefined {
  try {
    const u = new URL(endpoint.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** §5.1: localhost, 127.0.0.1, [::1] and *.localhost stay on this computer. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** True when the endpoint names another host, so the "what leaves this computer" checkbox is required before Save. */
export function needsRemoteConfirm(endpoint: string): boolean {
  const host = hostOf(endpoint);
  return host !== undefined && !isLoopbackHost(host);
}

/** Why the endpoint cannot be saved, in the command's own terms; undefined when it can. */
export function endpointProblem(endpoint: string): string | undefined {
  const s = endpoint.trim();
  if (!s) return "Enter the endpoint.";
  // "localhost:6006" parses as a URL with the scheme "localhost:"; ask for the full form instead.
  let u: URL;
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error("no scheme");
    u = new URL(s);
  } catch {
    return "The endpoint must be a full URL, such as http://localhost:6006/v1/traces.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "The endpoint must start with http:// or https://.";
  if (u.username || u.password) return "The endpoint must not carry credentials; put headers in OTEL_EXPORTER_OTLP_HEADERS instead.";
  return undefined;
}

/** "Send finished tasks (n)": settled tasks with an outcome that have no export row yet, never below zero. */
export function backfillCount(tasks: Task[], status: TelemetryStatus | undefined): number {
  const settled = tasks.filter((t) => (t.lifecycle === "done" || t.lifecycle === "cancelled") && !!t.outcome).length;
  const known = status ? status.sent + status.pending + status.failed : 0;
  return Math.max(0, settled - known);
}

/** "Sent 41 · waiting 0 · failed 0 · last sent 2m ago". `lastSent` is already relative. */
export function statusLine(status: TelemetryStatus | undefined, lastSent: string | undefined): string {
  if (!status) return "Nothing sent yet.";
  const parts = [`Sent ${status.sent}`, `waiting ${status.pending}`, `failed ${status.failed}`];
  if (status.lastSentAt && lastSent) parts.push(`last sent ${lastSent}`);
  return parts.join(" · ");
}
