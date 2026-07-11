// ITOTORI-025 — PatchExportPreflight.
//
// Deterministic check battery the patch-export service runs before it
// emits a `PatchExportBundle`. Each check is a discrete method that
// returns a `PreflightResult`; the public `runAll` runs them in a
// fixed order and surfaces the result list.
//
// Blocking vs warning:
//
//   - sourceBridgeIntegrity, noUnresolvedAssetDecisions,
//     allDraftsAccepted, protectedSpanCoverage   → blocking (fail);
//   - qaScoreThreshold, glossaryConsistency       → warning (warn).
//
// The exporter treats any `blockingExport: true` failure as a hard
// stop — no bundle is produced.

import type {
  DraftArtifactBundle,
  PatchExportPreflightCheckKind,
  PreflightResult,
} from "@itotori/localization-bridge-schema";
import type { AssetPolicyResolution } from "../asset-decisions/policy-resolver.js";
import type {
  SourceBridgeAssetRef,
  SourceBridgeUnit,
  SourceBridgeView,
} from "./source-bridge-view.js";

/**
 * Minimal-shape projection of a QA score report. The full scored
 * findings report from ITOTORI-021 is not integrated yet (the task
 * spec calls this out explicitly). When present, the preflight asserts
 * `overall >= threshold`; when absent, the check passes with status
 * `pass` and `detail: 'no_report_provided'`.
 */
export type ScoredFindingsReport = {
  overall: number;
};

export type PreflightAssetResolutionLookup = (
  assetRef: SourceBridgeAssetRef,
) => Promise<AssetPolicyResolution>;

export type PreflightInput = {
  draftArtifactBundle: DraftArtifactBundle;
  sourceBridgeView: SourceBridgeView;
  /**
   * Hash the exporter wants to embed in the patch-export bundle (the
   * caller's `sourceBridgeHash`). The integrity check fails when this
   * does not match `sourceBridgeView.sourceBridgeHash`.
   */
  declaredSourceBridgeHash: string;
  resolveAssetPolicy: PreflightAssetResolutionLookup;
  scoredFindingsReport?: ScoredFindingsReport;
  /**
   * Optional glossary-resolution map keyed by termId, where each entry
   * names how each draft rendered the term. Empty / missing → check
   * warns with `no_glossary_records`.
   */
  draftGlossaryRenderings?: ReadonlyArray<DraftGlossaryRendering>;
};

export type DraftGlossaryRendering = {
  termId: string;
  sourceUnitId: string;
  renderedTargetForm: string;
};

export type PatchExportPreflightDeps = {
  /**
   * Threshold for the `qaScoreThreshold` check. Defaults to 0.7 per
   * spec. Configurable to support per-locale calibration.
   */
  qaScoreThreshold?: number;
};

const DEFAULT_QA_SCORE_THRESHOLD = 0.7;

export class PatchExportPreflight {
  private readonly minQaScore: number;

  constructor(deps: PatchExportPreflightDeps = {}) {
    this.minQaScore = deps.qaScoreThreshold ?? DEFAULT_QA_SCORE_THRESHOLD;
  }

  async runAll(input: PreflightInput): Promise<PreflightResult[]> {
    const results: PreflightResult[] = [];
    results.push(this.sourceBridgeIntegrity(input));
    results.push(await this.noUnresolvedAssetDecisions(input));
    results.push(this.allDraftsAccepted(input));
    results.push(this.protectedSpanCoverage(input));
    results.push(this.qaScoreThreshold(input));
    results.push(this.glossaryConsistency(input));
    return results;
  }

  // -------------------------------------------------------------------------
  // Blocking checks
  // -------------------------------------------------------------------------

  sourceBridgeIntegrity(input: PreflightInput): PreflightResult {
    const check: PatchExportPreflightCheckKind = "sourceBridgeIntegrity";
    if (input.declaredSourceBridgeHash === input.sourceBridgeView.sourceBridgeHash) {
      return passing(check, "source_bridge_hash_matches");
    }
    return blockingFail(
      check,
      `declared sourceBridgeHash '${input.declaredSourceBridgeHash}' does not match current bridge hash '${input.sourceBridgeView.sourceBridgeHash}'; the draft bundle is stale`,
    );
  }

