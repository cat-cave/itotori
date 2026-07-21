// Engine-generic patch-back adapter registry.
//
// The generic patch preparation (Bridge binding + PatchExportV02 +
// translated-bundle materialization) is engine-agnostic and lives in
// `build-patch-export.ts` / `translated-bundle.ts`. The BYTE APPLY is not: each
// engine owns its own patch scopes, its source-artifact discovery (RealLive's
// REALLIVEDATA/Seen.txt, Softpal's data.pac / loose SCRIPT.SRC+TEXT.DAT), its
// output artifact, and the exact `kaifuu patch --engine <id>` argv it spawns.
//
// This module is the registry the shared producer selects an adapter FROM. It
// never branches on a concrete engine — `applyEnginePatchback` resolves an
// `EnginePatchbackAdapter` by id (or by discovering which engine's source
// artifacts are present) and drives the ONE sanitized native-CLI spawn through
// the adapter's argv. Adding an engine is adding an adapter to the registry, not
// a new `if (engine === ...)` branch in the producer.

import { runNativeCli, type NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

/** The patch-back engines the app can select. Each maps 1:1 to a kaifuu-cli
 * `patch --engine <id>` implementation and to one registered adapter. */
export type PatchbackEngineId = "reallive" | "rpg-maker" | "softpal";

/** The generic byte-fidelity scope vocabulary. Adapters DECLARE which of these
 * they honor (`supportedScopes`); out-of-scope surfaces are carried
 * byte-identical by the engine's patchback regardless of which is chosen. */
export type PatchbackScope = "dialogue-only" | "dialogue+choices";

export const PATCHBACK_SCOPES: readonly PatchbackScope[] = ["dialogue-only", "dialogue+choices"];

export function isPatchbackScope(value: unknown): value is PatchbackScope {
  return value === "dialogue-only" || value === "dialogue+choices";
}

/** The artifact key every produced patch build addresses as its patched tree.
 * Each engine writes its patched bytes under a single directory the delivery
 * archiver tars, so the key is shared while the tree's shape is engine-owned. */
export const PATCHBACK_TARGET_ARTIFACT_KEY = "patchTarget" as const;

/** The apply request the generic producer hands an adapter. `sourceRoot` is the
 * read-only game root; `targetRoot` is the writable produced tree. Both the
 * translated bundle and the strict PatchExportV02 are materialized on disk by
 * the producer; each adapter consumes whichever its `kaifuu patch` arm reads
 * (RealLive → `--bundle`, Softpal → `--patch`). */
export type EnginePatchbackApplyRequest = {
  sourceRoot: string;
  targetRoot: string;
  /** Generic translated v0.2 bundle JSON for engines that consume `--bundle`. */
  translatedBundlePath: string;
  /** Generic strict PatchExportV02 JSON (Softpal `kaifuu patch --patch`). */
  patchExportPath?: string;
  scope: PatchbackScope;
  force?: boolean;
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
};

export type EnginePatchbackApplyResult = {
  /** The engine whose adapter produced the patched bytes. */
  engineId: PatchbackEngineId;
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
};

/** A typed, engine-discriminated patch receipt persisted alongside the produced
 * manifest so a delivered build records WHICH adapter wrote its bytes. */
export type PatchbackEngineReceipt = {
  schemaVersion: "itotori.patchback-engine-receipt.v0.1";
  engineId: PatchbackEngineId;
  scope: PatchbackScope;
  command: string;
  args: string[];
  status: number;
};

export class EnginePatchbackApplyError extends Error {
  constructor(
    public readonly engineId: PatchbackEngineId,
    public readonly status: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "EnginePatchbackApplyError";
  }
}

/** Raised when no adapter (or more than one) matches the requested engine /
 * discovered source — the producer never silently defaults to an engine. */
export class PatchbackEngineSelectionError extends Error {
  constructor(
    public readonly code:
      | "unknown-engine"
      | "engine-source-mismatch"
      | "no-engine-detected"
      | "ambiguous-engine"
      | "unsupported-scope"
      | "missing-artifact",
    message: string,
  ) {
    super(message);
    this.name = "PatchbackEngineSelectionError";
  }
}

/**
 * One engine's byte-apply contract. Owns the engine's scope vocabulary, its
 * source-artifact discovery, and its `kaifuu patch` argv. It does NOT own the
 * spawn / error handling — `applyEnginePatchback` runs the ONE sanitized native
 * CLI for every engine so the boundary stays single-sourced.
 */
export interface EnginePatchbackAdapter {
  readonly engineId: PatchbackEngineId;
  /** The byte-fidelity scopes this engine honors. */
  readonly supportedScopes: readonly PatchbackScope[];
  /**
   * Resolve the engine's source root under `root` (the directory whose bytes
   * the engine actually patches) — or `null` when this engine's source
   * artifacts are not present. Non-throwing: used both to VERIFY an explicit
   * engine and to DETECT one when unspecified.
   */
  probeSource(root: string): string | null;
  /**
   * Build the exact `kaifuu patch --engine <id>` argv (without the resolver
   * prefix). `request.sourceRoot` is already the adapter's resolved source
   * root. Pure so a test can assert the invocation without spawning.
   */
  buildApplyArgs(request: EnginePatchbackApplyRequest): string[];
}

const ADAPTERS = new Map<PatchbackEngineId, EnginePatchbackAdapter>();

/** Register an adapter. Called once per engine module at import time. */
export function registerEnginePatchbackAdapter(adapter: EnginePatchbackAdapter): void {
  ADAPTERS.set(adapter.engineId, adapter);
}

/** Every registered adapter, in stable engine-id order. */
export function enginePatchbackAdapters(): readonly EnginePatchbackAdapter[] {
  return [...ADAPTERS.values()].sort((a, b) => a.engineId.localeCompare(b.engineId));
}

/** Look up an adapter by id, or throw `unknown-engine`. */
export function enginePatchbackAdapter(engineId: PatchbackEngineId): EnginePatchbackAdapter {
  const adapter = ADAPTERS.get(engineId);
  if (adapter === undefined) {
    throw new PatchbackEngineSelectionError(
      "unknown-engine",
      `no patch-back adapter registered for engine '${engineId}'`,
    );
  }
  return adapter;
}

/**
 * Discover which engine's source artifacts live under `sourceRoot`. Exactly one
 * adapter must match — zero throws `no-engine-detected`, more than one throws
 * `ambiguous-engine`. This is the "derive engine from the source, never default
 * to RealLive" seam the CLI patch command selects through.
 */
export function detectPatchbackEngine(sourceRoot: string): EnginePatchbackAdapter {
  const matched = enginePatchbackAdapters().filter(
    (adapter) => adapter.probeSource(sourceRoot) !== null,
  );
  if (matched.length === 0) {
    throw new PatchbackEngineSelectionError(
      "no-engine-detected",
      `no registered patch-back engine recognizes the source root '${sourceRoot}' (expected one engine's source artifacts to be present)`,
    );
  }
  if (matched.length > 1) {
    throw new PatchbackEngineSelectionError(
      "ambiguous-engine",
      `source root '${sourceRoot}' matches multiple patch-back engines (${matched
        .map((adapter) => adapter.engineId)
        .join(", ")}); pass an explicit engine to disambiguate`,
    );
  }
  return matched[0]!;
}

/**
 * Select an adapter for a produce request: an explicit `engineId` is VERIFIED
 * against the source artifacts (mismatch throws), and an omitted one is DETECTED
 * from the source. Returns the adapter plus its resolved source root.
 */
export function resolvePatchbackAdapter(input: {
  engineId?: PatchbackEngineId;
  sourceRoot: string;
}): { adapter: EnginePatchbackAdapter; resolvedSourceRoot: string } {
  if (input.engineId !== undefined) {
    const adapter = enginePatchbackAdapter(input.engineId);
    const resolved = adapter.probeSource(input.sourceRoot);
    if (resolved === null) {
      throw new PatchbackEngineSelectionError(
        "engine-source-mismatch",
        `engine '${input.engineId}' was requested but its source artifacts are not present under '${input.sourceRoot}'`,
      );
    }
    return { adapter, resolvedSourceRoot: resolved };
  }
  const adapter = detectPatchbackEngine(input.sourceRoot);
  return { adapter, resolvedSourceRoot: adapter.probeSource(input.sourceRoot)! };
}

function assertScopeSupported(adapter: EnginePatchbackAdapter, scope: PatchbackScope): void {
  if (!adapter.supportedScopes.includes(scope)) {
    throw new PatchbackEngineSelectionError(
      "unsupported-scope",
      `engine '${adapter.engineId}' does not support scope '${scope}' (supported: ${adapter.supportedScopes.join(", ")})`,
    );
  }
}

/**
 * The exact argv the selected adapter would spawn — pure, so a test (and the CLI
 * `itotori patch` derivation) can assert the invocation without a process. The
 * engine is verified/detected against the source root the same way the apply
 * does, so the argv and the run never disagree on which engine was chosen.
 */
export function enginePatchbackApplyArgs(
  request: EnginePatchbackApplyRequest & { engineId?: PatchbackEngineId },
): { engineId: PatchbackEngineId; args: string[] } {
  const { adapter, resolvedSourceRoot } = resolvePatchbackAdapter({
    ...(request.engineId !== undefined ? { engineId: request.engineId } : {}),
    sourceRoot: request.sourceRoot,
  });
  assertScopeSupported(adapter, request.scope);
  const args = adapter.buildApplyArgs({ ...request, sourceRoot: resolvedSourceRoot });
  return { engineId: adapter.engineId, args };
}

/**
 * Select the engine adapter (by id or by source discovery), build its argv, and
 * drive the ONE sanitized native-CLI spawn. Throws {@link EnginePatchbackApplyError}
 * on any non-zero exit — there is no silent fallback and no per-engine spawn
 * boundary. This is the single home the RealLive apply was re-homed into.
 */
export function applyEnginePatchback(
  request: EnginePatchbackApplyRequest & { engineId?: PatchbackEngineId },
): EnginePatchbackApplyResult {
  const { adapter, resolvedSourceRoot } = resolvePatchbackAdapter({
    ...(request.engineId !== undefined ? { engineId: request.engineId } : {}),
    sourceRoot: request.sourceRoot,
  });
  assertScopeSupported(adapter, request.scope);
  const args = adapter.buildApplyArgs({ ...request, sourceRoot: resolvedSourceRoot });
  request.log?.(`native-apply: kaifuu-cli ${args.join(" ")}`);
  const res = runNativeCli("kaifuu-cli", args, request.nativeCli ?? {});
  if (res.status !== 0) {
    throw new EnginePatchbackApplyError(
      adapter.engineId,
      res.status,
      res.stderr,
      `kaifuu patch (${adapter.engineId}) failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    engineId: adapter.engineId,
    command: res.command,
    args: res.args,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/** Build the typed, engine-discriminated receipt the produced manifest persists. */
export function toPatchbackEngineReceipt(
  apply: EnginePatchbackApplyResult,
  scope: PatchbackScope,
): PatchbackEngineReceipt {
  return {
    schemaVersion: "itotori.patchback-engine-receipt.v0.1",
    engineId: apply.engineId,
    scope,
    command: apply.command,
    args: apply.args,
    status: apply.status,
  };
}
