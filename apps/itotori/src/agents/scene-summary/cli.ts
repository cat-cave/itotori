import type {
  AuthorizationActor,
  ItotoriSceneSummaryRepositoryPort,
  ItotoriTranslationBatchRepositoryPort,
  TranslationBatchRecord,
} from "@itotori/db";
import type { ModelProvider, ProviderFamily } from "../../providers/types.js";
import { resolveSemanticAgentProvider } from "../../providers/fake.js";
import type { GlossaryRef } from "../../batch-planner/shapes.js";
import { generateSceneSummary, type GenerateSceneSummaryOptions } from "./agent.js";
import { persistSceneSummary } from "./persistence.js";
import { PROMPT_TEMPLATE_VERSION_V1 } from "./prompt-template.js";
import { markStaleSummariesForRevision, type StalenessScanResult } from "./staleness.js";
import type {
  BridgeUnitForSummary,
  PriorSummaryRef,
  SceneSummary,
  SceneSummaryInput,
  SceneSummaryModelProfile,
} from "./shapes.js";

export type GenerateSceneSummariesCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  sourceRevisionId: string;
  modelProfile: SceneSummaryModelProfile;
  sceneIdFilter?: string | undefined;
  includeStale?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export type CheckSceneSummariesCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  markStale?: boolean | undefined;
};

export type GenerateSceneSummariesCliResult = {
  scenes: SceneSummaryCliRow[];
  generatedCount: number;
  skippedFreshCount: number;
};

export type SceneSummaryCliRow = {
  sceneId: string;
  unitCount: number;
  citedUnits: number;
  tokens: number;
  status: "fresh" | "generated" | "stale" | "skipped";
  summaryId?: string | undefined;
  summaryText?: string | undefined;
};

export type SceneSummaryCliDependencies = {
  actor: AuthorizationActor;
  batchRepository: ItotoriTranslationBatchRepositoryPort;
  summaryRepository: ItotoriSceneSummaryRepositoryPort;
  provider: ModelProvider;
  log?: (message: string) => void;
  now?: () => Date;
};

/**
 * Construct the provider for the scene-summary CLI. The `fake` family is
 * reachable ONLY via the explicit `ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1`
 * test/dev opt-in; every live family loud-refuses with a typed error until
 * the real per-agent implementation is built — a real run therefore never
 * feeds fake-derived summaries into real translation context.
 */
export function resolveSceneSummaryProvider(family: ProviderFamily): ModelProvider {
  return resolveSemanticAgentProvider({
    agentName: "scene-summary",
    family,
    fakeProviderName: "itotori-scene-summary-fake",
  });
}

export async function runGenerateSceneSummariesCli(
  input: GenerateSceneSummariesCliInput,
  deps: SceneSummaryCliDependencies,
): Promise<GenerateSceneSummariesCliResult> {
  const log = deps.log ?? noopLog;
  const batches = await deps.batchRepository.loadBatches(deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
  });

  const scenes = collectScenes(batches);
  const filteredScenes =
    input.sceneIdFilter === undefined
      ? scenes
      : scenes.filter((scene) => scene.sceneId === input.sceneIdFilter);

  const result: SceneSummaryCliResultBuilder = {
    rows: [],
    generated: 0,
    skipped: 0,
  };

  // Bulk-load source text for every unit cited across the scenes we'll touch.
  const bridgeUnitIdsNeeded = new Set<string>();
  for (const scene of filteredScenes) {
    for (const segment of scene.segments) {
      for (const unit of segment.units) {
        bridgeUnitIdsNeeded.add(unit.bridgeUnitId);
      }
    }
  }
  const unitTextById = await deps.summaryRepository.loadBridgeUnitsForSummary(deps.actor, {
    bridgeUnitIds: [...bridgeUnitIdsNeeded],
  });

  for (const scene of filteredScenes) {
    // Resolve skip-vs-generate decision once per scene (the per-scene upsert
    // key would otherwise make every segment after the first observe its own
    // freshly-saved row).
    const existing = await deps.summaryRepository.loadSummaryByScene(deps.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      sceneId: scene.sceneId,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
    });
    const sceneFresh = existing?.status === "Fresh";
    if (sceneFresh && !input.includeStale) {
      result.rows.push({
        sceneId: scene.sceneId,
        unitCount: scene.segments.reduce((acc, s) => acc + s.units.length, 0),
        citedUnits: existing.citations.length,
        tokens: existing.inputTokenEstimate,
        status: "skipped",
        summaryId: existing.sceneSummaryId,
      });
      result.skipped += 1;
      log(
        formatRow(
          scene.sceneId,
          scene.segments.reduce((acc, s) => acc + s.units.length, 0),
          existing.citations.length,
          existing.inputTokenEstimate,
          "skipped",
        ),
      );
      continue;
    }

    let prior: PriorSummaryRef | undefined;
    let cumulativeUnits: BridgeUnitForSummary[] = [];

    for (const segment of scene.segments) {
      const hydratedSegmentUnits: BridgeUnitForSummary[] = segment.units.map((unit) => {
        const record = unitTextById.get(unit.bridgeUnitId);
        if (!record) {
          throw new Error(
            `scene-summary CLI: bridge unit ${unit.bridgeUnitId} (scene ${scene.sceneId}) not found in itotori_source_units`,
          );
        }
        return {
          bridgeUnitId: unit.bridgeUnitId,
          sourceUnitKey: record.sourceUnitKey,
          sourceText: record.sourceText,
          sourceHash: record.sourceHash,
          ...(record.speaker ? { speaker: record.speaker } : {}),
          occurrenceId: record.occurrenceId,
        };
      });
      cumulativeUnits = [...cumulativeUnits, ...hydratedSegmentUnits];

      const agentInput: SceneSummaryInput = {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        sourceLocale: input.sourceLocale,
        sceneId: scene.sceneId,
        units: cumulativeUnits,
        glossaryExcerpt: segment.glossary,
        modelProfile: input.modelProfile,
        ...(prior !== undefined ? { priorSummary: prior } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      };
      const options: GenerateSceneSummaryOptions = { provider: deps.provider };
      const output = await generateSceneSummary(agentInput, options);

      let savedSummary: SceneSummary = output.summary;
      if (!input.dryRun) {
        savedSummary = await persistSceneSummary(
          deps.summaryRepository,
          deps.actor,
          output.summary,
        );
      }

      prior = {
        summaryText: savedSummary.summaryText,
        promptTemplateVersion: savedSummary.promptTemplateVersion,
      };
      result.rows.push({
        sceneId: scene.sceneId,
        unitCount: cumulativeUnits.length,
        citedUnits: savedSummary.citedUnitIds.length,
        tokens: savedSummary.inputTokenEstimate,
        status: input.dryRun ? "generated" : "generated",
        summaryId: savedSummary.id,
        summaryText: savedSummary.summaryText,
      });
      result.generated += 1;
      log(
        formatRow(
          scene.sceneId,
          cumulativeUnits.length,
          savedSummary.citedUnitIds.length,
          savedSummary.inputTokenEstimate,
          "generated",
        ),
      );
    }
  }

  return {
    scenes: result.rows,
    generatedCount: result.generated,
    skippedFreshCount: result.skipped,
  };
}

