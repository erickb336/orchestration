// The PE's open cases on the artifact shown, under PE review (ORC-029 pass 4, convergence): product questions the PE
// noticed (a missing feature, an undecided case, a rule nobody set). They are the owner's to decide, through the lead;
// they never went to the designer, so this block says nothing of revisions. Its own component, so that PE review's
// wording (Studio.tsx, studioView.ts) can change around it.

import * as S from "../../domain/studio/studio";
import type { StudioArtifact } from "../../domain/studio/types";
import { useStore } from "../store";

/** "Questions for you": the open cases the PE raised on this artifact in its round, up to the version shown; nothing when there are none. */
export function PeQuestions({ artifact: a }: { artifact: StudioArtifact }) {
  const { state } = useStore();
  const cases = S.openCasesOf(state, a);
  if (!cases.length) return null;
  const variant = (id: string | undefined) => (id === undefined ? undefined : (a.variants.find((v) => v.id === id)?.label ?? id));
  return (
    <div className="k-stack k-stack--tight">
      <h3 className="st-label">Questions for you</h3>
      <p className="small muted">The PE noticed these about the product. They are yours to decide. The lead asks you about them.</p>
      <ul className="st-verdicts" aria-label="Questions for you">
        {cases.map((c, i) => (
          <li key={`${c.version}-${c.pass}-${i}`} className="st-verdict">
            <p className="small">{c.text}</p>
            {c.why && <p className="small muted">{c.why}</p>}
            <p className="micro muted">{[variant(c.variant), `PE pass ${c.pass}`].filter(Boolean).join(" · ")}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
