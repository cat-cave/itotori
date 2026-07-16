// The thin play entrypoint — the kept `play` (patch-play) command/route's SOLE
// path into the new pipeline's runtime launcher.
//
// It loads the exact hash-bound patch play surface through an injected loader and
// launches it through the `PatchRuntimeLauncherPort` (Utsushi's real replay
// runtime). It never touches the legacy journal reservation/finalizer or the
// context-correction worker that the old `PatchIterationService.play` dragged in
// — the loader seam is production-bound to a clean surface loader.

import type {
  PatchRuntimeLaunchReceipt,
  PatchRuntimeLauncherPort,
} from "../play/patch-runtime-launcher.js";
import type { PatchPlaySurface } from "@itotori/db";

/** Load exactly one patch version's play surface. Production binds this to the
 * clean surface loader; it never reaches the journal/finalizer path. */
export interface PlaySurfaceLoader {
  load(patchVersionId: string): Promise<PatchPlaySurface>;
}

/** The play substrate the entrypoint composes: the surface loader + the runtime
 * launcher. Both are clean of the legacy service graph. */
export interface PlayEntrypointDeps {
  readonly loader: PlaySurfaceLoader;
  readonly launcher: PatchRuntimeLauncherPort;
}

/** A kept play request — launch exactly one patch version's session. */
export interface PlayRequest {
  readonly patchVersionId: string;
  readonly launchDescriptor?: Record<string, unknown>;
}

/**
 * Launch one patch version through the new runtime launcher: load its exact
 * hash-bound play surface, then drive the real replay runtime and return the
 * observation receipt.
 */
export async function runPlaySession(
  deps: PlayEntrypointDeps,
  request: PlayRequest,
): Promise<PatchRuntimeLaunchReceipt> {
  const patch = await deps.loader.load(request.patchVersionId);
  return await deps.launcher.launch({
    patch,
    ...(request.launchDescriptor === undefined
      ? {}
      : { launchDescriptor: request.launchDescriptor }),
  });
}
