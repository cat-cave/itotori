// ITOTORI-025 — `export-patch-v2` CLI command.
//
// Fixture-mode entry point for the current patch-export pipeline. The
// existing `export-patch` command (v0.1) is unchanged and continues to
// serve the legacy `just hello` recipe; this command runs the preflight
// battery and emits the current `PatchExportBundle` schema.
//
// Inputs:
//   --project       path to a JSON fixture describing the source bridge
//                   view + asset decisions for the run.
//   --draft-bundle  path to a `DraftArtifactBundle` produced by the active
//                   localization pipeline.
//   --output        where to write the patch-export bundle (or, on
//                   preflight failure, where to write the structured
//                   failure report).
//   --locale        target locale (must match the project fixture).
//   --requested-by  optional actor id; defaults to "local-user".
//
// On preflight failure the CLI:
//   1. Writes a structured failure JSON to `--output` so the operator
//      can inspect every check (passing + failing) in one place.
//   2. Exits the process with code 1 via the injected `exit` hook.

import type { AuthorizationActor } from "@itotori/db";
import {
  assertDraftArtifactBundle,
  assertPatchExportBundle,
  PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
  type PatchExportBundle,
} from "@itotori/localization-bridge-schema";
import { AssetDecisionPolicyResolver } from "../asset-decisions/policy-resolver.js";
import {
  PatchExporter,
  type DraftArtifactBundleLoaderPort,
  type PatchExportInput,
  type PreflightFailure,
  type SourceBridgeViewLoaderPort,
} from "./exporter.js";
import { PatchExportPreflight } from "./preflight.js";
import type { SourceBridgeUnit, SourceBridgeView } from "./source-bridge-view.js";
import {
  PATCH_EXPORT_PROTECTED_SPAN_KINDS,
  PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULES,
} from "@itotori/localization-bridge-schema";
import type { AssetDecisionRecord } from "@itotori/db";

export type ExportPatchV2CliIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type ExportPatchV2CliArgs = {
  projectPath: string;
  draftBundlePath: string;
  outputPath: string;
  locale: string;
  requestedBy?: string;
  /**
   * The bridge revision the draft bundle was generated against. When
   * omitted, defaults to the project fixture's `sourceBridgeHash`
   * (success path). Pass an older hash to exercise the stale-bundle
   * preflight failure.
   */
  draftSourceBridgeHash?: string;
  io: ExportPatchV2CliIo;
  actor: AuthorizationActor;
  /**
   * Closure-style loader: the CLI wraps the asset-decision repository
   * here so the policy resolver can call back per asset ref. The
   * implementation is expected to bind the actor internally; the
   * `(actor, projectId, localeBranchId)` signature mirrors the
   * underlying `ItotoriAssetLocalizationDecisionRepositoryPort` so
   * tests can plug in the same in-memory repo the dashboard uses.
   */
  loadActiveDecisions: (
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
  ) => Promise<ReadonlyArray<AssetDecisionRecord>>;
  /**
   * Optional `process.exit` injection so tests can capture the non-zero
   * exit on preflight failure. Defaults to a no-op so in-process
   * callers may inspect the return value instead.
   */
  exit?: (code: number) => void;
  now?: () => Date;
  log?: (message: string) => void;
};

/**
 * On-disk fixture for `--project`. Shape mirrors the source-bridge view
 * with a literal sourceBridgeHash field so the preflight integrity
 * check has something to compare against. Asset decisions are not
 * embedded here — they live in the asset-decision repository the CLI
 * passes in.
 */
export type PatchExportV2ProjectFixture = {
  schemaVersion: "itotori.patch-export-v2-project.v1";
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceBridgeHash: string;
  units: PatchExportV2ProjectFixtureUnit[];
};

export type PatchExportV2ProjectFixtureUnit = {
  sourceUnitId: string;
  sourceText: string;
  sourceUnitHash: string;
  assetRefs?: PatchExportV2ProjectFixtureAssetRef[];
  protectedSpans?: PatchExportV2ProjectFixtureSpan[];
  glossaryTerms?: PatchExportV2ProjectFixtureGlossaryTerm[];
};

export type PatchExportV2ProjectFixtureAssetRef = {
  kind: string;
  ref: string;
  assetKind: string;
};

export type PatchExportV2ProjectFixtureSpan = {
  spanRef: string;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  kind: string;
  preservationRule: string;
  expectedTargetForm?: string;
};

export type PatchExportV2ProjectFixtureGlossaryTerm = {
  termId: string;
  sourceForm: string;
  expectedTargetForm: string;
};

export class ExportPatchV2LocaleMismatchError extends Error {
  constructor(
    public readonly requestedLocale: string,
    public readonly fixtureLocale: string,
  ) {
    super(
      `export-patch-v2 refused: --locale '${requestedLocale}' does not match fixture targetLocale '${fixtureLocale}'`,
    );
    this.name = "ExportPatchV2LocaleMismatchError";
  }
}

/**
 * Main entry point. Returns the produced bundle or the preflight
 * failure summary; the CLI handler writes one or the other to disk.
 */
