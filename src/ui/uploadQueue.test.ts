// ORC-014 review 4: the upload queue never reads a stale `busy`. Files enqueued after an async folder
// walk (which may finish after an earlier drain ended, or while one runs) always drain, and each drain
// attaches its staged files as one batch (review 9).

import { describe, expect, it } from "vitest";
import type { AttachVisionDocsResult, VisionDocUploadOk } from "../api";
import { UploadQueue, type UploadStatus } from "./uploadQueue";

/** A promise resolved from the outside, so a test controls when an upload or a commit completes. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type UploadResult = { ok: true; body: VisionDocUploadOk } | { ok: false; error: string };
type AttachResult = { ok: true; result: AttachVisionDocsResult } | { ok: false; error: string };

function harness() {
  const statuses = new Map<string, { status: UploadStatus; detail?: string }[]>();
  const uploads: { path: string; d: ReturnType<typeof deferred<UploadResult>> }[] = [];
  const attaches: { docIds: string[]; batchId: string; d: ReturnType<typeof deferred<AttachResult>> }[] = [];
  const queue = new UploadQueue({
    upload: (path) => {
      const d = deferred<UploadResult>();
      uploads.push({ path, d });
      return d.promise;
    },
    attach: (docIds, batchId) => {
      const d = deferred<AttachResult>();
      attaches.push({ docIds, batchId, d });
      return d.promise;
    },
    onStatus: (key, status, detail) => {
      const list = statuses.get(key) ?? [];
      list.push(detail !== undefined ? { status, detail } : { status });
      statuses.set(key, list);
    },
    batchId: () => `b${attaches.length + 1}`,
  });
  const last = (key: string) => statuses.get(key)?.at(-1);
  const file = (key: string) => ({ key, path: `${key}.md`, file: new Blob([key]) });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { queue, uploads, attaches, statuses, last, file, settle };
}

describe("UploadQueue (review 4)", () => {
  it("files enqueued while a drain runs join its batch; files enqueued after it ended start a new drain and are never left Waiting", async () => {
    const h = harness();
    h.queue.enqueue([h.file("a")]);
    await h.settle();
    expect(h.queue.busy).toBe(true);
    expect(h.uploads.map((u) => u.path)).toEqual(["a.md"]);
    expect(h.last("a")).toEqual({ status: "uploading" });
    // The folder walk finishes while a is still uploading: b joins the running drain.
    h.queue.enqueue([h.file("b")]);
    h.uploads[0].d.resolve({ ok: true, body: { version: 1, docId: "doc-a", status: "staged" } });
    await h.settle();
    expect(h.last("a")).toEqual({ status: "staged" });
    expect(h.uploads.map((u) => u.path)).toEqual(["a.md", "b.md"]);
    h.uploads[1].d.resolve({ ok: true, body: { version: 2, docId: "doc-b", status: "staged" } });
    await h.settle();
    // One batch for both.
    expect(h.attaches).toHaveLength(1);
    expect(h.attaches[0]).toMatchObject({ docIds: ["doc-a", "doc-b"], batchId: "b1" });
    h.attaches[0].d.resolve({
      ok: true,
      result: {
        revision: 2,
        docs: [
          { docId: "doc-a", path: "a.md", status: "added" },
          { docId: "doc-b", path: "b.md", status: "replaced", replaced: "doc-0" },
        ],
      },
    });
    await h.settle();
    expect(h.last("a")).toEqual({ status: "added" });
    expect(h.last("b")).toEqual({ status: "replaced" });
    expect(h.queue.busy).toBe(false);
    // A later drop, after the first drain ended (the stale-`busy` case): it drains, as its own batch.
    h.queue.enqueue([h.file("c")]);
    await h.settle();
    expect(h.queue.busy).toBe(true);
    expect(h.uploads.map((u) => u.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(h.last("c")).toEqual({ status: "uploading" });
    h.uploads[2].d.resolve({ ok: true, body: { version: 3, docId: "doc-c", status: "staged" } });
    await h.settle();
    expect(h.attaches).toHaveLength(2);
    expect(h.attaches[1]).toMatchObject({ docIds: ["doc-c"], batchId: "b2" });
    h.attaches[1].d.resolve({ ok: true, result: { revision: 3, docs: [{ docId: "doc-c", path: "c.md", status: "added" }] } });
    await h.settle();
    expect(h.last("c")).toEqual({ status: "added" });
    expect(h.queue.busy).toBe(false);
    // Nothing is ever left at "queued" or "uploading".
    for (const [, list] of h.statuses) expect(["added", "replaced", "unchanged", "failed", "skipped"]).toContain(list.at(-1)!.status);
  });

  it("files enqueued during the batch's commit start the next batch; failures and refusals are reported per file; unchanged files skip the commit", async () => {
    const h = harness();
    h.queue.enqueue([h.file("a"), h.file("same"), h.file("bad")]);
    await h.settle();
    h.uploads[0].d.resolve({ ok: true, body: { version: 1, docId: "doc-a", status: "staged" } });
    await h.settle();
    h.uploads[1].d.resolve({ ok: true, body: { version: 1, docId: "doc-old", status: "unchanged" } });
    await h.settle();
    h.uploads[2].d.resolve({ ok: false, error: "The file is empty." });
    await h.settle();
    expect(h.last("same")).toEqual({ status: "unchanged" });
    expect(h.last("bad")).toEqual({ status: "failed", detail: "The file is empty." });
    expect(h.attaches).toHaveLength(1);
    expect(h.attaches[0].docIds).toEqual(["doc-a"]);
    // Enqueued while the commit is pending: uploaded only after it, as the next batch.
    h.queue.enqueue([h.file("d")]);
    await h.settle();
    expect(h.uploads).toHaveLength(3);
    h.attaches[0].d.resolve({ ok: true, result: { docs: [{ docId: "doc-a", path: "a.md", status: "refused", why: "The vision already has 200 documents; remove one first." }] } });
    await h.settle();
    expect(h.last("a")).toEqual({ status: "failed", detail: "The vision already has 200 documents; remove one first." });
    expect(h.uploads.map((u) => u.path)).toEqual(["a.md", "same.md", "bad.md", "d.md"]);
    h.uploads[3].d.resolve({ ok: true, body: { version: 2, docId: "doc-d", status: "staged" } });
    await h.settle();
    expect(h.attaches).toHaveLength(2);
    // A commit that fails outright marks every staged file of the batch.
    h.attaches[1].d.resolve({ ok: false, error: "The batch could not be attached." });
    await h.settle();
    expect(h.last("d")).toEqual({ status: "failed", detail: "The batch could not be attached." });
    expect(h.queue.busy).toBe(false);
    // A throwing uploader is a failure for that file, not a stuck queue.
    const throwing = new UploadQueue({
      upload: () => Promise.reject(new Error("boom")),
      attach: () => Promise.resolve({ ok: true, result: { docs: [] } }),
      onStatus: (key, status, detail) => h.statuses.set(key, [{ status, detail }]),
    });
    throwing.enqueue([h.file("t")]);
    await h.settle();
    expect(h.last("t")).toEqual({ status: "failed", detail: "boom" });
    expect(throwing.busy).toBe(false);
  });
});
