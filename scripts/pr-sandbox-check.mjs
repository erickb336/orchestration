// Evidence run for pull-request delivery (ORC-008) against a THROWAWAY GitHub repository.
//
//   node scripts/pr-sandbox-check.mjs --repo <owner>/<name>          prints what it would do; contacts nothing
//   node scripts/pr-sandbox-check.mjs --repo <owner>/<name> --yes    does it
//   node scripts/pr-sandbox-check.mjs --fake                         the same scenarios against a local bare
//                                                                    repository and a fake GitHub; contacts nothing
//
// There is no default repository. Without --repo it refuses. Without --yes it only explains.
// It refuses erickb336/orchestration and the repository this checkout's `origin` points at.
//
// Options (with --yes or --fake):
//   --check-seconds <n>   how long the sandbox's required check sleeps (default 45; 10 to 600)
//   --only a,b,c          run only these scenarios (a b e f c d g h)
//   --keep                keep the sandbox ruleset afterwards (default: it is removed)
//   --real-agents         use the real Claude and Codex for every task (costs usage; needs credentials).
//                         By default scripted stand-ins write one small file and review it: no model runs.
//
// NOT VERIFIED: the real mode has never been run against GitHub. It uses your own `gh` and git
// sign-in, and never reads, prints or stores a token.

import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (flag) => argv.includes(flag);
const root = resolve(import.meta.dirname, "..");
const say = (text = "") => console.log(text);
const refuse = (text) => {
  console.error(`Refused: ${text}`);
  process.exit(2);
};

const FAKE = has("--fake");
const repo = value("--repo");
const seconds = Math.max(10, Math.min(600, Number(value("--check-seconds") ?? 45) || 45));

if (FAKE && (repo || has("--yes"))) refuse("--fake contacts nothing and takes no repository. Use either --fake, or --repo with --yes.");

if (!FAKE) {
  // 1. An explicit repository. Never a default, never a guess from this checkout.
  if (!repo || repo.startsWith("-")) {
    refuse("no repository given. Pass --repo <owner>/<name> of a throwaway repository made for this run. There is no default.\n         To see what would happen there, run it without --yes. To try the script without GitHub: --fake.");
  }
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) refuse(`"${repo}" is not an <owner>/<name> repository.`);
  // 2. Never the project's own repository.
  if (repo.toLowerCase() === "erickb336/orchestration") refuse("erickb336/orchestration is never used for this run. Use a repository made for it.");
  let own = "";
  try {
    const url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    own = (/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) ?? [])[1] ?? "";
  } catch {
    own = "";
  }
  if (own && own.toLowerCase() === repo.toLowerCase()) refuse(`${repo} is the repository this checkout belongs to. Use a throwaway repository.`);

  const plan = `
This run drives Orchestration's pull-request delivery against https://github.com/${repo}
with your own gh and git sign-in. Scripted stand-ins replace Claude and Codex unless you pass
--real-agents. It takes about 25 to 45 minutes, mostly waiting for the repository's check.

What it does to ${repo}:

  Setup (the script itself, not the application)
    - reads the repository (it must be one you administer, with no stars, not a fork, not archived)
    - clones it into evidence/ORC-008/run-<time>/work/repo
    - pushes ONE commit directly to main that adds .github/workflows/orc-sandbox-check.yml:
      a workflow with one job named "check" that sleeps ${seconds} s (on pull requests and on main)
    - creates the ruleset "orc-sandbox-protect-main" on main: a pull request is required, the status
      check "check" is required (not strict), 0 approvals, repository admins may bypass ("always")

  Through the application (exactly what it would do for you)
    - pushes branches named orchestration/<project>/pr/T-00N-1, one commit each, authored by
      "Orchestration <orchestration@localhost>", each adding one small file orc-sandbox-T-00N.txt
    - opens about 8 pull requests from those branches into main
    - merges about 6 of them with: gh pr merge <n> --merge --match-head-commit <sha>
      (3 at your "click", one of them a revert; 3 automatically after the check and an agent review)
    - closes 2 of them without merging, with the comment "Closed from Orchestration."
    - posts 2 comments on one merged pull request
    - never forces a push, never deletes a branch, never uses --admin or GitHub's auto-merge

  Deliberate tests (the script itself)
    - pushes one extra commit to one pull request branch, as "a person", then asks for a merge bound
      to the OLD head, which GitHub must refuse
    - posts one comment with the application's marker, to show it is found and not posted twice
    - switches "require_extra_approval_for_unattributed_changes" on in the sandbox ruleset for one
      pull request, then back off (skipped if GitHub does not accept it)
    - stops and restarts the service while one merge is in flight

  Afterwards
    - removes the sandbox ruleset (keep it with --keep)
    - LEAVES the branches, the pull requests and the workflow file: delete the repository when done

Evidence (commands and redacted outputs) is written to evidence/ORC-008/run-<time>/.
Nothing outside ${repo} and that folder is changed.
`;
  if (!has("--yes")) {
    say(plan);
    say("This was a dry run: nothing was contacted. Add --yes to do it.");
    process.exit(0);
  }
  say(plan);
  say(`Starting against ${repo} in 5 seconds. Press Ctrl-C to stop.`);
  await new Promise((r) => setTimeout(r, 5000));
}

const child = spawn(process.execPath, ["--import", "tsx", "server/testing/prSandbox.ts", ...argv], {
  cwd: root,
  // The runner refuses unless this names the very repository that was confirmed above.
  env: { ...process.env, ...(FAKE ? {} : { ORC_SANDBOX_CONFIRMED: repo }) },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
