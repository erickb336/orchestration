// The way to the pre-flight while the project is in Vision: from Home, Vision and Settings › Project. The pre-flight is
// the one way the factory starts (Preflight.tsx).

import * as M from "../../domain/model";
import { ButtonLink, type ButtonVariant } from "../kit";
import { useStore } from "../store";
import { PREFLIGHT_HASH } from "./preflightView";
import "./preflight.css";

/** "Start the factory…", to the pre-flight. An empty vision says why it cannot start yet. Nothing once the factory runs. */
export function StartFactoryLink({ variant = "primary", size }: { variant?: ButtonVariant; size?: "small" }) {
  const { state } = useStore();
  if (state.project.stage !== "shaping") return null;
  const why = M.startFactoryBlocker(state);
  return (
    <div className="pf-link">
      <ButtonLink variant={variant} size={size} href={PREFLIGHT_HASH}>
        Start the factory…
      </ButtonLink>
      {why && <p className="small muted no-margin">{why}</p>}
    </div>
  );
}
