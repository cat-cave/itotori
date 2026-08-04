// Source-detected dashboard input materialization.
//
// The dashboard must use the same registered-engine selection seam as the
// command line. This module owns only the generic lifecycle: detect one
// adapter, allocate transient artifact paths, run its declared extract and
// structure requests, then validate the common artifacts. Concrete source
// layouts and engine argv live exclusively with their adapters.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import { runKaifuuExtract } from "../extract/kaifuu-extract-seam.js";
import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  type NarrativeStructure,
} from "../structure/index.js";
import { runStructureProvider } from "../structure-export/structure-provider-registry.js";
import {
  detectPatchbackEngine,
  PatchbackEngineSelectionError,
  type PatchbackEngineId,
} from "./adapters.js";

export type PatchbackProduceInputMaterialization = {
  engineId: PatchbackEngineId;
  sourceRoot: string;
  bridge: BridgeBundleV02;
  structure: NarrativeStructure;
};

export type MaterializePatchbackProduceInputRequest = {
  dataRoot: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
};

/**
 * Detect the sole matching adapter and materialize its source into the common
 * dashboard input. Selection errors intentionally propagate unchanged, so a
 * missing or ambiguous source stays a typed, actionable failure at the
 * product boundary rather than becoming a fallback to another engine.
 */
export function materializePatchbackProduceInput(
  request: MaterializePatchbackProduceInputRequest,
): PatchbackProduceInputMaterialization {
  const configuredRoot = resolve(request.dataRoot);
  const adapter = detectPatchbackEngine(configuredRoot);
  const sourceRoot = adapter.probeSource(configuredRoot);
  if (sourceRoot === null) {
    throw new PatchbackEngineSelectionError(
      "no-engine-detected",
      `registered patch-back engine '${adapter.engineId}' no longer recognizes '${configuredRoot}' while materializing dashboard input`,
    );
  }

  const scratchRoot = mkdtempSync(join(tmpdir(), "itotori-patchback-input-"));
  const bridgePath = join(scratchRoot, "bridge.json");
  const structurePath = join(scratchRoot, "structure.json");
  try {
    const plan = adapter.buildProduceInputMaterialization?.({
      sourceRoot,
      gameId: request.gameId,
      gameVersion: request.gameVersion,
      sourceProfileId: request.sourceProfileId,
      sourceLocale: request.sourceLocale,
      bridgePath,
      structurePath,
    });
    if (plan === undefined) {
      throw new PatchbackEngineSelectionError(
        "missing-artifact",
        `registered patch-back engine '${adapter.engineId}' has no dashboard input materialization contract`,
      );
    }

    runKaifuuExtract(plan.extract);
    runStructureProvider(plan.structure);

    const bridge = parseBridgeFile(bridgePath);
    return {
      engineId: adapter.engineId,
      sourceRoot,
      bridge,
      structure: parseNarrativeStructure(
        parseJsonFile(structurePath),
        SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
      ),
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function parseBridgeFile(path: string): BridgeBundleV02 {
  const value = parseJsonFile(path);
  assertBridgeBundleV02(value);
  return value;
}

function parseJsonFile(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return value;
}
