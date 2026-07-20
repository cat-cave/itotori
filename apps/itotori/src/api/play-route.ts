// The kept API patch-play mutation's SOLE path into the new pipeline's runtime
// launcher.
//
// It drives a `PlayRequest` through the composition-root `runPlaySession`, which
// loads the hash-bound play surface and launches Utsushi's real replay runtime. It
// never touches the legacy `PatchIterationService.play` journal reservation/
// finalizer path the old handler dragged in. The play substrate (surface loader +
// runtime launcher) is injected so this module's own import closure reaches only
// the play entrypoint + its launcher port.

import {
  runPlaySession,
  type PlayEntrypointDeps,
  type PlayRequest,
} from "../composition/play-entrypoint.js";
import type { PatchRuntimeLaunchReceipt } from "../play/patch-runtime-launcher.js";

/** The injected play substrate — the surface loader + runtime launcher enter
 * through this ONE seam. Production binds the clean surface loader + real launcher;
 * a proof binds doubles. */
export interface PlayRouteDeps {
  resolvePlayDeps(): PlayEntrypointDeps | Promise<PlayEntrypointDeps>;
}

/** Drive one API patch-play mutation through the new runtime launcher. */
export async function runApiPlay(
  request: PlayRequest,
  deps: PlayRouteDeps,
): Promise<PatchRuntimeLaunchReceipt> {
  const playDeps = await deps.resolvePlayDeps();
  return await runPlaySession(playDeps, request);
}
