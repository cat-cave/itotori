// ITOTORI-025 — PatchExporter.
//
// Patch-export service. Loads a draft artifact bundle, resolves every
// referenced asset decision, runs the preflight battery, and emits a
// `PatchExportBundle` — or returns a typed `PreflightFailure` if
// any blocking preflight check fails. No partial bundle is ever
// produced.
//
// Hard constraints honored:
//   - sourceBridgeHash is REQUIRED and validated by the preflight.
//   - protected-span mappings are REQUIRED — the exporter rejects when
//     a draft loses a span; the `protectedSpanCoverage` preflight check
//     blocks export in that case.
//   - unresolved asset decisions block export — the exporter does NOT
//     silently default to keep_original; it returns PreflightFailure.

import { createHash } from "node:crypto";
import {
  verifyLocalizationArtifactManifest,
  type AuthorizationActor,
  type PlayablePatchExport,
  type SelectedPatchExport,
} from "@itotori/db";
import {
  assertDraftArtifactBundle,
  assertPatchExportBundle,
  PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
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
import { createDeliveredPatchArchive, type DeliveredPatchArchive } from "./delivery-archive.js";
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

// ---------------------------------------------------------------------------
// Delivered patch export — selected, already-applied game bytes
// ---------------------------------------------------------------------------

/**
 * Loader for the delivery side of patch export. Unlike the draft bundle
 * exporter below, this consumes a selected PatchVersion whose Kaifuu-produced
 * bytes already exist. This is the production route used after a play-tester
 * result revision selects its child patch.
 */
export interface SelectedPatchDeliveryLoaderPort {
  loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null>;
}

/** Immutable historical-version delivery source (not current-run selection). */
export interface PlayablePatchDeliveryLoaderPort {
  loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null>;
}

export type DeliveredPatchExportInput = {
  runId?: string;
  patchVersionId?: string;
};

/**
 * The real delivery exporter. It deliberately does not rebuild a
 * DraftArtifactBundle: a selected child revision is already a validated game
 * patch, so delivery is the selected hash-bound artifact manifest itself.
 */
export class DeliveredPatchExporter {
  constructor(
    private readonly loader: SelectedPatchDeliveryLoaderPort & PlayablePatchDeliveryLoaderPort,
  ) {}

  async export(
    actor: AuthorizationActor,
    input: DeliveredPatchExportInput,
  ): Promise<SelectedPatchExport | null> {
    const selected = await this.loader.loadSelectedPatchExport(actor, input);
    if (selected === null) return null;
    if (selected.status !== "playable" || selected.playableAt === null) {
      throw new Error(
        `delivered patch export refused: selected patch ${selected.patchVersionId} is not playable`,
      );
    }
    verifyLocalizationArtifactManifest(selected.artifactRefs, selected.artifactHashes);
    return selected;
  }

  /**
   * Load exact historical delivery by immutable patch id. This intentionally
   * does not consult the run's mutable selected revision.
   */
  async exportExact(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null> {
    const patch = await this.loader.loadPlayablePatchExport(actor, input);
    if (patch === null) return null;
    if (patch.status !== "playable" || patch.playableAt === null) {
      throw new Error(
        `delivered patch export refused: patch ${patch.patchVersionId} is not playable`,
      );
    }
    verifyLocalizationArtifactManifest(patch.artifactRefs, patch.artifactHashes);
    return patch;
  }

  /**
   * Produce the bytes a player downloads for the selected patch. Calling
   * {@link export} first preserves the same actor authorization, playable
   * state, and manifest verification used by metadata delivery.
   */
  async archive(
    actor: AuthorizationActor,
    input: DeliveredPatchExportInput,
  ): Promise<DeliveredPatchArchive | null> {
    const selected = await this.export(actor, input);
    return selected === null ? null : createDeliveredPatchArchive(selected);
  }

  /** Produce trusted archive bytes for the addressed immutable patch version. */
  async archiveExact(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<DeliveredPatchArchive | null> {
    const patch = await this.exportExact(actor, input);
    return patch === null ? null : createDeliveredPatchArchive(patch);
  }
}

/**
 * Repository-style port: loads a draft artifact bundle by id along
 * with its drafted-against source bridge hash. The exporter never
 * re-runs drafting; it strictly consumes upstream output. The bundle
 * shape mirrors the ITOTORI-019 `DraftArtifactBundle`.
 *
 * `sourceBridgeHash` is the bridge revision the draft job was run
 * against. The preflight `sourceBridgeIntegrity` check compares this
 * to the CURRENT bridge view's hash and blocks export when they
 * drift (stale draft bundle).
 */
export type DraftArtifactBundleLoad = {
  bundle: DraftArtifactBundle;
  sourceBridgeHash: string;
};

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
  /**
   * Optional QA report supplier; when wired, the preflight's
   * `qaScoreThreshold` check has data to evaluate. Returns `undefined`
   * to indicate no report is available (the check still runs and
   * surfaces as a non-blocking warning).
   */
  scoredFindingsReportLoader?: (
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
  ) => Promise<ScoredFindingsReport | undefined>;
  /**
   * Optional glossary rendering supplier (powers
   * `glossaryConsistency`). Returns an empty array when no glossary
   * data is available.
   */
  draftGlossaryRenderingLoader?: (
    actor: AuthorizationActor,
    bundle: DraftArtifactBundle,
  ) => Promise<ReadonlyArray<DraftGlossaryRendering>>;
  now?: () => Date;
};

export type PreflightFailure = {
  kind: "preflight_failure";
  failingChecks: PreflightResult[];
  /**
   * The full preflight result list (passing checks included) so the
   * caller can render the same wire surface that would have appeared
   * on the bundle.
   */
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
    const declaredSourceBridgeHash = load.sourceBridgeHash;
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

    // Resolve all asset decisions exactly once and cache by ref key.
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
      declaredSourceBridgeHash,
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
    if (failing.length > 0) {
      return {
        kind: "preflight_failure",
        failingChecks: failing,
        preflightResults,
      };
    }

    const targetPolicy = resolveTargetPolicyForAdapter(view.extractorAdapterId);
    const drafts = buildDraftEntries(bundle, view, targetPolicy);
    const assetDecisions = buildAssetDecisionEntries(view, assetResolutions);
    const exportedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const provenance: PatchExportBundle["provenance"] = {
      draftArtifactBundleId: bundle.draftJobId,
      exportedAt,
      exportedByUserId: input.requestedBy,
    };
    if (scoredFindingsReport !== undefined) {
      provenance.agreedQaScore = scoredFindingsReport.overall;
    }
    const out: PatchExportBundle = {
      schemaVersion: PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
      projectId: bundle.projectId,
      localeBranchId: bundle.localeBranchId,
      sourceBridgeHash: declaredSourceBridgeHash,
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
    for (const unit of view.units) {
      for (const ref of unit.assetRefs) {
        const key = assetRefKey(ref);
        if (resolutions.has(key)) continue;
        const resolution = await this.deps.assetDecisionResolver.resolvePolicy(
          actor,
          view.projectId,
          view.localeBranchId,
          { kind: ref.kind, ref: ref.ref },
        );
        resolutions.set(key, resolution);
      }
    }
    return resolutions;
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildDraftEntries(
  bundle: DraftArtifactBundle,
  view: SourceBridgeView,
  targetPolicy: LocalizationTargetPolicy,
): PatchExportDraft[] {
  const drafts: PatchExportDraft[] = [];
  const unitsBySource = new Map(view.units.map((unit) => [unit.sourceUnitId, unit]));
  for (const entry of bundle.drafts) {
    const unit = unitsBySource.get(entry.sourceUnitId);
    if (unit === undefined) {
      throw new Error(
        `patch exporter: draft ${entry.draftId} references unknown sourceUnitId=${entry.sourceUnitId}`,
      );
    }
    const selectedCandidate = entry.writtenOutcome.candidates.find(
      (candidate: any) => candidate.id === entry.writtenOutcome.selectedCandidateId,
    );
    if (selectedCandidate === undefined) {
      throw new Error(
        `patch exporter: written outcome for ${entry.sourceUnitId} has no selected candidate`,
      );
    }
    const draftText = selectedCandidate.body;
    const engineVisibleSource = targetPolicy.normalizeVisibleText(unit.sourceText).trim();
    const engineVisibleDraft = targetPolicy.normalizeVisibleText(draftText).trim();
    if (engineVisibleDraft.length === 0) {
      throw new Error(
        `patch exporter: written outcome for ${entry.sourceUnitId} has no engine-visible target text`,
      );
    }
    if (engineVisibleSource.length > 0 && engineVisibleDraft === engineVisibleSource) {
      throw new Error(
        `patch exporter: written outcome for ${entry.sourceUnitId} repeats the engine-visible source text`,
      );
    }
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
    const needle = expectedDraftTextForSpan(span);
    const draftStart = draftText.indexOf(needle);
    if (draftStart < 0) {
      // Preflight should have blocked this; raise so the bundle is
      // never persisted in a half-built state.
      throw new Error(
        `patch exporter: draft text for ${unit.sourceUnitId} does not contain protected span '${span.spanRef}' (needle='${needle}')`,
      );
    }
    const draftEnd = draftStart + needle.length;
    mappings.push({
      spanRef: span.spanRef,
      sourceStart: span.sourceStart,
      sourceEnd: span.sourceEnd,
      draftStart,
      draftEnd,
      kind: span.kind,
      preservationRule: span.preservationRule,
    });
  }
  return mappings;
}

function expectedDraftTextForSpan(span: SourceBridgeUnit["protectedSpans"][number]): string {
  if (span.kind === "glossary" && span.expectedTargetForm !== undefined) {
    return span.expectedTargetForm;
  }
  return span.sourceText;
}

function buildAssetDecisionEntries(
  view: SourceBridgeView,
  resolutions: Map<string, AssetPolicyResolution>,
): PatchExportAssetDecision[] {
  const seen = new Set<string>();
  const entries: PatchExportAssetDecision[] = [];
  for (const unit of view.units) {
    for (const ref of unit.assetRefs) {
      const key = assetRefKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const resolution = resolutions.get(key);
      if (resolution === undefined || resolution.policy === "unresolved") {
        // Preflight already blocked this; raise.
        throw new Error(
          `patch exporter: asset ${key} has no resolved policy (preflight invariant violated)`,
        );
      }
      entries.push(buildAssetDecisionEntry(ref, resolution));
    }
  }
  return entries;
}

function buildAssetDecisionEntry(
  ref: SourceBridgeAssetRef,
  resolution: ResolvedAssetPolicy,
): PatchExportAssetDecision {
  const entry: PatchExportAssetDecision = {
    assetRef: assetRefKey(ref),
    assetKind: ref.assetKind,
    policy: resolution.policy as PatchExportAssetDecisionPolicy,
    decisionId: assetDecisionIdFor(ref, resolution),
  };
  if (resolution.rationale !== undefined) {
    entry.rationale = resolution.rationale;
  }
  return entry;
}

function assetDecisionIdFor(ref: SourceBridgeAssetRef, resolution: ResolvedAssetPolicy): string {
  // The repository's decisionId is the authoritative identifier; the
  // policy resolver does not surface it today, so the exporter
  // synthesizes a deterministic id derived from the resolved fields.
  // Once the resolver returns the decisionId, swap this for the
  // upstream value. The id is recorded in the bundle so the audit
  // trail can recover the resolution.
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