export async function runExportPatchV2Command(
  args: ExportPatchV2CliArgs,
): Promise<PatchExportBundle | PreflightFailure> {
  const rawProject = args.io.readJson(args.projectPath);
  const project = assertProjectFixture(rawProject);
  if (project.targetLocale !== args.locale) {
    throw new ExportPatchV2LocaleMismatchError(args.locale, project.targetLocale);
  }
  const rawBundle = args.io.readJson(args.draftBundlePath);
  assertDraftArtifactBundle(rawBundle);
  const draftBundle: DraftArtifactBundle = rawBundle;

  const view = projectFixtureToBridgeView(project);

  const draftSourceBridgeHash = args.draftSourceBridgeHash ?? project.sourceBridgeHash;
  const draftBundleLoader: DraftArtifactBundleLoaderPort = {
    async loadByJobId(_actor, draftJobId) {
      if (draftJobId !== draftBundle.draftJobId) {
        throw new Error(
          `export-patch-v2: requested draftJobId=${draftJobId} but on-disk bundle is for ${draftBundle.draftJobId}`,
        );
      }
      return { bundle: draftBundle, sourceBridgeHash: draftSourceBridgeHash };
    },
  };
  const sourceBridgeViewLoader: SourceBridgeViewLoaderPort = {
    async loadForLocale(_actor, projectId, localeBranchId): Promise<SourceBridgeView> {
      if (projectId !== view.projectId || localeBranchId !== view.localeBranchId) {
        throw new Error(
          `export-patch-v2: requested project/locale (${projectId}/${localeBranchId}) does not match fixture (${view.projectId}/${view.localeBranchId})`,
        );
      }
      return view;
    },
  };

  const resolverRepository = {
    async loadActiveDecisions(
      actor: AuthorizationActor,
      projectId: string,
      localeBranchId: string,
    ): Promise<AssetDecisionRecord[]> {
      const records = await args.loadActiveDecisions(actor, projectId, localeBranchId);
      return [...records];
    },
  };

  const exporter = new PatchExporter({
    preflight: new PatchExportPreflight(),
    draftArtifactBundleLoader: draftBundleLoader,
    sourceBridgeViewLoader,
    assetDecisionResolver: new AssetDecisionPolicyResolver(resolverRepository),
    ...(args.now === undefined ? {} : { now: args.now }),
  });

  const exporterInput: PatchExportInput = {
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    draftArtifactBundleId: draftBundle.draftJobId,
    requestedBy: args.requestedBy ?? "local-user",
  };

  const result = await exporter.export(args.actor, exporterInput);
  if ("kind" in result && result.kind === "preflight_failure") {
    args.io.writeJson(args.outputPath, {
      kind: "preflight_failure",
      failingChecks: result.failingChecks,
      preflightResults: result.preflightResults,
    });
    if (args.log) {
      args.log(formatPreflightFailureMessage(result));
    }
    if (args.exit) {
      args.exit(1);
    }
    return result;
  }
  assertPatchExportBundle(result);
  args.io.writeJson(args.outputPath, result);
  if (args.log) {
    args.log(
      `patch-export ${PATCH_EXPORT_BUNDLE_SCHEMA_VERSION} produced: drafts=${result.drafts.length} assetDecisions=${result.assetDecisions.length} preflight=${result.preflightResults.length}`,
    );
  }
  return result;
}

function formatPreflightFailureMessage(failure: PreflightFailure): string {
  const lines = [`patch-export ${PATCH_EXPORT_BUNDLE_SCHEMA_VERSION} preflight failed:`];
  for (const check of failure.failingChecks) {
    lines.push(`  - ${check.check}: ${check.detail ?? "<no detail>"}`);
  }
  return lines.join("\n");
}

function assertProjectFixture(value: unknown): PatchExportV2ProjectFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("export-patch-v2 project fixture must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "itotori.patch-export-v2-project.v1") {
    throw new Error(
      `export-patch-v2 project fixture schemaVersion must be 'itotori.patch-export-v2-project.v1' (got ${String(record.schemaVersion)})`,
    );
  }
  return value as PatchExportV2ProjectFixture;
}

function projectFixtureToBridgeView(project: PatchExportV2ProjectFixture): SourceBridgeView {
  const allowedKinds: ReadonlyArray<string> = [...PATCH_EXPORT_PROTECTED_SPAN_KINDS];
  const allowedRules: ReadonlyArray<string> = [...PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULES];
  const units: SourceBridgeUnit[] = project.units.map((unit) => {
    const protectedSpans = (unit.protectedSpans ?? []).map((span) => {
      if (!allowedKinds.includes(span.kind)) {
        throw new Error(
          `export-patch-v2 project fixture: protected span ${span.spanRef} has unknown kind '${span.kind}'`,
        );
      }
      if (!allowedRules.includes(span.preservationRule)) {
        throw new Error(
          `export-patch-v2 project fixture: protected span ${span.spanRef} has unknown preservationRule '${span.preservationRule}'`,
        );
      }
      const out: SourceBridgeUnit["protectedSpans"][number] = {
        spanRef: span.spanRef,
        sourceStart: span.sourceStart,
        sourceEnd: span.sourceEnd,
        sourceText: span.sourceText,
        kind: span.kind as SourceBridgeUnit["protectedSpans"][number]["kind"],
        preservationRule:
          span.preservationRule as SourceBridgeUnit["protectedSpans"][number]["preservationRule"],
      };
      if (span.expectedTargetForm !== undefined) {
        out.expectedTargetForm = span.expectedTargetForm;
      }
      return out;
    });
    const sbu: SourceBridgeUnit = {
      sourceUnitId: unit.sourceUnitId,
      sourceText: unit.sourceText,
      sourceUnitHash: unit.sourceUnitHash,
      assetRefs: unit.assetRefs ?? [],
      protectedSpans,
    };
    if (unit.glossaryTerms !== undefined) {
      sbu.glossaryTerms = unit.glossaryTerms;
    }
    return sbu;
  });
  return {
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    sourceBridgeHash: project.sourceBridgeHash,
    targetLocale: project.targetLocale,
    units,
  };
}
