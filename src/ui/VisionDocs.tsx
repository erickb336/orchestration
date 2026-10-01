// The "Vision documents" list, shown under the vision (Home's Focus card) and in the shaping panel: Add files,
// Add folder (relative paths kept), drag-and-drop, one upload request per file with its own status and reason,
// Remove with confirmation, and each document's size and whether it is readable. The service keeps copies in its
// own directory; nothing is written into a repository. Every file of one Add, folder or drop is attached as one
// vision revision. The queue lives in a ref (`UploadQueue`), so a folder walk that finishes late still drains.

import { useRef, useState } from "react";
import type { AttachVisionDocsResult } from "../api";
import * as M from "../domain/model";
import type { State, VisionDoc, VisionRevision } from "../domain/types";
import { Button, Chip, Disclosure, useConfirm } from "./kit";
import { useStore } from "./store";
import { UploadQueue, type UploadStatus } from "./uploadQueue";
import "./vision.css";

interface Upload {
  key: string;
  path: string;
  size: number;
  status: UploadStatus;
  detail?: string;
}
interface Picked {
  file: File;
  path: string;
  /** From a folder pick or a dropped folder: hidden entries (a segment starting with ".") are skipped. */
  fromFolder: boolean;
}

const STATUS_LABEL: Record<UploadStatus, string> = {
  queued: "Waiting",
  uploading: "Uploading…",
  staged: "Uploaded; attaching with the batch…",
  added: "Added",
  replaced: "Added (replaced the earlier copy)",
  unchanged: "Unchanged (already attached)",
  failed: "Not added",
  skipped: "Skipped",
};
const SETTLED = new Set<UploadStatus>(["added", "replaced", "unchanged", "failed", "skipped"]);

/** A dropped folder, walked with the File System entry API; a dropped file as itself. */
async function entriesOf(items: DataTransferItemList): Promise<Picked[]> {
  const out: Picked[] = [];
  const walk = (entry: FileSystemEntry, fromFolder: boolean): Promise<void> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file(
          (file) => {
            out.push({ file, path: entry.fullPath.replace(/^\/+/, ""), fromFolder });
            resolve();
          },
          () => resolve(),
        );
        return;
      }
      if (!entry.isDirectory) return resolve();
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const batch = () =>
        reader.readEntries(
          async (entries) => {
            if (!entries.length) return resolve();
            for (const e of entries) await walk(e, true);
            batch(); // readEntries returns at most one batch per call
          },
          () => resolve(),
        );
      batch();
    });
  const entries: { entry: FileSystemEntry | null; file: File | null }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "file") continue;
    entries.push({ entry: typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null, file: it.getAsFile() });
  }
  for (const { entry, file } of entries) {
    if (entry) await walk(entry, entry.isDirectory);
    else if (file) out.push({ file, path: file.name, fromFolder: false });
  }
  return out;
}

const isHidden = (path: string) => path.split("/").some((seg) => seg.startsWith("."));

