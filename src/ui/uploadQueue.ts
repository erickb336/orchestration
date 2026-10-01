// The upload queue behind the "Vision documents" list, kept out of React state so
// no drain ever reads a stale `busy`. Files enqueued while a drain runs (a folder walk that finishes
// after a drop, a second drop) join the batch being uploaded; files enqueued after a drain ended start a
// new one. Each drain uploads every queued file, one request each, then attaches the staged ones as ONE
// vision revision (`attachVisionDocs`), so an Add, a folder or a drop is one revision.

import type { AttachVisionDocsResult, VisionDocUploadOk } from "../api";

export type UploadStatus = "queued" | "uploading" | "staged" | "added" | "replaced" | "unchanged" | "failed" | "skipped";

export interface QueuedFile {
  key: string;
  path: string;
  file: Blob;
}

export interface UploadHooks {
  upload(path: string, file: Blob): Promise<{ ok: true; body: VisionDocUploadOk } | { ok: false; error: string }>;
  attach(docIds: string[], batchId: string): Promise<{ ok: true; result: AttachVisionDocsResult } | { ok: false; error: string }>;
  onStatus(key: string, status: UploadStatus, detail?: string): void;
  /** Names a batch for the revision's record; defaults to a timestamp. */
  batchId?: () => string;
}

export class UploadQueue {
  private queue: QueuedFile[] = [];
  private draining = false;
  private batches = 0;

  constructor(private readonly hooks: UploadHooks) {}

  /** Files waiting or in flight. */
  get busy(): boolean {
    return this.draining;
  }

  /** Add files and start draining unless a drain is already running (then they join it). */
  enqueue(files: QueuedFile[]) {
    this.queue.push(...files);
    void this.drain();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const staged: { key: string; docId: string }[] = [];
        while (this.queue.length) {
          const f = this.queue.shift()!;
          this.hooks.onStatus(f.key, "uploading");
          let r: Awaited<ReturnType<UploadHooks["upload"]>>;
          try {
            r = await this.hooks.upload(f.path, f.file);
          } catch (e) {
            r = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          if (!r.ok) this.hooks.onStatus(f.key, "failed", r.error);
          else if (r.body.status === "unchanged") this.hooks.onStatus(f.key, "unchanged");
          else {
            staged.push({ key: f.key, docId: r.body.docId });
            this.hooks.onStatus(f.key, "staged");
          }
        }
        if (!staged.length) continue;
        const batchId = this.hooks.batchId?.() ?? `batch-${Date.now()}-${++this.batches}`;
        let a: Awaited<ReturnType<UploadHooks["attach"]>>;
        try {
          a = await this.hooks.attach(staged.map((s) => s.docId), batchId);
        } catch (e) {
          a = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!a.ok) {
          for (const s of staged) this.hooks.onStatus(s.key, "failed", a.error);
          continue;
        }
        const rows = new Map(a.result.docs.map((d) => [d.docId, d]));
        for (const s of staged) {
          const row = rows.get(s.docId);
          if (!row) this.hooks.onStatus(s.key, "failed", "The service did not report this file.");
          else if (row.status === "refused") this.hooks.onStatus(s.key, "failed", row.why ?? "Refused.");
          else this.hooks.onStatus(s.key, row.status);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
