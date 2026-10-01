// The task page's and the change list's words for notes to a running step: the status chip, the source, the target
// with role and provider, and when "Send a note" is offered.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import type { Note } from "../domain/types";
import { fmtTime } from "./common";
import { canSendNote, noteRowLabel, noteSourceLabel, noteStatusLabel, noteTargetLabel, noteTone } from "./notes";
import { describeChange } from "./steering";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const base: Note = { id: "note-1", taskId: "EX-001", stepId: "S2", text: "Skip the README.", from: { by: "user" }, at: new Date(T0).toISOString(), status: "queued" };

describe("note labels", () => {
  it("the status chip reads Queued, Sending, Delivered, Delivered when the run started, or Not delivered with the reason, in the matching tone", () => {
    expect(noteStatusLabel(base)).toBe("Queued");
    expect(noteStatusLabel({ ...base, status: "sending" })).toBe("Sending");
    expect(noteStatusLabel({ ...base, status: "delivered", via: "live" })).toBe("Delivered");
    expect(noteStatusLabel({ ...base, status: "delivered", via: "start" })).toBe("Delivered when the run started");
    expect(noteStatusLabel({ ...base, status: "not-delivered", reason: "S2 had finished" })).toBe("Not delivered: S2 had finished");
    expect(noteStatusLabel({ ...base, status: "not-delivered" })).toBe("Not delivered: no reason recorded");
    expect(noteTone(base)).toBe("neutral");
    expect(noteTone({ status: "sending" })).toBe("work");
    expect(noteTone({ status: "delivered" })).toBe("done");
    expect(noteTone({ status: "not-delivered" })).toBe("fail");
  });

  it("the source reads 'from you' or 'from the lead, for your message of <time>', never a message id", () => {
    const at = new Date(T0 - 60_000).toISOString();
    const s = { conversation: [{ id: "msg-3", at, author: "user" as const, text: "Tell the coder to skip the README." }] };
    const lead = (messageIds: string[]) => ({ from: { by: "lead" as const, leadRunId: "lead-1", changeSetId: "cs-lead-1", changeId: "cs-lead-1.1", messageIds } });
    expect(noteSourceLabel(s, base)).toBe("from you");
    expect(noteSourceLabel(s, lead(["msg-3"]))).toBe(`from the lead, for your message of ${fmtTime(at)}`);
    expect(noteSourceLabel(s, lead(["msg-3", "msg-4"]))).toBe(`from the lead, for your 2 messages from ${fmtTime(at)}`);
    // A message pruned from the conversation still reads as yours, without a time.
    expect(noteSourceLabel(s, lead(["msg-9"]))).toBe("from the lead, for your message");
    expect(noteSourceLabel(s, lead([]))).toBe("from the lead");
    for (const ids of [["msg-3"], ["msg-3", "msg-4"], ["msg-9"]]) expect(noteSourceLabel(s, lead(ids))).not.toMatch(/msg-/);
  });

  it("the target names the task, step, role and the provider that runs it; a row reads 'Note to WT-007 S2 (Coder · Claude): \"…\"'", () => {
    const s = buildSeed(T0);
    expect(noteTargetLabel(s, "EX-001", "S2")).toBe("EX-001 S2 (Coder · Codex)"); // the running coder's provider
    expect(noteTargetLabel(s, "EX-001", "S1")).toBe("EX-001 S1 (Designer · Claude)"); // the finished designer's
    expect(noteTargetLabel(s, "EX-003", "S1")).toBe("EX-003 S1 (Coder · Codex)"); // not started: the resolved default
    expect(noteTargetLabel(s, "EX-002", "C1")).toBe("EX-002 C1 (Checks · Service)");
    expect(noteTargetLabel(s, "nope", "S1")).toBe("nope S1");
    expect(noteTargetLabel(s, undefined, undefined)).toBe("? ?");
    expect(noteRowLabel(s, { taskId: "EX-001", stepId: "S2", after: "Skip the README." })).toBe('Note to EX-001 S2 (Coder · Codex): "Skip the README."');
    expect(describeChange({ id: "x", kind: "note", taskId: "EX-001", stepId: "S2", before: null, after: "Skip it.", why: "", status: "applied" })).toBe('Note to EX-001 S2: "Skip it."');
  });

  it("Send a note is offered on a running agent step of an open task, never on a Checks step, a step that is not running, or a finished task", () => {
    const s = buildSeed(T0);
    const ex1 = s.tasks.find((t) => t.id === "EX-001")!;
    expect(canSendNote(s, ex1, "S2")).toBe(true);
    expect(canSendNote(s, ex1, "S1")).toBe(false); // done
    expect(canSendNote(s, ex1, "C1")).toBe(false);
    const ex2 = s.tasks.find((t) => t.id === "EX-002")!;
    expect(canSendNote(s, ex2, "S2")).toBe(true); // your note may go to a reviewer
    const paused = M.pauseTask(s, "EX-001", new Date(T0).toISOString());
    expect(canSendNote(paused, paused.tasks.find((t) => t.id === "EX-001")!, "S2")).toBe(false); // stopping: the service queues, the control hides
    const done = s.tasks.find((t) => t.id === "EX-006")!;
    expect(canSendNote(s, done, "S1")).toBe(false);
  });
});
