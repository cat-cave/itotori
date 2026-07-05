// UTSUSHI-011 — Runtime-evidence triage integration.
//
// Runtime-evidence findings reach the HITL path two complementary ways:
//
//   1. `runtimeEvidenceFindingsToHumanFindings` → the deterministic
//      `FindingTriageRouter`. Every runtime finding routes to the
//      `runtime_evidence` root cause (attribution='runtime'), so the
//      orchestrator's existing router classifies them with no new plumbing.
//
//   2. `buildRuntimeEvidenceReviewerQueueItem` → a `runtimeEvidence`
//      reviewer-queue item. The finding CITATIONS (managed artifact refs) are
//      carried verbatim into the queue's `artifactHashes` +
//      `affectedArtifactIds`, and the cited trace/branch/observation event ids
//      into `observationEventIds` — satisfying the runtime-evidence item
//      invariant (evidenceTier + observation refs + artifact hashes) that the
//      repository enforces before any reviewer transition.
//
// Findings cite trace-only, screenshot-backed, or BOTH — all through managed
// refs — and both integrations preserve that provenance.

import type { AuthorizationActor, CreateReviewerQueueItemInput } from "@itotori/db";
import { reviewerQueueItemKindValues } from "@itotori/db";
import type { Uuid7 } from "@itotori/localization-bridge-schema";
import type { HumanFinding, HumanFindingSeverity } from "../../triage/human-finding.js";
import type { RuntimeEvidenceFinding } from "./shapes.js";

const RUNTIME_EVIDENCE_DECISION_RECORD_SCHEMA_VERSION =
  "itotori.runtime-evidence-decision-record.v1" as const;

/** Map runtime-evidence findings onto human findings for the triage router. */
export function runtimeEvidenceFindingsToHumanFindings(
  findings: ReadonlyArray<RuntimeEvidenceFinding>,
  options: { now?: () => Date } = {},
): HumanFinding[] {
  const recordedAt = options.now?.() ?? new Date(0);
  return findings.map((finding) => {
    const human: HumanFinding = {
      findingId: finding.findingId as Uuid7,
      attribution: "runtime",
      severity: finding.severity satisfies HumanFindingSeverity,
      category: finding.findingKind,
      summary: finding.message,
      recordedAt,
    };
    if (finding.bridgeUnitId !== null) {
      human.bridgeUnitId = finding.bridgeUnitId as Uuid7;
    }
    return human;
  });
}

export type RuntimeEvidenceReviewerQueueInput = {
  actor: AuthorizationActor;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  runtimeReportId: string;
  evidenceTier: string;
  findings: ReadonlyArray<RuntimeEvidenceFinding>;
  now?: () => Date;
};

/** Deterministic idempotency key for the runtime-report's decision. */
export function runtimeEvidenceSourceItemRef(runtimeReportId: string): string {
  return `runtime-evidence:${runtimeReportId}`;
}

/**
 * Build the `runtimeEvidence` reviewer-queue item from a set of findings.
 * Pure — no I/O — so the caller persists it through the real repository (or a
 * test fake). Derives the runtime-evidence invariants from the citations:
 *   - artifactHashes      ← every distinct cited managed-artifact hash
 *   - observationEventIds ← every distinct cited trace/branch/observation id
 *   - affectedArtifactIds ← every distinct cited artifact id + bridge unit id
 */
export function buildRuntimeEvidenceReviewerQueueItem(
  input: RuntimeEvidenceReviewerQueueInput,
): CreateReviewerQueueItemInput {
  const artifactHashes = new Set<string>();
  const observationEventIds = new Set<string>();
  const affectedArtifactIds = new Set<string>();

  for (const finding of input.findings) {
    if (finding.bridgeUnitId !== null) {
      affectedArtifactIds.add(finding.bridgeUnitId);
    }
    for (const citation of finding.citations) {
      affectedArtifactIds.add(citation.artifactRef.artifactId);
      if (citation.artifactRef.hash !== null) {
        artifactHashes.add(citation.artifactRef.hash);
      }
      if (citation.observationEventId !== null) {
        observationEventIds.add(citation.observationEventId);
      }
    }
  }

  const blocking = input.findings.filter((finding) => finding.findingKind !== "ocr_hint");
  const summary = `Runtime-evidence QA flagged ${blocking.length} finding(s) on runtime report ${input.runtimeReportId}`;

  const decisionRecord: Record<string, unknown> = {
    schemaVersion: RUNTIME_EVIDENCE_DECISION_RECORD_SCHEMA_VERSION,
    runtimeReportId: input.runtimeReportId,
    evidenceTier: input.evidenceTier,
    findings: input.findings.map((finding) => ({
      findingId: finding.findingId,
      findingKind: finding.findingKind,
      severity: finding.severity,
      detectorKind: finding.detectorKind,
      bridgeUnitId: finding.bridgeUnitId,
      sourceUnitKey: finding.sourceUnitKey,
      message: finding.message,
      expected: finding.expected,
      observed: finding.observed,
      evidenceBacking: finding.evidenceBacking,
      citations: finding.citations.map((citation) => ({
        citationKind: citation.citationKind,
        artifactId: citation.artifactRef.artifactId,
        artifactKind: citation.artifactRef.artifactKind,
        uri: citation.artifactRef.uri,
        hash: citation.artifactRef.hash,
        observationEventId: citation.observationEventId,
        detail: citation.detail,
      })),
    })),
    options: [
      { optionId: "confirm", label: "Confirm the runtime issue", action: "approve" },
      { optionId: "dismiss", label: "Dismiss as acceptable", action: "reject" },
      { optionId: "escalate", label: "Escalate for senior review", action: "escalate" },
    ],
  };

  const createInput: CreateReviewerQueueItemInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    itemKind: reviewerQueueItemKindValues.runtimeEvidence,
    sourceItemRef: runtimeEvidenceSourceItemRef(input.runtimeReportId),
    summary,
    affectedArtifactIds: [...affectedArtifactIds].sort(),
    priority: blocking.length > 0 ? 10 : 3,
    evidenceTier: input.evidenceTier,
    observationEventIds: [...observationEventIds].sort(),
    artifactHashes: [...artifactHashes].sort(),
    payload: {
      source: "runtime_evidence_qa",
      runtimeReportId: input.runtimeReportId,
      decisionRecord,
    },
    metadata: {
      source: "runtime_evidence_qa",
      runtimeReportId: input.runtimeReportId,
      findingCount: input.findings.length,
      blockingFindingCount: blocking.length,
    },
    createdByUserId: input.actor.userId,
    ...(input.now !== undefined ? { createdAt: input.now() } : {}),
  };
  return createInput;
}
