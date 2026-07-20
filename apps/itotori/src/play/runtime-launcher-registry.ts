// Runtime-launcher adapter registry.
//
// The patch-play producer never guesses an engine. A request names one
// registered adapter and operation, then that adapter owns its descriptor,
// artifact discovery, native argv, and receipt payload.

import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

/** The hash-bound delivery surface shared by every runtime adapter. */
export type RuntimePatchSurface = {
  patchVersionId: string;
  status: string;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
};

/** The generic part of a runtime launch request. `launchDescriptor` stays adapter-owned. */
export type RuntimeLaunchRequest = {
  /** Required registry discriminator; there is no inferred or default adapter. */
  adapterId: string;
  /** The capability selected from the adapter's manifest. */
  operation: string;
  /** Optional generic artifact root; an adapter verifies any supplied root against the patch. */
  artifactRoot?: string;
  /** Optional generic output path owned by the selected operation. */
  output?: string;
  /** Opaque, namespaced descriptor interpreted only by the selected adapter. */
  launchDescriptor: Record<string, unknown>;
};

/**
 * The public receipt is an adapter-discriminated union. Shared fields identify
 * the selected adapter/capability; engine-specific evidence belongs in the
 * adapter payload rather than freezing one engine's runtime vocabulary here.
 */
export type PatchRuntimeLaunchReceipt = {
  adapterId: "reallive";
  operation: "replay-validate";
  adapterReceipt: {
    replay: "observed";
    scene: number;
    observedTextLineCount: number;
  };
};

export type PatchRuntimeLaunchErrorCode =
  | "patch_not_playable"
  | "artifact_integrity_failed"
  | "patch_provenance_invalid"
  | "unknown_runtime_adapter"
  | "unsupported_runtime_operation"
  | "runtime_assets_missing"
  | "scene_not_available"
  | "invalid_launch_descriptor"
  | "runtime_failed"
  | "runtime_observation_missing";

/** A path-redacted runtime-launch failure suitable for API and CLI callers. */
export class PatchRuntimeLaunchError extends Error {
  constructor(
    public readonly code: PatchRuntimeLaunchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PatchRuntimeLaunchError";
  }
}

export type RuntimeLauncherDeps = {
  nativeCli?: NativeCliRunner;
  temporaryRoot?: string;
};

export type RuntimeLauncherCapability = "replay-validate" | "validate";

export type RuntimeLauncherManifest = {
  adapterId: string;
  summary: string;
  capabilities: readonly RuntimeLauncherCapability[];
};

export type RuntimeLauncherAdapter = {
  readonly manifest: RuntimeLauncherManifest;
  launch(input: {
    patch: RuntimePatchSurface;
    request: RuntimeLaunchRequest;
  }): Promise<PatchRuntimeLaunchReceipt>;
  validateCli(args: readonly string[]): void;
};

/** Factories receive process seams once and build an adapter for one registry instance. */
export type RuntimeLauncherAdapterFactory = (deps: RuntimeLauncherDeps) => RuntimeLauncherAdapter;

export class RuntimeLauncherRegistry {
  private readonly adapters: Map<string, RuntimeLauncherAdapter>;

  constructor(factories: readonly RuntimeLauncherAdapterFactory[], deps: RuntimeLauncherDeps = {}) {
    this.adapters = new Map();
    for (const factory of factories) {
      const adapter = factory(deps);
      const adapterId = adapter.manifest.adapterId;
      if (this.adapters.has(adapterId)) {
        throw new Error(`duplicate runtime launcher adapter '${adapterId}'`);
      }
      this.adapters.set(adapterId, adapter);
    }
  }

  manifests(): readonly RuntimeLauncherManifest[] {
    return [...this.adapters.values()]
      .map((adapter) => adapter.manifest)
      .sort((left, right) => left.adapterId.localeCompare(right.adapterId));
  }

  async launch(input: {
    patch: RuntimePatchSurface;
    request: RuntimeLaunchRequest;
  }): Promise<PatchRuntimeLaunchReceipt> {
    const adapter = this.requireCapability(input.request.adapterId, input.request.operation);
    return await adapter.launch(input);
  }

  validate(adapterId: string, args: readonly string[]): void {
    const adapter = this.requireCapability(adapterId, "validate");
    adapter.validateCli(args);
  }

  private requireCapability(adapterId: string, operation: string): RuntimeLauncherAdapter {
    const adapter = this.adapters.get(adapterId);
    if (adapter === undefined) {
      throw new PatchRuntimeLaunchError(
        "unknown_runtime_adapter",
        `no runtime launcher adapter is registered for '${adapterId}'`,
      );
    }
    if (!adapter.manifest.capabilities.includes(operation as RuntimeLauncherCapability)) {
      throw new PatchRuntimeLaunchError(
        "unsupported_runtime_operation",
        `runtime adapter '${adapterId}' does not support '${operation}' (supported: ${adapter.manifest.capabilities.join(", ")})`,
      );
    }
    return adapter;
  }
}
