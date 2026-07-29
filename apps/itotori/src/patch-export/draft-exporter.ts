import { createHash } from "node:crypto";
import type { AuthorizationActor } from "@itotori/db";
import {
  assertDraftArtifactBundle,
  assertPatchExportBundle,
  PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
  selectedWrittenOutcomeCandidate,
  type DraftArtifactBundle,
  type PatchExportAssetDecision,
  type PatchExportAssetDecisionPolicy,
  type PatchExportBundle,
  type PatchExportDraft,
  type PreflightResult,
  type ProtectedSpanMapping,
} from "@itotori/localization-bridge-schema";
import {
  AssetDecisionPolicyResolver,
  type AssetPolicyResolution,
  type ResolvedAssetPolicy,
} from "../asset-decisions/policy-resolver.js";
import { resolveTargetPolicyForAdapter, type LocalizationTargetPolicy } from "../gates/index.js";
import {
  PatchExportPreflight,
  type DraftGlossaryRendering,
  type PreflightInput,
  type ScoredFindingsReport,
} from "./preflight.js";
import type {
  SourceBridgeAssetRef,
  SourceBridgeUnit,
  SourceBridgeView,
} from "./source-bridge-view.js";

export type DraftArtifactBundleLoad = { bundle: DraftArtifactBundle; sourceBridgeHash: string };

export interface DraftArtifactBundleLoaderPort {
  loadByJobId(actor: AuthorizationActor, draftJobId: string): Promise<DraftArtifactBundleLoad>;
}

export interface SourceBridgeViewLoaderPort {
  loadForLocale(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
  ): Promise<SourceBridgeView>;
}

export type PatchExportInput = {
  projectId: string;
  localeBranchId: string;
  draftArtifactBundleId: string;
  requestedBy: string;
};

export type PatchExporterDeps = {
  preflight: PatchExportPreflight;
  draftArtifactBundleLoader: DraftArtifactBundleLoaderPort;
  sourceBridgeViewLoader: SourceBridgeViewLoaderPort;
  assetDecisionResolver: AssetDecisionPolicyResolver;
  scoredFindingsReportLoader?: (
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
  ) => Promise<ScoredFindingsReport | undefined>;
  draftGlossaryRenderingLoader?: (
    actor: AuthorizationActor,
    bundle: DraftArtifactBundle,
  ) => Promise<ReadonlyArray<DraftGlossaryRendering>>;
  now?: () => Date;
};

export type PreflightFailure = {
  kind: "preflight_failure";
  failingChecks: PreflightResult[];
  preflightResults: PreflightResult[];
};

export class PatchExporterIdentityMismatchError extends Error {
  constructor(
    public readonly field: "projectId" | "localeBranchId" | "draftArtifactBundleId",
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `patch exporter refused: ${field} mismatch — expected ${expected}, draft artifact bundle says ${actual}`,
    );
    this.name = "PatchExporterIdentityMismatchError";
  }
}

export class PatchExporter {
  constructor(private readonly deps: PatchExporterDeps) {}

  async export(
    actor: AuthorizationActor,
    input: PatchExportInput,
  ): Promise<PatchExportBundle | PreflightFailure> {
    const load = await this.deps.draftArtifactBundleLoader.loadByJobId(
      actor,
      input.draftArtifactBundleId,
    );
    const bundle = load.bundle;
    assertDraftArtifactBundle(bundle);
    if (bundle.projectId !== input.projectId) {
      throw new PatchExporterIdentityMismatchError("projectId", input.projectId, bundle.projectId);
    }
    if (bundle.localeBranchId !== input.localeBranchId) {
      throw new PatchExporterIdentityMismatchError(
        "localeBranchId",
        input.localeBranchId,
        bundle.localeBranchId,
      );
    }
    if (bundle.draftJobId !== input.draftArtifactBundleId) {
      throw new PatchExporterIdentityMismatchError(
        "draftArtifactBundleId",
        input.draftArtifactBundleId,
        bundle.draftJobId,
      );
    }
    const view = await this.deps.sourceBridgeViewLoader.loadForLocale(
      actor,
      input.projectId,
      input.localeBranchId,
    );
    const assetResolutions = await this.resolveAllAssetDecisions(actor, view);
    const scoredFindingsReport = this.deps.scoredFindingsReportLoader
      ? await this.deps.scoredFindingsReportLoader(actor, input.projectId, input.localeBranchId)
      : undefined;
    const draftGlossaryRenderings = this.deps.draftGlossaryRenderingLoader
      ? await this.deps.draftGlossaryRenderingLoader(actor, bundle)
      : [];
    const preflightInput: PreflightInput = {
      draftArtifactBundle: bundle,
      sourceBridgeView: view,
      declaredSourceBridgeHash: load.sourceBridgeHash,
      resolveAssetPolicy: async (assetRef) =>
        assetResolutions.get(assetRefKey(assetRef)) ?? {
          policy: "unresolved",
          reason: "no_decision",
        },
      ...(scoredFindingsReport === undefined ? {} : { scoredFindingsReport }),
      draftGlossaryRenderings,
    };
    const preflightResults = await this.deps.preflight.runAll(preflightInput);
    const failing = preflightResults.filter(
      (result) => result.status === "fail" && result.blockingExport,
    );
    if (failing.length > 0)
      return { kind: "preflight_failure", failingChecks: failing, preflightResults };
    const drafts = buildDraftEntries(
      bundle,
      view,
      resolveTargetPolicyForAdapter(view.extractorAdapterId),
    );
    const assetDecisions = buildAssetDecisionEntries(view, assetResolutions);
    const provenance: PatchExportBundle["provenance"] = {
      draftArtifactBundleId: bundle.draftJobId,
      exportedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      exportedByUserId: input.requestedBy,
      ...(scoredFindingsReport === undefined
        ? {}
        : { agreedQaScore: scoredFindingsReport.overall }),
    };
    const out: PatchExportBundle = {
      schemaVersion: PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
      projectId: bundle.projectId,
      localeBranchId: bundle.localeBranchId,
      sourceBridgeHash: load.sourceBridgeHash,
      targetLocale: view.targetLocale,
      drafts,
      assetDecisions,
      preflightResults,
      provenance,
    };
    assertPatchExportBundle(out);
    return out;
  }