  async noUnresolvedAssetDecisions(input: PreflightInput): Promise<PreflightResult> {
    const check: PatchExportPreflightCheckKind = "noUnresolvedAssetDecisions";
    const seen = new Set<string>();
    const unresolved: string[] = [];
    for (const unit of input.sourceBridgeView.units) {
      for (const assetRef of unit.assetRefs) {
        const key = `${assetRef.kind}:${assetRef.ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const resolution = await input.resolveAssetPolicy(assetRef);
        if (resolution.policy === "unresolved") {
          unresolved.push(key);
        }
      }
    }
    if (unresolved.length === 0) {
      return passing(check, "all_referenced_assets_resolved");
    }
    return blockingFail(check, `unresolved asset decisions: ${unresolved.sort().join(", ")}`);
  }

  allDraftsAccepted(input: PreflightInput): PreflightResult {
    const check: PatchExportPreflightCheckKind = "allDraftsAccepted";
    const terminallyRejected = input.draftArtifactBundle.drafts.filter(
      (draft) => draft.retryFallbackState === "terminal-rejection",
    );
    if (terminallyRejected.length === 0) {
      return passing(check, "no_terminal_rejections");
    }
    const ids = terminallyRejected.map((draft) => draft.sourceUnitId).sort();
    return blockingFail(
      check,
      `${terminallyRejected.length} draft(s) terminally rejected: ${ids.join(", ")}`,
    );
  }

  protectedSpanCoverage(input: PreflightInput): PreflightResult {
    const check: PatchExportPreflightCheckKind = "protectedSpanCoverage";
    const draftsBySource = indexDraftsBySource(input.draftArtifactBundle);
    const missing: string[] = [];
    for (const unit of input.sourceBridgeView.units) {
      const draft = draftsBySource.get(unit.sourceUnitId);
      if (draft === undefined) {
        // The exporter only emits drafts that exist in the artifact
        // bundle — a source unit with no draft means coverage failed
        // upstream (allDraftsAccepted should also catch this when the
        // draft is terminal). We surface it explicitly so the operator
        // sees both signals.
        for (const span of unit.protectedSpans) {
          if (span.outOfBand) continue;
          missing.push(`${unit.sourceUnitId}:${span.spanRef}:no_draft`);
        }
        continue;
      }
      const draftText = draft.draftText ?? "";
      for (const span of unit.protectedSpans) {
        if (span.outOfBand) continue;
        if (!spanIsCovered(span, draftText)) {
          missing.push(`${unit.sourceUnitId}:${span.spanRef}`);
        }
      }
    }
    if (missing.length === 0) {
      return passing(check, "every_protected_span_present_in_draft");
    }
    return blockingFail(check, `protected spans missing from drafts: ${missing.sort().join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Warning checks (non-blocking)
  // -------------------------------------------------------------------------

  qaScoreThreshold(input: PreflightInput): PreflightResult {
    const check: PatchExportPreflightCheckKind = "qaScoreThreshold";
    if (input.scoredFindingsReport === undefined) {
      return {
        check,
        status: "warn",
        detail: "no_report_provided",
        blockingExport: false,
      };
    }
    const overall = input.scoredFindingsReport.overall;
    if (overall >= this.minQaScore) {
      return passing(check, `overall_score_${overall}_meets_${this.minQaScore}`);
    }
    return {
      check,
      status: "warn",
      detail: `overall_score_${overall}_below_${this.minQaScore}`,
      blockingExport: false,
    };
  }

  glossaryConsistency(input: PreflightInput): PreflightResult {
    const check: PatchExportPreflightCheckKind = "glossaryConsistency";
    const renderings = input.draftGlossaryRenderings ?? [];
    if (renderings.length === 0) {
      return {
        check,
        status: "warn",
        detail: "no_glossary_records",
        blockingExport: false,
      };
    }
    const byTerm = new Map<string, Set<string>>();
    for (const entry of renderings) {
      const existing = byTerm.get(entry.termId);
      if (existing === undefined) {
        byTerm.set(entry.termId, new Set([entry.renderedTargetForm]));
      } else {
        existing.add(entry.renderedTargetForm);
      }
    }
    const inconsistent: string[] = [];
    for (const [termId, forms] of byTerm.entries()) {
      if (forms.size > 1) {
        const formsList = [...forms].sort().join("|");
        inconsistent.push(`${termId}=>{${formsList}}`);
      }
    }
    if (inconsistent.length === 0) {
      return passing(check, "every_glossary_term_consistent");
    }
    return {
      check,
      status: "warn",
      detail: `inconsistent glossary renderings: ${inconsistent.sort().join(", ")}`,
      blockingExport: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passing(check: PatchExportPreflightCheckKind, detail: string): PreflightResult {
  return {
    check,
    status: "pass",
    detail,
    blockingExport: false,
  };
}

function blockingFail(check: PatchExportPreflightCheckKind, detail: string): PreflightResult {
  return {
    check,
    status: "fail",
    detail,
    blockingExport: true,
  };
}

function indexDraftsBySource(
  bundle: DraftArtifactBundle,
): Map<string, DraftArtifactBundle["drafts"][number]> {
  const map = new Map<string, DraftArtifactBundle["drafts"][number]>();
  for (const draft of bundle.drafts) {
    map.set(draft.sourceUnitId, draft);
  }
  return map;
}

/**
 * A span is covered when its expected target form appears in the
 * draft. For verbatim spans (variables, markup, source_unit) the
 * source text IS the expected target form — they must reappear
 * unchanged. For glossary spans the documented `expectedTargetForm`
 * is the expected draft rendering (e.g. "Hero" for 勇者).
 *
 * This is the minimum-viable detection that catches the
 * `span_deleted` case; tighter draft-side position validation is done
 * by the per-draft `protectedSpanMappings` builder in the exporter.
 */
function spanIsCovered(
  span: SourceBridgeUnit["protectedSpans"][number],
  draftText: string,
): boolean {
  const expected = expectedDraftText(span);
  return draftText.includes(expected);
}

function expectedDraftText(span: SourceBridgeUnit["protectedSpans"][number]): string {
  if (span.kind === "glossary" && span.expectedTargetForm !== undefined) {
    return span.expectedTargetForm;
  }
  return span.sourceText;
}
