// ORC-018 §5.4: the pure helpers behind Settings → Traces. The loopback rule mirrors the domain's
// `setTelemetry` validation (§5.1) so the form can require the confirmation before Save; the command
// still checks it.

import type { TelemetryStatus } from "../api";
import { isLoopbackHost as domainIsLoopbackHost, telemetryEndpointProblem } from "../domain/telemetry";
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

/** §5.1: the domain's own rule, so the form and the command never disagree. */
export const isLoopbackHost = domainIsLoopbackHost;

/** Review M3: a confirmation counts only for the host it was given for; pasting another host needs it again. */
export function confirmedFor(confirmedHost: string | undefined, endpoint: string): boolean {
  const host = hostOf(endpoint);
  return host !== undefined && confirmedHost === host;
}

/** True when the endpoint names another host, so the "what leaves this computer" checkbox is required before Save. */
export function needsRemoteConfirm(endpoint: string): boolean {
  const host = hostOf(endpoint);
  return host !== undefined && !isLoopbackHost(host);
}

/**
 * Why the endpoint cannot be saved, in the command's own terms; undefined when it can. The remote-host
 * confirmation is asked separately by the form, so it is not part of this check.
 */
export function endpointProblem(endpoint: string): string | undefined {
  const s = endpoint.trim();
  if (!s) return "Enter the endpoint.";
  // "localhost:6006" parses as a URL with the scheme "localhost:"; ask for the full form instead.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return "The endpoint must be a full URL, such as http://localhost:6006/v1/traces.";
  return telemetryEndpointProblem(s, true);
}

/**
 * "Send finished tasks (n)": the service's own count of settled tasks it has no export row for (review M1).
 * Before the service reports it, every settled task with an outcome.
 */
export function backfillCount(tasks: Task[], status: TelemetryStatus | undefined): number {
  if (status) return Math.max(0, status.unqueued);
  return tasks.filter((t) => (t.lifecycle === "done" || t.lifecycle === "cancelled") && !!t.outcome).length;
}

/** "Sent 41 · waiting 0 · failed 0 · last sent 2m ago". `lastSent` is already relative. */
export function statusLine(status: TelemetryStatus | undefined, lastSent: string | undefined): string {
  if (!status) return "Nothing sent yet.";
  const parts = [`Sent ${status.sent}`, `waiting ${status.pending}`, `failed ${status.failed}`];
  if (status.lastSentAt && lastSent) parts.push(`last sent ${lastSent}`);
  return parts.join(" · ");
}
