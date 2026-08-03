// Patch-play runtime launcher facade.
//
// The facade owns no engine behavior. It derives launcher factories from the
// patchback engine registry, so an engine carries its byte producer and native
// runtime contribution together instead of Q5 maintaining a second engine list.

import { enginePatchbackAdapters, type PatchbackEngineId } from "../patchback/index.js";
import {
  RuntimeLauncherRegistry,
  type RuntimeLauncherAdapterFactory,
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

/** Build the registered runtime adapter registry for non-patch CLI operations. */
export function createRuntimeLauncherRegistry(
  deps: RuntimeLauncherDeps = {},
): RuntimeLauncherRegistry {
  return new RuntimeLauncherRegistry(runtimeLauncherFactories(), deps);
}

function runtimeLauncherFactories(): readonly RuntimeLauncherAdapterFactory[] {
  return enginePatchbackAdapters().flatMap((adapter) => {
    const factory = adapter.runtimeLauncherFactory;
    return factory === undefined ? [] : [boundRuntimeFactory(adapter.engineId, factory)];
  });
}

function boundRuntimeFactory(
  engineId: PatchbackEngineId,
  factory: RuntimeLauncherAdapterFactory,
): RuntimeLauncherAdapterFactory {
  return (deps) => {
    const adapter = factory(deps);
    if (adapter.manifest.adapterId !== engineId) {
      throw new Error(`runtime adapter registration does not match engine '${engineId}'`);
    }
    return adapter;
  };
}
