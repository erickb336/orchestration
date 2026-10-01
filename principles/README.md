# Principles

Short working principles for the agents Orchestrator runs. Each flow step names the ones that fit its job (`"principles"` on the steps in `flows/*.json`, in the internal flows and in the check rounds), and the service adds them to the agent's instructions under "Principles for this step", in the order of the table in [docs/tasks/ORC-024.md](../docs/tasks/ORC-024.md). The lead's own runs get a fixed set. Every run records which principles it was given, with a hash of each text. The agents that build Orchestrator follow the same files (AGENTS.md).

## The files

One file per principle, `<id>.md`. The frontmatter carries `id` (the file name), `name`, `applyWhen` (one line) and `source` (the credit). The body is at most 200 words: the rule, when it applies and does not, and when to stop. The voice is plain and literal (PRODUCT.md).

"Attack the premise" is given to no step directly. The service adds it to a repair round that follows a round which failed the same way: the same check failed again, or a finding came back. The run records why.

## Changing one

Edit the file and run `npm test`. The tests first compile these files into `src/domain/builtInPrinciples.json` (the copy the app imports; nothing can import Markdown), then check every file: the frontmatter, the id, the 200-word limit, the credit, and that no step's section passes its 1,000-word cap. Commit the file and the regenerated JSON together; CI fails if they differ. `npx vitest run` alone does not regenerate; its test then names `npm run principles`.

## Credit

Adapted from pstack by Lauren Tan (MIT): `pstack/skills/principle-*/SKILL.md` at commit `12d587dfb20741cafc376c42c696c5f6e2a64487` of [github.com/cursor/plugins](https://github.com/cursor/plugins). The license is in [LICENSE-pstack](LICENSE-pstack); each file's `source` names its original. The texts were shortened and rewritten in this project's voice. Cross-links, sub-agent and tool-specific instructions were removed, because Orchestrator's agents run one step in one worktree and start no sub-agents. Eight pstack principles were left out of this first set (see the spec).
