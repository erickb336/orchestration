// The task page (ORC-025 pass 3). Top to bottom: the header (title, state, Pause or Resume, Message the lead,
// More), what stands in the way, what the task needs from you (once), what it is for, its steps, its result,
// and Details: the spec and options, outputs, runs, activity, revisions and models.
// The parts live in src/ui/task/; this file only composes them.

import { useState } from "react";
import { ButtonLink, Card, EmptyState } from "./kit";
import { SpecEditor } from "./SpecEditor";
import { useStore } from "./store";
import { StatusBanners } from "./task/Banners";
import { ChildTasksCard } from "./task/Children";
import { DETAILS_ID, DetailsCard, type DetailsSectionId } from "./task/Details";
import { TaskHeader } from "./task/Header";
import { NEEDS_YOU_ID, NeedsYouCard } from "./task/NeedsYou";
import { needsYouItems } from "./task/needsYouItems";
import { PurposeCard } from "./task/Purpose";
import { ResultCard } from "./task/Result";
import { StepsCard } from "./task/Steps";
import "./task/task.css";

const CLOSED: Record<DetailsSectionId, boolean> = { spec: false, outputs: false, runs: false, activity: false, revisions: false, models: false };

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

export function TaskDetail({ id }: { id: string }) {
  const { state } = useStore();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<Record<DetailsSectionId, boolean>>(CLOSED);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) {
    return (
      <Card>
        <EmptyState title={`No task ${id}.`} action={<ButtonLink href="#/tasks">Back to tasks</ButtonLink>}>
          It may have been removed with its project, or the address is wrong.
        </EmptyState>
      </Card>
    );
  }
  const items = needsYouItems(state, task, Date.now());
  const chooseAtTop = items.some((i) => i.kind === "choose");
  const prAtTop = items.some((i) => i.kind === "pr");
  const openSection = (section: DetailsSectionId) => {
    setOpen((o) => ({ ...o, [section]: true }));
    window.requestAnimationFrame(() => scrollTo(DETAILS_ID));
  };
  return (
    <div className="t-page">
      <TaskHeader state={state} task={task} editing={editing} onEdit={() => setEditing(true)} />
      <StatusBanners state={state} task={task} onEdit={editing ? undefined : () => setEditing(true)} />
      {editing ? (
        <SpecEditor key={task.id} task={task} onClose={() => setEditing(false)} />
      ) : (
        <>
          <NeedsYouCard state={state} task={task} items={items} onCompare={() => openSection("spec")} />
          <div className="t-grid">
            <PurposeCard task={task} />
            <StepsCard state={state} task={task} />
          </div>
          <ChildTasksCard state={state} task={task} />
          <ResultCard state={state} task={task} prAtTop={prAtTop} />
          <DetailsCard state={state} task={task} open={open} onToggle={(section, isOpen) => setOpen((o) => ({ ...o, [section]: isOpen }))} chooseAtTop={chooseAtTop} decideAbove={() => scrollTo(NEEDS_YOU_ID)} onEdit={() => setEditing(true)} />
        </>
      )}
    </div>
  );
}
