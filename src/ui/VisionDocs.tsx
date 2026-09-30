// ORC-014: the "Vision documents" list shown under the vision (Overview) and in the shaping panel:
// Add files, Add folder (relative paths kept), drag-and-drop, one upload request per file with its own
// status and reason, Remove with confirmation, and each document's size and whether it is readable.
// The service keeps copies in its own directory; nothing is written into a repository.

import { useRef, useState } from "react";
import * as M from "../domain/model";
import type { State, VisionDoc, VisionRevision } from "../domain/types";
import { useStore } from "./store";

type UploadStatus = "queued" | "uploading" | "added" | "replaced" | "failed" | "skipped";
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

const STATUS_LABEL: Record<UploadStatus, string> = { queued: "Waiting", uploading: "Uploading…", added: "Added", replaced: "Added (replaced the earlier copy)", failed: "Not added", skipped: "Skipped" };

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
export function VisionDocsList({ compact = false }: { compact?: boolean }) {
  const { state, send, disabled, uploadVisionDoc } = useStore();
  const docs = M.currentVisionDocs(state);
  const total = M.visionDocsBytes(docs);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<Picked[]>([]);
  const office = docs.filter((d) => M.isOfficeDoc(d));
  const unreadable = docs.filter((d) => !d.text);

  const patch = (key: string, p: Partial<Upload>) => setUploads((xs) => xs.map((u) => (u.key === key ? { ...u, ...p } : u)));

  /** Upload one file after another; each has its own request, key, status and reason. */
  const drain = async () => {
    if (busy) return;
    setBusy(true);
    while (queueRef.current.length) {
      const { file, path, key } = queueRef.current.shift()! as Picked & { key: string };
      patch(key, { status: "uploading" });
      const r = await uploadVisionDoc(path, file);
      if (r.ok) patch(key, { status: r.body.replaced ? "replaced" : "added" });
      else patch(key, { status: "failed", detail: r.error });
    }
    setBusy(false);
  };

  const enqueue = (picked: Picked[]) => {
    const next: Upload[] = [];
    let n = uploads.length;
    for (const p of picked) {
      const key = `u-${Date.now()}-${n++}`;
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
      queueRef.current.push({ ...p, path, key } as Picked & { key: string });
    }
    setUploads((xs) => [...xs, ...next]);
    void drain();
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
    if (!confirm(`Remove ${d.path} from the vision?\n\nThe lead stops seeing it. Earlier vision revisions keep it in their history.`)) return;
    setRemoving(d.id);
    await send("removeVisionDoc", { docId: d.id });
    setRemoving(null);
  };

  const done = uploads.filter((u) => u.status !== "queued" && u.status !== "uploading");
  const added = uploads.filter((u) => u.status === "added" || u.status === "replaced").length;
  const failed = uploads.filter((u) => u.status === "failed").length;
  const inFlight = uploads.length - done.length;

  return (
    <div className="vision-docs" style={{ marginTop: compact ? "0.6rem" : "0.8rem" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Vision documents ({docs.length})</h3>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          {M.fmtBytes(total)} of {M.fmtBytes(M.MAX_VISION_DOCS_BYTES)} · up to {M.MAX_VISION_DOCS} files, {M.fmtBytes(M.MAX_VISION_DOC_BYTES)} each
        </span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.5rem" }}>
        Files the lead reads whenever it plans, answers or drafts the vision; designers read them too, and other roles see the list. Copies are kept by the service, outside your repository; attach a file again to update it.
      </p>
      <div
        className={`dropzone${over ? " over" : ""}`}
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
        <div className="row">
          <button type="button" className="small" disabled={disabled} onClick={() => filesRef.current?.click()}>
            Add files
          </button>
          <button type="button" className="small" disabled={disabled} onClick={() => folderRef.current?.click()}>
            Add folder
          </button>
          <span className="muted" style={{ fontSize: "0.82rem" }}>
            or drop files or a folder here. A folder keeps its relative paths.
          </span>
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
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0.5rem 0" }}>
          None attached.
        </p>
      ) : (
        <ul className="plain doc-list" aria-label="Vision documents">
          {docs.map((d) => (
            <li key={d.id}>
              <span className="mono" title={d.path}>
                {d.path}
              </span>
              <span className="muted">{M.fmtBytes(d.size)}</span>
              <span className={d.text ? "chip" : "chip strong"} title={d.text ? "Its text goes to the lead and designers." : "Only its name reaches the lead."}>
                {d.text ? "text" : "not readable as text"}
              </span>
              <button type="button" className="small" disabled={disabled || removing === d.id} onClick={() => void remove(d)} aria-label={`Remove ${d.path}`}>
                {removing === d.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {office.length > 0 && (
        <p className="muted" style={{ fontSize: "0.82rem", margin: "0.3rem 0" }}>
          PDF and Word text is not read yet: {office.map((d) => d.name).join(", ")} {office.length === 1 ? "is" : "are"} listed by name only. Attach the text as Markdown or plain text for the lead to read it.
        </p>
      )}
      {unreadable.length > office.length && (
        <p className="muted" style={{ fontSize: "0.82rem", margin: "0.3rem 0" }}>
          A document that is not readable as text (an image, an archive, a file that is not UTF-8) is kept and listed; the lead sees its name only.
        </p>
      )}

      {uploads.length > 0 && (
        <div style={{ marginTop: "0.5rem" }} aria-live="polite">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: "0.85rem" }}>
              {inFlight ? `Uploading ${done.length + 1} of ${uploads.length}…` : `${added} added${failed ? `, ${failed} not added` : ""}${uploads.length - added - failed ? `, ${uploads.length - added - failed} skipped` : ""}.`}
            </span>
            {!inFlight && (
              <button type="button" className="link" style={{ fontSize: "0.82rem" }} onClick={() => setUploads([])}>
                Clear
              </button>
            )}
          </div>
          <ul className="plain doc-list uploads" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.key} className={u.status}>
                <span className="mono" title={u.path}>
                  {u.path}
                </span>
                <span className="muted">{M.fmtBytes(u.size)}</span>
                <span className={u.status === "failed" ? "chip danger" : "chip"}>{STATUS_LABEL[u.status]}</span>
                {u.detail && <span className="muted" style={{ fontSize: "0.82rem" }}>{u.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
