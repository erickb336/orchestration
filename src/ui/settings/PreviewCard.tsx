// Settings › Project › Preview for evidence (ORC-029 pass 5): how the service runs the built product to capture
// evidence beside the design. The fields edit the Project section's draft; Save sends setPreview, the owner's command.
// The domain's refusal shows under the fields before Save, in its own words.

import { previewWords } from "../../domain/studio/evidence";
import { Banner, Field, Input, StatePill } from "../kit";
import { useStore } from "../store";
import { SettingsCard } from "./parts";
import { previewProblem, type PreviewDraft } from "./preview";

export function PreviewCard({ v, set }: { v: PreviewDraft; set: (p: Partial<PreviewDraft>) => void }) {
  const { state } = useStore();
  const live = state.project.preview;
  const problem = previewProblem(v);
  return (
    <SettingsCard
      id="preview"
      title="Preview for evidence"
      help="The service runs your built product to show each screen and each CLI demo beside its design. It runs in the recorder's container on a copy of the change: the install with the network, then everything else with no network."
    >
      <div className="s-status">
        <StatePill tone={live ? "done" : "neutral"}>{live ? `Set up (r${live.rev})` : "Not set up"}</StatePill>
        <span className="muted">{live ? previewWords(live) : 'Capture runs record "not set up", and nothing runs.'}</span>
      </div>
      <div className="s-fields s-fields--wide">
        <Field label="Install command" hint='A download by npm, pnpm or yarn, with install scripts off. The only step with the network. Empty: no install.'>
          <Input type="text" className="s-mono" value={v.previewInstall} placeholder="npm ci --ignore-scripts" onChange={(e) => set({ previewInstall: e.target.value })} />
        </Field>
        <Field label="Preview command" hint="What serves the built screens. Empty for a product with no screens.">
          <Input type="text" className="s-mono" value={v.previewCommand} placeholder="npm run preview" onChange={(e) => set({ previewCommand: e.target.value })} />
        </Field>
        <Field label="Port" hint="The port the preview serves on, from 1024 to 65535.">
          <Input type="text" inputMode="numeric" className="s-mono" value={v.previewPort} placeholder="4173" onChange={(e) => set({ previewPort: e.target.value })} />
        </Field>
        <Field label="CLI entry" hint="The CLI's entry file in the repository. The demo's tape runs it with node. Empty for a product with no CLI.">
          <Input type="text" className="s-mono" value={v.previewCli} placeholder="bin/trips.js" onChange={(e) => set({ previewCli: e.target.value })} />
        </Field>
      </div>
      <p className="s-note">Commands are lists of arguments, never a shell line: quote an argument with a space. Empty the preview command, the port and the CLI entry to turn capture off.</p>
      {problem && (
        <Banner tone="fail" className="s-gap">
          {problem}
        </Banner>
      )}
    </SettingsCard>
  );
}
