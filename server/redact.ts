// Shared redaction for anything shown to users or written to logs, and the worker environment filter.
// The service never reads, stores, prints or sets a token; these helpers keep one that a child process
// echoes (or that sits in the environment) out of state, events and error messages.

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const SECRET_SHAPE = /\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;

/** Remove secret-looking env values and token shapes from text shown to users or logs. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_NAME.test(k)) out = out.split(v).join("***");
  }
  return out.replace(SECRET_SHAPE, "***");
}

/** GitHub token variables a worker process must never receive, in every worker environment. */
export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** A copy of `env` without the GitHub token variables. Only the service itself talks to GitHub. */
export function withoutGitHubTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of GITHUB_TOKEN_VARS) delete out[k];
  return out;
}
