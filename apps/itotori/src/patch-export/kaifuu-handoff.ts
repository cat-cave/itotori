// ITOTORI-025 — Kaifuu handoff helper.
//
// Pure data transformation from a `PatchExportBundle` into the
// payload shape Kaifuu's `patch` command expects. Kaifuu must never
// see itotori-internal types (engine leakage in reverse): only the
// engine-agnostic patch instructions per unit and a small provenance
// header.
//
// The actual write goes through `cargo run -p kaifuu-cli -- patch ...`
// by a caller that owns the emitted artifact — this module only assembles JSON.
// Kaifuu invocation remains downstream and out of scope for ITOTORI-025 (the
// roadmap node is itotori-side).

import type {
  PatchExportAssetDecision,
  PatchExportBundle,
  PatchExportDraft,
  ProtectedSpanMapping,
} from "@itotori/localization-bridge-schema";

export type KaifuuPatchUnit = {
  sourceUnitId: string;
  sourceText: string;
  draftText: string;
  protectedSpanMappings: ProtectedSpanMapping[];
};

export type KaifuuPatchAssetDirective = {
  assetRef: string;
  assetKind: string;
  policy: PatchExportAssetDecision["policy"];
  rationale?: string;
};

export type KaifuuPatchPayload = {
  schemaVersion: "itotori.patch-export-bundle.v3";
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceBridgeHash: string;
  units: KaifuuPatchUnit[];
  assetDirectives: KaifuuPatchAssetDirective[];
  provenance: {
    draftArtifactBundleId: string;
    exportedAt: string;
    exportedByUserId: string;
    agreedQaScore?: number;
  };
};

export function prepareKaifuuPatchPayload(bundle: PatchExportBundle): KaifuuPatchPayload {
  const out: KaifuuPatchPayload = {
    schemaVersion: bundle.schemaVersion,
    projectId: bundle.projectId,
    localeBranchId: bundle.localeBranchId,
    targetLocale: bundle.targetLocale,
    sourceBridgeHash: bundle.sourceBridgeHash,
    units: bundle.drafts.map(toUnit),
    assetDirectives: bundle.assetDecisions.map(toAssetDirective),
    provenance: {
      draftArtifactBundleId: bundle.provenance.draftArtifactBundleId,
      exportedAt: bundle.provenance.exportedAt,
      exportedByUserId: bundle.provenance.exportedByUserId,
    },
  };
  if (bundle.provenance.agreedQaScore !== undefined) {
    out.provenance.agreedQaScore = bundle.provenance.agreedQaScore;
  }
  return out;
}

function toUnit(draft: PatchExportDraft): KaifuuPatchUnit {
  return {
    sourceUnitId: draft.sourceUnitId,
    sourceText: draft.sourceText,
    draftText: draft.draftText,
    protectedSpanMappings: draft.protectedSpanMappings.map((mapping) => ({ ...mapping })),
  };
}

function toAssetDirective(decision: PatchExportAssetDecision): KaifuuPatchAssetDirective {
  const out: KaifuuPatchAssetDirective = {
    assetRef: decision.assetRef,
    assetKind: decision.assetKind,
    policy: decision.policy,
  };
  if (decision.rationale !== undefined) {
    out.rationale = decision.rationale;
  }
  return out;
}
