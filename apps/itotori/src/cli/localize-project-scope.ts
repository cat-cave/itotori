import type { LocalizationRunProjectScope } from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
} from "../structure/index.js";
import { requiredFlag } from "./flags.js";

/** Build the durable parent graph from the invocation's authoritative artifacts.
 * The engine and source revision come from the decoded structure and bridge;
 * the game and build roots are operator-owned paths that neither artifact can
 * identify. */
export function localizeProjectScope(
  args: readonly string[],
  input: {
    readonly bridge: BridgeBundleV02;
    readonly structureJson: unknown;
    readonly projectId: string;
    readonly localeBranchId: string;
  },
): LocalizationRunProjectScope {
  const structure = parseNarrativeStructure(
    input.structureJson,
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
  return {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.bridge.sourceBundleRevision.revisionId,
    sourceLocale: input.bridge.sourceLocale,
    targetLocale: requiredFlag(args, "--target-locale"),
    engineFamily: structure.engine,
    sourceRoot: requiredFlag(args, "--source-root"),
    buildRoot: requiredFlag(args, "--build-root"),
    extractProfile: {
      bridgeId: input.bridge.bridgeId,
      extractor: input.bridge.extractor,
      sourceBundleHash: input.bridge.sourceBundleHash,
    },
  };
}
