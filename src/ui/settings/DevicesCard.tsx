// Settings › Project › Devices (ORC-029 pass 6): the device scope the studio designs for. The checkboxes edit the
// Project section's draft; Save sends setDevices. The words are in budgets.ts.

import type { Device } from "../../domain/types";
import { Checkbox } from "../kit";
import { DEVICE_CHOICES, devicesProblem, toggleDevice } from "./budgets";
import { SettingsCard } from "./parts";

export function DevicesCard({ devices, set }: { devices: Device[]; set: (devices: Device[]) => void }) {
  const problem = devicesProblem(devices);
  return (
    <SettingsCard id="devices" title="Devices" help="The studio designs for these devices, and evidence shows the built product on them. A change applies to the next designs; the factory builds the devices each blueprint item names.">
      <fieldset className="s-choices">
        <legend className="sr-only">Devices</legend>
        {DEVICE_CHOICES.map((c) => (
          <Checkbox key={c.value} label={c.label} hint={c.hint} checked={devices.includes(c.value)} onChange={() => set(toggleDevice(devices, c.value))} />
        ))}
      </fieldset>
      {problem && (
        <p className="s-error" role="alert">
          {problem}
        </p>
      )}
    </SettingsCard>
  );
}
