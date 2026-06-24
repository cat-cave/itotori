import type { AuthorizationActor, ItotoriTerminologyCandidateRepositoryPort } from "@itotori/db";
import { FakeModelProvider } from "../../providers/fake.js";
import type { ModelProvider, ProviderFamily } from "../../providers/types.js";
import {
  generateTerminologyCandidates,
  type GenerateTerminologyCandidatesOptions,
} from "./agent.js";
import { persistTerminologyCandidate } from "./persistence.js";
import { PROMPT_TEMPLATE_VERSION_V1 } from "./prompt-template.js";
import {
  markStaleTerminologyCandidatesForRevision,
  type TerminologyCandidateStalenessScanResult,
} from "./staleness.js";
import type {
  BridgeUnitForTerminology,
  ExistingGlossaryEntry,
  TerminologyCandidate,
  TerminologyCandidateInput,
  TerminologyCandidateModelProfile,
} from "./shapes.js";

export type GenerateTerminologyCandidatesCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  sourceRevisionId: string;
  modelProfile: TerminologyCandidateModelProfile;
  includeStale?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export type CheckTerminologyCandidatesCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  markStale?: boolean | undefined;
};

export type GenerateTerminologyCandidatesCliResult = {
  candidates: TerminologyCandidate[];
  generatedCount: number;
  skippedFreshCount: number;
};

export type TerminologyCandidateCliDependencies = {
  actor: AuthorizationActor;
  repository: ItotoriTerminologyCandidateRepositoryPort;
  provider: ModelProvider;
  loadInputContext: (
    actor: AuthorizationActor,
    args: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId: string;
    },
  ) => Promise<{
    units: BridgeUnitForTerminology[];
    existingGlossary: ExistingGlossaryEntry[];
  }>;
  log?: (message: string) => void;
  now?: () => Date;
};

/**
 * Construct a default provider for the CLI. Live providers are opt-in via
 * env: `ITOTORI_LIVE_PROVIDER=1` must be set to allow any non-fake family.
 * Mirrors the character-relationship and route-choice-map CLI posture
 * (ADR 0002).
 */
export function resolveTerminologyCandidateProvider(family: ProviderFamily): ModelProvider {
  if (family === "fake") {
    return new FakeModelProvider({ providerName: "itotori-terminology-candidate-fake" });
  }
  if (process.env.ITOTORI_LIVE_PROVIDER !== "1") {
    throw new Error(
      `terminology-candidate CLI refused to construct provider family '${family}': set ITOTORI_LIVE_PROVIDER=1 to opt in`,
    );
  }
  throw new Error(
    `terminology-candidate CLI does not yet support provider family '${family}' in this entry point`,
  );
}

export async function runGenerateTerminologyCandidatesCli(
  input: GenerateTerminologyCandidatesCliInput,
  deps: TerminologyCandidateCliDependencies,
): Promise<GenerateTerminologyCandidatesCliResult> {
  const log = deps.log ?? noopLog;
  const context = await deps.loadInputContext(deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
  });

  // Skip surface forms already persisted at the current template version
  // unless --include-stale is set.
  let skippedFreshCount = 0;
  const skipSurfaceForms = new Set<string>();
  if (!input.includeStale) {
    const existing = await deps.repository.loadCandidatesByProject(deps.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      status: "Fresh",
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
    });
    for (const candidate of existing) {
      skipSurfaceForms.add(candidate.surfaceForm);
    }
  }

  const agentInput: TerminologyCandidateInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    sourceLocale: input.sourceLocale,
    units: context.units,
    existingGlossary: context.existingGlossary,
    modelProfile: input.modelProfile,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const options: GenerateTerminologyCandidatesOptions = { provider: deps.provider };
  const output = await generateTerminologyCandidates(agentInput, options);

  const finalCandidates: TerminologyCandidate[] = [];
  for (const candidate of output.candidates) {
    if (skipSurfaceForms.has(candidate.surfaceForm)) {
      skippedFreshCount += 1;
      log(`skip-fresh surfaceForm=${candidate.surfaceForm}`);
      continue;
    }
    if (input.dryRun) {
      finalCandidates.push(candidate);
    } else {
      finalCandidates.push(
        await persistTerminologyCandidate(deps.repository, deps.actor, candidate),
      );
    }
    log(
      `candidate surfaceForm=${candidate.surfaceForm} kind=${candidate.kind} cited=${candidate.citedUnitIds.length}`,
    );
  }

  return {
    candidates: finalCandidates,
    generatedCount: finalCandidates.length,
    skippedFreshCount,
  };
}

export async function runCheckTerminologyCandidatesCli(
  input: CheckTerminologyCandidatesCliInput,
  deps: TerminologyCandidateCliDependencies,
): Promise<TerminologyCandidateStalenessScanResult> {
  const log = deps.log ?? noopLog;
  const result = await markStaleTerminologyCandidatesForRevision(deps.repository, deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    markStale: input.markStale ?? false,
  });
  log(
    `scanned candidates=${result.scannedCandidateCount} ` +
      `drifted=${result.driftedCandidates.length} ` +
      `conflicts=${result.conflictingCandidates.length} ` +
      `marked-stale=${result.markedStaleCandidateCount} ` +
      `marked-rejected=${result.markedRejectedCandidateCount}`,
  );
  for (const drift of result.driftedCandidates) {
    log(
      `drift candidate surfaceForm=${drift.surfaceForm} candidateId=${drift.terminologyCandidateId} units=${drift.driftedBridgeUnitIds.join(",")}`,
    );
  }
  for (const conflict of result.conflictingCandidates) {
    log(
      `conflict candidate surfaceForm=${conflict.surfaceForm} candidateId=${conflict.terminologyCandidateId} termId=${conflict.terminologyTermId}`,
    );
  }
  return result;
}

function noopLog(_message: string): void {
  // intentionally empty
}
