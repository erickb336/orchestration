// Settings: seven sections with a side menu, so no section is a long scroll.
//   Working style · Project · Budgets · How your project runs · Agents · Quality · Advanced
// Each section has its address (#/settings/<section>, #/settings opens the first) and its own draft with one Save.
// All seven stay mounted while you switch, so an unsaved change in one survives a visit to another; the menu
// marks a section that has one, and the browser asks before the page is closed with one.

import { useCallback, useEffect, useState } from "react";
import { SideNav, SideNavLayout } from "./kit";
import { AdvancedSection } from "./settings/Advanced";
import { AgentsSection } from "./settings/Agents";
import { BudgetsSection } from "./settings/BudgetsSection";
import { ProjectSection } from "./settings/Project";
import { QualitySection } from "./settings/Quality";
import { RunsSection } from "./settings/Runs";
import { WorkingStyleSection } from "./settings/WorkingStyle";
import { SECTIONS, parseSettingsHash, settingsHref, type SectionId } from "./settings/sections";
import "./settings/settings.css";

export function Settings() {
  const [where, setWhere] = useState(() => parseSettingsHash(typeof location === "undefined" ? "" : location.hash));
  const [dirty, setDirty] = useState<Partial<Record<SectionId, boolean>>>({});

  useEffect(() => {
    const go = () => {
      const next = parseSettingsHash(location.hash);
      setWhere((prev) => {
        // A new section starts at its top; a card link scrolls to the card once the section shows.
        if (prev.section !== next.section && !next.card) window.scrollTo({ top: 0 });
        return next;
      });
    };
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  useEffect(() => {
    if (where.card) document.getElementById(where.card)?.scrollIntoView({ block: "start" });
  }, [where]);

  const onDirty = useCallback((id: SectionId, d: boolean) => setDirty((x) => (!!x[id] === d ? x : { ...x, [id]: d })), []);
  const anyDirty = Object.values(dirty).some(Boolean);
  // Closing or reloading the page with an unsaved change asks first (the browser's own prompt).
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const on = (id: SectionId) => where.section === id;
  return (
    <div className="s-page">
      <h1>Settings</h1>
      <SideNavLayout
        className="s-layout"
        nav={
          <SideNav
            label="Settings sections"
            current={where.section}
            items={SECTIONS.map((s) => ({
              id: s.id,
              href: settingsHref(s.id),
              label: dirty[s.id] ? (
                <>
                  {s.label}
                  <span className="s-nav-dirty" aria-hidden="true" />
                  <span className="sr-only"> (unsaved changes)</span>
                </>
              ) : (
                s.label
              ),
            }))}
          />
        }
      >
        <WorkingStyleSection current={on("working-style")} onDirty={onDirty} />
        <ProjectSection current={on("project")} onDirty={onDirty} />
        <BudgetsSection current={on("budgets")} onDirty={onDirty} />
        <RunsSection current={on("how-it-runs")} onDirty={onDirty} />
        <AgentsSection current={on("agents")} onDirty={onDirty} />
        <QualitySection current={on("quality")} onDirty={onDirty} />
        <AdvancedSection current={on("advanced")} onDirty={onDirty} />
      </SideNavLayout>
    </div>
  );
}
