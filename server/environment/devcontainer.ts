// The repository's dev container, read at the trusted base (docs/design/project-environment.md): the first dev
// container file, parsed; for a build, the Dockerfile it names, read and checked (dockerfileRefusal); and the digest
// the owner confirms (devcontainerDigest). The scheduler (a run's environment) and the HTTP API (the settings card)
// both read it here.

import { DEVCONTAINER_FILES, devcontainerDigest, dockerfileRefusal, parseDevcontainer, type DevcontainerFound } from "../../src/domain/environment";

const MAX_BYTES = 256 * 1024;

/** A file of the repository at the trusted base, at most `maxBytes`; undefined when it is not there. */
export type ReadAtBase = (path: string, maxBytes: number) => { text: string; truncated: boolean } | undefined;

/** What was found, and for a build the Dockerfile's text (the runner builds from this text, never from the change). */
export type DevcontainerRead = DevcontainerFound & { dockerfile?: string };

export function readDevcontainer(read: ReadAtBase): DevcontainerRead | undefined {
  for (const file of DEVCONTAINER_FILES) {
    const r = read(file, MAX_BYTES);
    if (!r) continue;
    if (r.truncated) return { file, parsed: { refused: `${file} is larger than 256 KB.` } };
    const parsed = parseDevcontainer(r.text, file);
    if ("refused" in parsed) return { file, parsed };
    if ("image" in parsed) return { file, parsed, sha256: devcontainerDigest(r.text) };
    const path = parsed.build.dockerfile;
    const df = read(path, MAX_BYTES);
    if (!df) return { file, parsed: { refused: `${file} names the Dockerfile ${path}, which is not in the repository at the trusted base.` } };
    if (df.truncated) return { file, parsed: { refused: `${file} names the Dockerfile ${path}, which is larger than 256 KB.` } };
    const why = dockerfileRefusal(df.text, path);
    if (why) return { file, parsed: { refused: why } };
    return { file, parsed, sha256: devcontainerDigest(r.text, { path, text: df.text }), dockerfile: df.text };
  }
  return undefined;
}
