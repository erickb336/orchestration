// Shared redaction for anything shown to users or written to logs, and the worker environment filter.
// The service never reads, stores, prints or sets a token; these helpers keep one that a child process
// echoes (or that sits in the environment) out of state, events and error messages.

import { SECRET_NAME } from "../src/domain/secrets";

export { SECRET_NAME };
/**
 * Token shapes: OpenAI (sk-…), Stripe (sk_live_…, sk_test_…), JWTs, GitHub (ghp_… and github_pat_…),
 * npm (npm_ plus 36 characters), AWS access keys (AKIA/ASIA plus 16), GitLab (glpat-…) and Slack (xox?-…).
 */
const SECRET_SHAPE = /\b(sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9]{36}|(?:AKIA|ASIA)[A-Z0-9]{16}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g;
/** ORC-013: a PEM private-key block, whatever its algorithm label, and a bearer token of 20 or more token characters. */
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
/** A block cut off by an output cap has no END line: everything from BEGIN to the end of the text goes (L4). */
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g;

/** Remove secret-looking env values and token shapes from text shown to users or logs. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_NAME.test(k)) out = out.split(v).join("***");
  }
  return out.replace(PEM_BLOCK, "***").replace(PEM_OPEN, "***").replace(BEARER, "Bearer ***").replace(SECRET_SHAPE, "***");
}

/** GitHub token variables a worker process must never receive, in every worker environment. */
export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** A copy of `env` without the GitHub token variables. Only the service itself talks to GitHub. */
export function withoutGitHubTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of GITHUB_TOKEN_VARS) delete out[k];
  return out;
}
