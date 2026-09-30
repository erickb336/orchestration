# Generated Codex app-server protocol types

Generated source. Do not edit by hand.

- Source: `@openai/codex` **0.159.2** (the version pinned in `package.json`; `codex --version` prints `codex-cli 0.159.2`).
- Command, run from the repository root:

  ```sh
  npx codex app-server generate-ts --out server/runtimes/codex-protocol
  ```

- Generated without `--experimental`, so experimental-only methods and fields are not included.
- The Codex adapter (`server/runtimes/codex.ts`, `codexRpc.ts`) imports these as types only.

When the pinned Codex version changes, delete this folder, regenerate it with the command above,
update this README, and re-run `npx tsc -p tsconfig.server.json` and the adapter tests.

Wire notes verified against 0.159.2 (not expressed in the types): messages are newline-delimited
JSON over stdio, JSON-RPC 2.0 semantics **without** a `"jsonrpc"` field; the server exits on stdin EOF.
