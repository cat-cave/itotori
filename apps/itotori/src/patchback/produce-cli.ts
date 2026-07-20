// User-shaped CLI surface for producing a persistent patched game tree.
//
// This is intentionally a thin adapter over `produceNativePatchbackBuild`.
// It does not reconstruct an export or invoke Kaifuu itself: the accepted-output
// producer remains the single owner of `kaifuu patch`, provenance artifacts, and
// manifest hashing. Unlike the HTTP download service, this command leaves its
// owned build root in place so an operator can launch or package the real
// patched game tree after the command returns.

import { existsSync } from "node:fs";

import { assertBridgeBundleV02 } from "@itotori/localization-bridge-schema";

import { AcceptedOutputSchema } from "../contracts/index.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import { produceNativePatchbackBuild, type ProducedPatchbackManifest } from "./produce-build.js";
import type { PatchbackEngineId, PatchbackScope } from "./adapters.js";
import type { NativePatchbackInput } from "./types.js";

/** Stable capability identity consumed by the CLI receipt and parity gate. */
export const PATCHBACK_PRODUCE_CAPABILITY_ID = "itotori.patchback-produce.v1" as const;

export type PatchbackProduceCliIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type PatchbackProduceCliArgs = {
  inputPath: string;
  outputPath: string;
  sourceRoot: string;
  buildRoot: string;
  scope: PatchbackScope;
  /** Explicit engine; when omitted the producer discovers it from the source. */
  engineId?: PatchbackEngineId;
  runId?: string;
  force?: boolean;
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
  io: PatchbackProduceCliIo;
};

export type PatchbackProduceCliReceipt = {
  schemaVersion: "itotori.patchback-produce-receipt.v0.1";
  capabilityId: typeof PATCHBACK_PRODUCE_CAPABILITY_ID;
  sourceRoot: string;
  buildRoot: string;
  scope: PatchbackScope;
  /** The engine the produced build was patched with (from the manifest). */
  engineId: PatchbackEngineId;
  patch: ProducedPatchbackManifest;
};

/**
 * Run `itotori patch produce`: validate the untrusted on-disk accepted-output
 * input, then invoke the ONE native build producer. The successful receipt
 * points at the persistent build root and carries the producer's hash-bound
 * manifest; it never substitutes a fixture or a second patching path.
 */
export function runPatchbackProduceCommand(
  args: PatchbackProduceCliArgs,
): PatchbackProduceCliReceipt {
  if (existsSync(args.buildRoot) && !args.force) {
    throw new Error(
      `patch produce refused: --build-root already exists (${args.buildRoot}); choose a new owned directory or pass --force`,
    );
  }

  const input = parseNativePatchbackInput(args.io.readJson(args.inputPath));
  const produced = produceNativePatchbackBuild(input, {
    sourceRoot: args.sourceRoot,
    buildRoot: args.buildRoot,
    scope: args.scope,
    ...(args.engineId === undefined ? {} : { engineId: args.engineId }),
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    ...(args.force === undefined ? {} : { force: args.force }),
    ...(args.nativeCli === undefined ? {} : { nativeCli: args.nativeCli }),
    ...(args.log === undefined ? {} : { log: args.log }),
  });
  const receipt: PatchbackProduceCliReceipt = {
    schemaVersion: "itotori.patchback-produce-receipt.v0.1",
    capabilityId: PATCHBACK_PRODUCE_CAPABILITY_ID,
    sourceRoot: args.sourceRoot,
    buildRoot: args.buildRoot,
    scope: args.scope,
    engineId: produced.patch.engineId,
    patch: produced.patch,
  };
  args.io.writeJson(args.outputPath, receipt);
  return receipt;
}

function parseNativePatchbackInput(value: unknown): NativePatchbackInput {
  if (!isRecord(value)) {
    throw new Error("patch produce input must be a NativePatchbackInput JSON object");
  }
  if (!isRecord(value.snapshot)) {
    throw new Error("patch produce input.snapshot must be an object");
  }
  if (!isRecord(value.snapshot.source) || !Array.isArray(value.snapshot.orderedUnits)) {
    throw new Error(
      "patch produce input.snapshot must contain source metadata and orderedUnits from buildFactSnapshot",
    );
  }
  if (!Array.isArray(value.accepted)) {
    throw new Error("patch produce input.accepted must be an array of accepted unit outputs");
  }
  for (const [index, candidate] of value.accepted.entries()) {
    const parsed = AcceptedOutputSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.subjectType !== "unit") {
      throw new Error(`patch produce input.accepted[${index}] must be a schema-valid unit output`);
    }
  }
  if (!isRecord(value.workScope) || !Array.isArray(value.workScope.inScopeUnitFactIds)) {
    throw new Error("patch produce input.workScope.inScopeUnitFactIds must be an array");
  }
  if (
    value.workScope.inScopeUnitFactIds.some(
      (factId) => typeof factId !== "string" || factId.length === 0,
    )
  ) {
    throw new Error(
      "patch produce input.workScope.inScopeUnitFactIds must contain non-empty strings",
    );
  }
  if (typeof value.sourceLocale !== "string" || value.sourceLocale.length === 0) {
    throw new Error("patch produce input.sourceLocale must be a non-empty string");
  }
  if (typeof value.targetLocale !== "string" || value.targetLocale.length === 0) {
    throw new Error("patch produce input.targetLocale must be a non-empty string");
  }
  // The bridge and every accepted output cross a native byte boundary. Validate
  // both here, before the producer creates a writable build root; the producer
  // repeats the bridge assertion at its own boundary as defense in depth.
  assertBridgeBundleV02(value.rawBridge);
  return value as unknown as NativePatchbackInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