/** The list of documents, the uploader, and this session's upload results. */
export function VisionDocsList() {
  const { state, send, disabled, uploadVisionDoc } = useStore();
  const confirm = useConfirm();
  const docs = M.currentVisionDocs(state);
  const total = M.visionDocsBytes(docs);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const office = docs.filter((d) => M.isOfficeDoc(d));
  const unreadable = docs.filter((d) => !d.text);

  const patch = (key: string, p: Partial<Upload>) => setUploads((xs) => xs.map((u) => (u.key === key ? { ...u, ...p } : u)));

  // The queue and its hooks live in refs: the hooks always call this render's store functions, and the
  // queue never reads a `busy` captured by an earlier render.
  const hooksRef = useRef({ uploadVisionDoc, send });
  hooksRef.current = { uploadVisionDoc, send };
  const seqRef = useRef(0);
  const queueRef = useRef<UploadQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new UploadQueue({
      upload: (path, file) => hooksRef.current.uploadVisionDoc(path, file),
      attach: async (docIds, batchId) => {
        const r = await hooksRef.current.send("attachVisionDocs", { docIds, batchId });
        return r.ok ? { ok: true, result: r.result as AttachVisionDocsResult } : { ok: false, error: "The batch could not be attached (see the notice above). Add the files again." };
      },
      onStatus: (key, status, detail) => patch(key, { status, ...(detail !== undefined ? { detail } : {}) }),
    });
  }

  const enqueue = (picked: Picked[]) => {
    const next: Upload[] = [];
    const files: { key: string; path: string; file: Blob }[] = [];
    for (const p of picked) {
      const key = `u-${++seqRef.current}`;
      const path = p.path.replace(/\\/g, "/");
      if (p.fromFolder && isHidden(path)) {
        next.push({ key, path, size: p.file.size, status: "skipped", detail: "hidden file or folder" });
        continue;
      }
      if (p.file.size === 0) {
        next.push({ key, path, size: 0, status: "failed", detail: "The file is empty." });
        continue;
      }
      if (p.file.size > M.MAX_VISION_DOC_BYTES) {
        next.push({ key, path, size: p.file.size, status: "failed", detail: `The file is ${M.fmtBytes(p.file.size)}; the limit is ${M.fmtBytes(M.MAX_VISION_DOC_BYTES)} per file.` });
        continue;
      }
      next.push({ key, path, size: p.file.size, status: "queued" });
      files.push({ key, path, file: p.file });
    }
    setUploads((xs) => [...xs, ...next]);
    if (files.length) queueRef.current!.enqueue(files);
  };

  const pickFiles = (list: FileList | null, fromFolder: boolean) => {
    if (!list) return;
    const picked: Picked[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      picked.push({ file: f, path: (fromFolder && f.webkitRelativePath) || f.name, fromFolder });
    }
    enqueue(picked);
  };

  const remove = async (d: VisionDoc) => {
    const ok = await confirm({
      title: `Remove ${d.path} from the vision?`,
      text: "The lead stops seeing it. Earlier vision revisions keep it in their history, and its copy stays on disk for them.",
      primaryLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemoving(d.id);
    await send("removeVisionDoc", { docId: d.id });
    setRemoving(null);
  };

  const done = uploads.filter((u) => SETTLED.has(u.status));
  const added = uploads.filter((u) => u.status === "added" || u.status === "replaced").length;
  const unchanged = uploads.filter((u) => u.status === "unchanged").length;
  const failed = uploads.filter((u) => u.status === "failed").length;
  const skipped = uploads.filter((u) => u.status === "skipped").length;
  const inFlight = uploads.length - done.length;
  const uploading = uploads.filter((u) => u.status === "queued" || u.status === "uploading").length;
  const progress = uploading ? `Uploading ${uploads.length - uploading + 1} of ${uploads.length}…` : `Attaching ${inFlight} file${inFlight === 1 ? "" : "s"} as one revision…`;
  const summary = [`${added} added`, unchanged ? `${unchanged} unchanged` : "", failed ? `${failed} not added` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(", ");

  return (
    <section className="v-docs" aria-label="Vision documents">
      <div className="v-docs__head">
        <h3>Vision documents ({docs.length})</h3>
        <span className="small muted">
          {M.fmtBytes(total)} of {M.fmtBytes(M.MAX_VISION_DOCS_BYTES)} · up to {M.MAX_VISION_DOCS} files, {M.fmtBytes(M.MAX_VISION_DOC_BYTES)} each
        </span>
      </div>
      <p className="small muted">Files the lead reads whenever it plans, answers or drafts the vision; designers read them too, and other roles see the list.</p>
      <Disclosure label="How this works">
        <p className="small muted">Copies are kept by the service, outside your repository; attach a file again to update it. Each Add, folder or drop becomes one vision revision.</p>
      </Disclosure>
      <div
        className={`v-dropzone${over ? " v-dropzone--over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (disabled) return;
          void entriesOf(e.dataTransfer.items).then(enqueue);
        }}
      >
        <div className="k-actions">
          <Button size="small" disabled={disabled} onClick={() => filesRef.current?.click()}>
            Add files
          </Button>
          <Button size="small" disabled={disabled} onClick={() => folderRef.current?.click()}>
            Add folder
          </Button>
          <span className="small muted">or drop files or a folder here. A folder keeps its relative paths.</span>
        </div>
        <input
          ref={filesRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Add files to the vision"
          onChange={(e) => {
            pickFiles(e.target.files, false);
            e.target.value = "";
          }}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is a non-standard attribute every current browser honours
          webkitdirectory=""
          className="sr-only"
          aria-label="Add a folder to the vision"
          onChange={(e) => {
            pickFiles(e.target.files, true);
            e.target.value = "";
          }}
        />
      </div>

      {docs.length === 0 ? (
        <p className="small muted">None attached.</p>
      ) : (
        <ul className="v-doc-list" aria-label="Vision documents">
          {docs.map((d) => (
            <li key={d.id}>
              <span className="mono" title={d.path}>
                {d.path}
              </span>
              <span className="muted">{M.fmtBytes(d.size)}</span>
              <Chip strong={!d.text} title={d.text ? "Its text goes to the lead and designers." : "Only its name reaches the lead."}>
                {d.text ? "text" : "not readable as text"}
              </Chip>
              <Button size="small" variant="quiet" disabled={disabled || removing === d.id} loading={removing === d.id} onClick={() => void remove(d)} aria-label={`Remove ${d.path}`}>
                {removing === d.id ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {office.length > 0 && (
        <p className="small muted">
          PDF and Word text is not read yet: {office.map((d) => d.name).join(", ")} {office.length === 1 ? "is" : "are"} listed by name only. Attach the text as Markdown or plain text for the lead to read it.
        </p>
      )}
      {unreadable.length > office.length && <p className="small muted">A document that is not readable as text (an image, an archive, a file that is not UTF-8) is kept and listed; the lead sees its name only.</p>}

      {uploads.length > 0 && (
        <div className="v-uploads" aria-live="polite">
          <div className="v-docs__head">
            <span className="meta">{inFlight ? progress : `${summary}.`}</span>
            {!inFlight && (
              <Button size="small" variant="quiet" onClick={() => setUploads([])}>
                Clear
              </Button>
            )}
          </div>
          <ul className="v-doc-list v-doc-list--uploads" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.key} className={u.status}>
                <span className="mono" title={u.path}>
                  {u.path}
                </span>
                <span className="muted">{M.fmtBytes(u.size)}</span>
                <Chip tone={u.status === "failed" ? "fail" : "neutral"}>{STATUS_LABEL[u.status]}</Chip>
                {u.detail && <span className="small muted">{u.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The documents a vision revision had, for the history: names, with the full paths on hover. */
export function RevisionDocs({ state, rev }: { state: State; rev: VisionRevision }) {
  const docs = M.visionDocsOf(state, rev);
  if (!docs.length) return <span className="muted">· no documents</span>;
  const shown = docs.slice(0, 3).map((d) => d.name);
  const more = docs.length - shown.length;
  return (
    <span className="muted" title={docs.map((d) => `${d.path} (${M.fmtBytes(d.size)})`).join("\n")}>
      · {docs.length} document{docs.length === 1 ? "" : "s"}: {shown.join(", ")}
      {more > 0 ? ` and ${more} more` : ""}
    </span>
  );
}
