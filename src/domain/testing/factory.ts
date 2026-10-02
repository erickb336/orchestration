// Test helper (pure): the owner's Start the factory, as a test performs it. Not used by the application, where only
// the command table calls `startFactory`, on the owner's command.

import * as M from "../model";
import type { FactorySettings, State } from "../types";

/** What the owner sends to start the factory: the current revision, every open area confirmed, and the settings as they stand unless given. */
export function startFactoryArgs(s: State, settings: Partial<FactorySettings> = {}): M.FactoryRequest {
  const request = M.startFactoryRequest(s);
  return { ...request, settings: { ...request.settings, ...settings } };
}

/** Start the factory as the owner would (see `startFactoryArgs`). */
export function startFactoryAsOwner(s: State, now: string, settings: Partial<FactorySettings> = {}): State {
  return M.startFactory(s, startFactoryArgs(s, settings), now);
}