  private async resolveAllAssetDecisions(
    actor: AuthorizationActor,
    view: SourceBridgeView,
  ): Promise<Map<string, AssetPolicyResolution>> {
    const resolutions = new Map<string, AssetPolicyResolution>();
    for (const unit of view.units)
      for (const ref of unit.assetRefs) {
        const key = assetRefKey(ref);
        if (!resolutions.has(key))
          resolutions.set(
            key,
            await this.deps.assetDecisionResolver.resolvePolicy(
              actor,
              view.projectId,
              view.localeBranchId,
              { kind: ref.kind, ref: ref.ref },
            ),
          );
      }
    return resolutions;
  }
}

function buildDraftEntries(
  bundle: DraftArtifactBundle,
  view: SourceBridgeView,
  targetPolicy: LocalizationTargetPolicy,
): PatchExportDraft[] {
  const drafts: PatchExportDraft[] = [];
  const unitsBySource = new Map(view.units.map((unit) => [unit.sourceUnitId, unit]));
  for (const entry of bundle.drafts) {
    const unit = unitsBySource.get(entry.sourceUnitId);
    if (unit === undefined)
      throw new Error(
        `patch exporter: draft ${entry.draftId} references unknown sourceUnitId=${entry.sourceUnitId}`,
      );
    const draftText = selectedWrittenOutcomeCandidate(entry.writtenOutcome).body;
    const engineVisibleSource = targetPolicy.normalizeVisibleText(unit.sourceText).trim();
    const engineVisibleDraft = targetPolicy.normalizeVisibleText(draftText).trim();
    if (engineVisibleDraft.length === 0)
      throw new Error(
        `patch exporter: written outcome for ${entry.sourceUnitId} has no engine-visible target text`,
      );
    if (engineVisibleSource.length > 0 && engineVisibleDraft === engineVisibleSource)
      throw new Error(
        `patch exporter: written outcome for ${entry.sourceUnitId} repeats the engine-visible source text`,
      );
    drafts.push({
      sourceUnitId: entry.sourceUnitId,
      draftId: entry.draftId,
      sourceText: unit.sourceText,
      draftText,
      protectedSpanMappings: buildSpanMappings(unit, draftText),
      sourceUnitHash: unit.sourceUnitHash,
      draftUnitHash: hashDraft(entry.draftId, draftText),
    });
  }
  return drafts;
}

function buildSpanMappings(unit: SourceBridgeUnit, draftText: string): ProtectedSpanMapping[] {
  const mappings: ProtectedSpanMapping[] = [];
  for (const span of unit.protectedSpans) {
    if (span.outOfBand) continue;
    const needle =
      span.kind === "glossary" && span.expectedTargetForm !== undefined
        ? span.expectedTargetForm
        : span.sourceText;
    const draftStart = draftText.indexOf(needle);
    if (draftStart < 0)
      throw new Error(
        `patch exporter: draft text for ${unit.sourceUnitId} does not contain protected span '${span.spanRef}' (needle='${needle}')`,
      );
    mappings.push({
      spanRef: span.spanRef,
      sourceStart: span.sourceStart,
      sourceEnd: span.sourceEnd,
      draftStart,
      draftEnd: draftStart + needle.length,
      kind: span.kind,
      preservationRule: span.preservationRule,
    });
  }
  return mappings;
}

function buildAssetDecisionEntries(
  view: SourceBridgeView,
  resolutions: Map<string, AssetPolicyResolution>,
): PatchExportAssetDecision[] {
  const seen = new Set<string>();
  const entries: PatchExportAssetDecision[] = [];
  for (const unit of view.units)
    for (const ref of unit.assetRefs) {
      const key = assetRefKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const resolution = resolutions.get(key);
      if (resolution === undefined || resolution.policy === "unresolved")
        throw new Error(
          `patch exporter: asset ${key} has no resolved policy (preflight invariant violated)`,
        );
      entries.push({
        assetRef: key,
        assetKind: ref.assetKind,
        policy: resolution.policy as PatchExportAssetDecisionPolicy,
        decisionId: assetDecisionIdFor(ref, resolution),
        ...(resolution.rationale === undefined ? {} : { rationale: resolution.rationale }),
      });
    }
  return entries;
}

function assetDecisionIdFor(ref: SourceBridgeAssetRef, resolution: ResolvedAssetPolicy): string {
  const hash = createHash("sha256");
  hash.update(
    `${ref.kind}|${ref.ref}|${resolution.policy}|${resolution.decidedAt.toISOString()}|${resolution.decidedByUserId}`,
  );
  return `asset-decision:${hash.digest("hex").slice(0, 32)}`;
}

function assetRefKey(ref: SourceBridgeAssetRef): string {
  return `${ref.kind}:${ref.ref}`;
}

function hashDraft(draftId: string, draftText: string): string {
  const hash = createHash("sha256");
  hash.update(`${draftId}|${draftText}`);
  return `sha256:${hash.digest("hex")}`;
}
