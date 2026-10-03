# Running Orchestrator on your own repository

The short version is in the [README](../README.md#use-it-on-your-own-repository). This page has the details: setup, sign-in choices, and what real runs do on your machine.

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`) and git.

```bash
git clone https://github.com/erickb336/orchestrator.git
cd orchestrator
npm run setup
npm start
```

**`npm run setup`** asks a few questions once:

- It checks Node and git, and installs dependencies if they are missing.
- It asks whether to run **real agents** or the **demo** (a sample project on a simulated runtime: no agents, no cost).
- **Codex:** it reports whether Codex is signed in and offers to run `codex login`. Codex uses your ChatGPT sign-in, with no separate bill.
- **Claude:** it asks how Claude signs in:
  - **Codex only.** Claude is not used, and Codex becomes the lead and every role's default.
  - **An Anthropic API key.** Billed per use, separately from any subscription.
  - **Your own Claude subscription token.** Opt-in, for personal use; see the note below.
  - **Cloud credentials** already set in your terminal: Bedrock, Vertex, Foundry, or Claude Platform on AWS.
- **On macOS,** it can store the key or token in your Keychain. You type it into macOS's own hidden prompt, and Orchestrator never sees it, saves it to a file, or shows it.
- It offers an `orchestrator` command you can run from any folder (through `npm link`).

The answers are saved to `~/.orchestration/launcher.json`, which never contains a key or token. Run setup again at any time to change them.

**`npm start`** (or `orchestrator`) builds and starts Orchestrator with those answers. It finds the Claude credential in your terminal or your Keychain, says what it is using, and opens http://127.0.0.1:5319 in your browser. Press Ctrl-C to stop it.

- **Other commands:** `npm run status` (or `orchestrator status`) shows what is saved and which credentials are found, never their values.
- **Start options:**
  - `--demo` or `--real` overrides the saved choice for one start.
  - `--port <n>` changes the port.
  - `--no-open` leaves the browser closed.
- **Environment variables** you set yourself always override saved answers.
- **Without setup,** `npm start` runs the demo.

Next, in the app, the Overview's **Get started** list takes you through connecting a repository, writing your vision, and choosing how involved you want to be (Autopilot, Check-in or Manual). Settings → Providers shows each provider's status, and checking never starts a model run.

## Your own Claude subscription token

Setup runs `claude setup-token` for you if Claude Code is installed. Claude agents and the lead then run on your plan's usage limits, which are shared with your own Claude Code, and several agents use those limits up quickly. **Check this is allowed for you:** Anthropic's Agent SDK documentation says, "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." It does not say whether a subscriber may use their own token in their own tool.

Without setup, the same choices are environment variables:

- `ORCHESTRATION_RUNTIME=real`
- `ANTHROPIC_API_KEY`, or `ORCHESTRATION_CLAUDE_AUTH=subscription` together with `CLAUDE_CODE_OAUTH_TOKEN`
- the cloud flags, such as `CLAUDE_CODE_USE_BEDROCK=1`

In subscription mode no API key or cloud setting is passed to agents.

**Agents sign in with the inference-only token, not your full login** (the owner's choice, 2026-10-03). A full login would let agents use your claude.ai connectors (Figma, Linear, Slack, Drive) and show your plan's usage, but every agent would then reach everything you are connected to, and they would share your own Claude Code login. With the inference-only token, agents can call the model and use MCP servers configured on this computer, and nothing else of your account.

## Checking that real agents work

`npm run test:real` runs one short scenario with real agents, against a throwaway repository inside this checkout's ignored `evidence/` folder:

- in Vision, one studio round: the lead opens it, a designer makes an artifact, the PE reviews it, and the test approves it into the draft as you would;
- the test starts the factory with the pre-flight's own command, which names the Lock in summary it showed;
- a Codex agent and a Claude agent work at the same time;
- each is paused and resumed, then the whole project is;
- each gets a note the moment it is dispatched;
- each task's review findings are revised before the lead writes its spec (if a review asks for a decision, the test answers "fix" and records it);
- both tasks then finish.

The latest run, with a studio round before the start (a lead run, a designer run and a PE run), took 149 seconds and about $0.17 of Claude usage. Each extra review round adds about $0.03. It reads the same environment variables as above, and prints only whether each provider is ready, never a credential.

**What it leaves:**

- The full evidence goes to `evidence/`, which is never committed.
- A record goes to `docs/real-runs/`, without local paths or the service log, so it can be committed.

A unit test fails if a record holds a home-directory path or anything shaped like a key. `npm run test:integration` runs the same scenario on simulated agents, at no cost, and CI runs it on every pull request.

## What real runs do on your machine

What real runs do on your machine:

- Every run gets its own git worktree under `~/.orchestration/worktrees`, outside your repository's working tree.
  - Coders commit on `orchestration/<project>/<task>/<step>/<run>` branches (the service makes the commits).
  - Every other role gets a read-only checkout.
  - Finished work is merged, one task at a time, into `orchestration/<project>/integration`.
  - With automatic delivery on, that branch is fast-forwarded into your chosen branch, but only when your working tree is clean. Your latest commits are merged into the integration branch first.
- **GitHub pull requests** (Settings → Delivery, off by default) are a third delivery mode, never on together with local delivery:
  - Each finished task becomes one pull request on a branch the app owns (`orchestration/<project>/pr/<task>-<n>`), opened with your own `gh` sign-in. The app never reads or stores a token, never forces a push, and publishes only commits Orchestrator made.
  - **You merge** (default): an independent agent reviews the change, the app watches the required checks, and lists the pull request under Needs you once it is ready. You merge it on GitHub or with Merge in the app, which is tied to the commit you saw.
  - **Merges automatically** (a separate, explicit setting): the app merges one pull request at a time, and only when an independent review is clean for exactly that change, every required check passed on its exact head, GitHub reports it mergeable, it touches no protected file, and nothing is paused. It first brings the pull request up to date with the base and waits for the checks again, so what lands is what was tested.
  - The review is the task's own review when it provably saw the final change and ran on another provider than the writer. Otherwise the app starts one dedicated review task. It never swaps in another provider by itself.
  - In automatic mode a failed required check, open review findings or a conflict get one fix task, pushed onto the same pull request, at most two per pull request.
  - If the check on the base branch fails after a merge the app made, automatic merging pauses; a second failure within a day keeps it paused until you resume it. Nothing is reverted automatically.
  - Everything that lands is listed under Results, which never blocks anything. From there you can mark it as seen, leave a note, or send it back as a fix or a revert.
  - Pull requests are opened, reviewed and merged only while the service is running. There are no webhooks.
- **Agent environment** is set per provider:
  - **Isolated** (default): agents see none of your settings, plugins, or web tools, and use only the MCP connections you tick.
  - **Use my local setup:** agents get your user-level Claude or Codex configuration, including all its MCP servers and plugins.
    - The exception is the agent-kit plugin's hooks. Every agent runs with `AGENT_KIT_HOOKS=off`, because Orchestrator already gives each step its principles.
- **Limits:** Settings → Run limits caps turns, time, and Claude spend per run. Codex runs are bounded by time.
