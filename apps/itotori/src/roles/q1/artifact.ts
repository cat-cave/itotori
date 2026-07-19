// Persistable audit artifact for a Q1 meaning review.
//
// A review verdict remains the narrow workflow signal consumed by the repair
// join.  In parallel, Q1 records its judgment as a provisional `translation`
// WikiObject that preserves the reviewed DraftBatch unchanged, carries precise
// bible dependencies, and turns the verdict's evidence ids into snapshot-owned
// claim citations.  The artifact gives review work the same immutable,
// provenance-bearing history as the draft it judged without letting a reviewer
// mutate the target text.

import {
  WikiObjectSchema,
  type Claim,
  type DependencyRef,
  type DraftBatch,
  type RunModeValue,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import type { Q1ReviewInput, Q1SourceFact } from "./inputs.js";
import type { Q1Interpretation } from "./verdict.js";

export type Q1ReviewArtifact = Extract<WikiObject, { kind: "translation" }>;

/** The workflow-owned material Q1 records but must never invent. */
export interface Q1ArtifactContext {
  /** The exact batch that contained the candidate under review. */
  readonly candidateBatch: DraftBatch;
  /** Fine-grained bible/claim dependencies resolved for this unit by RB-031. */
  readonly dependencies: readonly DependencyRef[];
  /** The immutable snapshot that re-proves every cited claim before emission. */
  readonly validationModel: ReadModel;
  readonly runMode: RunModeValue;
  readonly contextScope: "whole-game" | "external-augmented" | `narrowed:${string}`;
  /** The physical Q1 call's memo key, stamped after dispatch rather than
   * exposed in the blinded prompt. */
  readonly authorMemoKey: string;
}

export class Q1ArtifactError extends Error {
  constructor(
    readonly code:
      | "candidate-not-in-batch"
      | "candidate-text-drift"
      | "snapshot-mismatch"
      | "missing-bible-dependency"
      | "unresolved-evidence",
    detail: string,
  ) {
    super(`Q1 artifact ${code}: ${detail}`);
    this.name = "Q1ArtifactError";
  }
}

function citedSourceFacts(
  input: Q1ReviewInput,
  evidenceIds: readonly string[],
): readonly Q1SourceFact[] {
  const byId = new Map(input.sourceFacts.map((fact) => [fact.factId, fact]));
  return evidenceIds.map((evidenceId) => {
    const fact = byId.get(evidenceId);
    if (!fact) {
      throw new Q1ArtifactError(
        "unresolved-evidence",
        `review cites ${evidenceId}, which was not in Q1's grounded source facts`,
      );
    }
    return fact;
  });
}

function claimKind(interpretation: Q1Interpretation): Claim["kind"] {
  return interpretation.verdict.category === "register" ? "style" : "subtext";
}

function claimStatement(interpretation: Q1Interpretation): string {
  const verdict = interpretation.verdict;
  if (verdict.verdict === "PASS") {
    return `Q1 meaning review found the candidate for ${verdict.unitId} preserves the grounded meaning.`;
  }
  if (verdict.verdict === "FAIL") {
    return `Q1 meaning review found a ${verdict.severity} ${verdict.category} defect in ${verdict.unitId}.`;
  }
  return `Q1 meaning review could not assess ${verdict.unitId} from the available evidence.`;
}

function claimFor(input: Q1ReviewInput, interpretation: Q1Interpretation): Claim | null {
  const verdict = interpretation.verdict;
  // A CANNOT_ASSESS may legitimately have no evidence ids.  It remains a typed,
  // provisional artifact, but we never fabricate a factual claim just to fill
  // the claims array.
  if (verdict.evidenceIds.length === 0) return null;
  return {
    claimId: `claim:${verdict.reviewId}`,
    statement: claimStatement(interpretation),
    scope: input.reviewScope,
    kind: claimKind(interpretation),
    confidence: verdict.verdict === "PASS" ? "high" : verdict.verdict === "FAIL" ? "medium" : "low",
    citations: citedSourceFacts(input, verdict.evidenceIds).map((fact) => ({
      evidenceId: fact.factId,
      evidenceHash: fact.evidence.evidenceHash,
      snapshotId: fact.evidence.snapshotId,
      subject: fact.evidence.subject,
      role: "supports" as const,
      playOrderIndex: fact.evidence.playOrderIndex,
    })),
  };
}

function assertCandidatePreserved(input: Q1ReviewInput, context: Q1ArtifactContext): void {
  if (context.candidateBatch.localizationSnapshotId !== input.localizationSnapshotId) {
    throw new Q1ArtifactError("snapshot-mismatch", "candidate batch is from another localization");
  }
  const candidate = context.candidateBatch.drafts.find((draft) => draft.unitId === input.unitId);
  if (!candidate) {
    throw new Q1ArtifactError(
      "candidate-not-in-batch",
      `batch ${context.candidateBatch.batchId} has no draft for ${input.unitId}`,
    );
  }
  if (candidate.targetSkeleton !== input.candidateTarget) {
    throw new Q1ArtifactError(
      "candidate-text-drift",
      "review artifact must preserve the exact candidate text, placeholders, and encoding surface",
    );
  }
  if (context.validationModel.snapshotId !== input.contextSnapshotId) {
    throw new Q1ArtifactError("snapshot-mismatch", "validation model is not Q1's context snapshot");
  }
}

function assertBibleDependencies(input: Q1ReviewInput, context: Q1ArtifactContext): void {
  const resolved = new Set(
    context.dependencies.flatMap((dependency) =>
      dependency.renderingId === null ? [] : [dependency.renderingId],
    ),
  );
  for (const renderingId of input.bibleRenderingIds) {
    if (!resolved.has(renderingId)) {
      throw new Q1ArtifactError(
        "missing-bible-dependency",
        `reviewed translation did not record consumed bible rendering ${renderingId}`,
      );
    }
  }
}

/**
 * Assemble and independently re-prove a Q1 review artifact. The reviewed
 * DraftBatch is copied verbatim, so a reviewer has no code path that can alter
 * protected spans, SJIS text, or any other target bytes while recording its
 * meaning judgment.
 */
export function assembleQ1ReviewArtifact(
  input: Q1ReviewInput,
  interpretation: Q1Interpretation,
  context: Q1ArtifactContext,
): Q1ReviewArtifact {
  assertCandidatePreserved(input, context);
  assertBibleDependencies(input, context);
  const claim = claimFor(input, interpretation);
  const object = WikiObjectSchema.parse({
    schemaVersion: "itotori.wiki-object.v1",
    objectId: `translation-review:${interpretation.verdict.reviewId}`,
    version: 1,
    lang: input.targetLanguage,
    subject: { kind: "unit", id: input.unitId },
    scope: input.reviewScope,
    claims: claim === null ? [] : [claim],
    media: [],
    dependencies: [...context.dependencies],
    provisional: true,
    kind: "translation",
    body: { draftBatch: context.candidateBatch },
    provenance: {
      snapshotKind: "localization",
      contextSnapshotId: input.contextSnapshotId,
      localizationSnapshotId: input.localizationSnapshotId,
      contextScope: context.contextScope,
      runMode: context.runMode,
      authorRoleId: "Q1",
      authorMemoKey: context.authorMemoKey,
    },
  });
  if (object.kind !== "translation") {
    throw new Q1ArtifactError("candidate-text-drift", "Q1 emitted a non-translation WikiObject");
  }
  validateWikiObjectClaims(object, context.validationModel);
  return object;
}
