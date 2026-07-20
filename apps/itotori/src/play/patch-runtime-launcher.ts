// Patch-play runtime launcher facade.
//
// The facade owns no engine behavior. It builds the registered adapter
// registry and delegates every engine-specific concern to the selected adapter.

import { realliveRuntimeLauncherAdapterFactory } from "./reallive-runtime-launcher-adapter.js";
import {
  RuntimeLauncherRegistry,
  type RuntimeLaunchRequest,
  type RuntimePatchSurface,
  type RuntimeLauncherDeps,
} from "./runtime-launcher-registry.js";

export {
  PatchRuntimeLaunchError,
  type PatchRuntimeLaunchErrorCode,
  type PatchRuntimeLaunchReceipt,
  type RuntimeLaunchRequest,
  type RuntimePatchSurface,
} from "./runtime-launcher-registry.js";

export type PatchRuntimeLauncherPort = {
  launch(input: {
    patch: RuntimePatchSurface;
    request: RuntimeLaunchRequest;
  }): Promise<import("./runtime-launcher-registry.js").PatchRuntimeLaunchReceipt>;
};

/** Compatibility name for composition roots that construct the Utsushi launcher. */
export type UtsushiPatchRuntimeLauncherDeps = RuntimeLauncherDeps;

export class UtsushiPatchRuntimeLauncher implements PatchRuntimeLauncherPort {
  private readonly registry: RuntimeLauncherRegistry;

  constructor(deps: UtsushiPatchRuntimeLauncherDeps = {}) {
    this.registry = new RuntimeLauncherRegistry([realliveRuntimeLauncherAdapterFactory], deps);
  }

  async launch(input: { patch: RuntimePatchSurface; request: RuntimeLaunchRequest }) {
    return await this.registry.launch(input);
  }
}

/** Build the registered runtime adapter registry for non-patch CLI operations. */
export function createRuntimeLauncherRegistry(
  deps: UtsushiPatchRuntimeLauncherDeps = {},
): RuntimeLauncherRegistry {
  return new RuntimeLauncherRegistry([realliveRuntimeLauncherAdapterFactory], deps);
}