export async function runCheckSceneSummariesCli(
  input: CheckSceneSummariesCliInput,
  deps: SceneSummaryCliDependencies,
): Promise<StalenessScanResult> {
  const log = deps.log ?? noopLog;
  const result = await markStaleSummariesForRevision(deps.summaryRepository, deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    markStale: input.markStale ?? false,
  });
  log(
    `scanned=${result.scannedSummaryCount} drifted=${result.driftedSummaries.length} marked_stale=${result.markedStaleCount}`,
  );
  for (const drift of result.driftedSummaries) {
    log(
      `drift sceneId=${drift.sceneId} summary=${drift.sceneSummaryId} units=${drift.driftedBridgeUnitIds.join(",")}`,
    );
  }
  return result;
}

export function freshSceneSummaryRefs(
  records: Array<{
    sceneId: string;
    status: string;
    sceneSummaryId: string;
    summaryText: string;
    promptHash: string;
  }>,
): Map<string, { contextArtifactId: string; sceneId: string; contentHash: string; body: string }> {
  const map = new Map<
    string,
    { contextArtifactId: string; sceneId: string; contentHash: string; body: string }
  >();
  for (const record of records) {
    if (record.status !== "Fresh") {
      continue;
    }
    map.set(record.sceneId, {
      contextArtifactId: record.sceneSummaryId,
      sceneId: record.sceneId,
      contentHash: record.promptHash,
      body: record.summaryText,
    });
  }
  return map;
}

type SceneSummaryCliResultBuilder = {
  rows: SceneSummaryCliRow[];
  generated: number;
  skipped: number;
};

type SceneSegmentUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceHash: string;
};

type SceneSegment = {
  batchOrdinal: number;
  units: SceneSegmentUnit[];
  glossary: GlossaryRef[];
};

type CollectedScene = {
  sceneId: string;
  segments: SceneSegment[];
};

function collectScenes(batches: TranslationBatchRecord[]): CollectedScene[] {
  const byScene = new Map<string, SceneSegment[]>();
  const ordered: string[] = [];
  for (const batch of batches) {
    if (batch.sceneId === null) {
      continue;
    }
    const glossary = batchGlossaryRefs(batch);
    const segment: SceneSegment = {
      batchOrdinal: batch.batchOrdinal,
      units: batch.units
        .slice()
        .sort((a, b) => a.unitOrdinal - b.unitOrdinal)
        .map((unit) => ({
          bridgeUnitId: unit.bridgeUnitId,
          sourceUnitKey: unit.sourceUnitKey,
          sourceHash: unit.sourceHash,
        })),
      glossary,
    };
    const existing = byScene.get(batch.sceneId);
    if (existing) {
      existing.push(segment);
    } else {
      byScene.set(batch.sceneId, [segment]);
      ordered.push(batch.sceneId);
    }
  }
  return ordered.map((sceneId) => ({
    sceneId,
    segments: (byScene.get(sceneId) ?? []).sort((a, b) => a.batchOrdinal - b.batchOrdinal),
  }));
}

function batchGlossaryRefs(batch: TranslationBatchRecord): GlossaryRef[] {
  const refs: GlossaryRef[] = [];
  for (const ref of batch.contextRefs) {
    if (ref.refKind !== "glossary_term") {
      continue;
    }
    const details = ref.details as Record<string, unknown>;
    const termKey = typeof details.termKey === "string" ? details.termKey : ref.refId;
    const preferredSourceForm =
      typeof details.preferredSourceForm === "string" ? details.preferredSourceForm : termKey;
    const preferredTargetForm =
      typeof details.preferredTargetForm === "string" ? details.preferredTargetForm : undefined;
    refs.push({
      termId: ref.refId,
      termKey,
      preferredSourceForm,
      ...(preferredTargetForm !== undefined ? { preferredTargetForm } : {}),
      hitBridgeUnitIds: ref.hitBridgeUnitIds ?? [],
    });
  }
  return refs;
}

function formatRow(
  sceneId: string,
  unitCount: number,
  citedUnits: number,
  tokens: number,
  status: SceneSummaryCliRow["status"],
): string {
  return `${sceneId} | units=${unitCount} | cited=${citedUnits} | tokens=${tokens} | ${status}`;
}

function noopLog(_message: string): void {
  // intentionally empty
}
