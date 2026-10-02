// What must never appear in a committed real-run record (docs/real-runs). Shared by the scenario
// (scripts/real-run-test.mjs), which checks a record before writing it, and the unit test
// (server/realRunRecords.test.ts), which checks every committed one (ORC-027).

const PATTERNS = [
  // Case-sensitive on purpose: macOS homes are /Users, Linux homes /home; a lower-case "/users/" is far more
  // often a URL path in an agent's summary than a home directory.
  { what: "a home-directory path", re: /\/(Users|home)\/[^/"\s\\]+/ },
  { what: "a Windows home-directory path", re: /\b[A-Za-z]:(\\\\|\\)+Users(\\\\|\\)+[^\\"\s]+/i },
  { what: "an Anthropic or OpenAI key or token", re: /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/ },
  { what: "a GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { what: "a bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { what: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { what: "an AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What in this text must not be committed, by kind. `extra` adds values known only where the record was made
 * (the user name, the computer's name, the git email), matched as whole words.
 * @param {string} text
 * @param {{ what: string; value: string | undefined | null }[]} [extra]
 * @returns {string[]}
 */
export function leaksIn(text, extra = []) {
  const found = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.what);
  for (const { what, value } of extra) {
    if (value && value.length >= 3 && new RegExp(`(^|[^A-Za-z0-9_])${escape(value)}($|[^A-Za-z0-9_])`).test(text)) found.push(what);
  }
  return [...new Set(found)];
}

/**
 * A home-directory path that an exact-string replacement missed (one cut short by a truncated message, say)
 * becomes "~".
 * @param {string} text
 */
export function scrubHomePaths(text) {
  return text.replace(/\/(Users|home)\/[^/"\s\\]+/g, "~");
}
