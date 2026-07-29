import { RUNTIME_EVIDENCE_TIERS_V02, TRIAGE_SEVERITIES, Uuid7 } from "./schema-domain-01.js";
import {
  CAUSAL_LINK_KINDS,
  CAUSAL_TARGET_KINDS,
  CausalTargetKindV02,
  EVIDENCE_KINDS,
  FINDING_KINDS,
  LOCALIZATION_QUALITY_CATEGORIES,
  PATCH_WRITE_MODES,
  PROVENANCE_KINDS,
  TRIAGE_SUBJECT_KINDS,
} from "./schema-domain-02.js";
import {
  CausalLinkV02,
  EvidenceRecordV02,
  FindingRecordV02,
  ProvenanceRecordV02,
  TriageActorV02,
  TriageArtifactRefV02,
  TriageBundleReferenceIndexV02,
  TriageEventV02,
  TriageSubjectRefV02,
  TriageTaskV02,
} from "./schema-domain-04.js";
import { assertAssetRefV02, assertSourceLocationV02 } from "./schema-domain-16.js";
import {
  asArray,
  asRecord,
  assertOptionalRfc3339Instant,
  assertOptionalString,
  assertRfc3339Instant,
  assertString,
  assertUuid7Array,
} from "./schema-domain-21.js";
import { assertEnum, assertOptionalUuid7, assertUuid7 } from "./schema-domain-22.js";

export function assertFindingRecordV02(
  value: unknown,
  label: string,
): asserts value is FindingRecordV02 {
  const finding = asRecord(value, label);
  assertUuid7(finding.findingId, `${label}.findingId`);
  assertEnum(finding.findingKind, FINDING_KINDS, `${label}.findingKind`);
  assertEnum(finding.severity, TRIAGE_SEVERITIES, `${label}.severity`);
  if (finding.qualityCategory !== undefined) {
    assertEnum(
      finding.qualityCategory,
      LOCALIZATION_QUALITY_CATEGORIES,
      `${label}.qualityCategory`,
    );
  }
  assertString(finding.title, `${label}.title`);
  assertString(finding.description, `${label}.description`);
  assertString(finding.impact, `${label}.impact`);
  assertRfc3339Instant(finding.createdAt, `${label}.createdAt`);
  assertOptionalUuid7(finding.reportedByTaskId, `${label}.reportedByTaskId`);
  assertOptionalUuid7(finding.firstSeenEventId, `${label}.firstSeenEventId`);
  assertTriageSubjectRefsV02(finding.affectedRefs, `${label}.affectedRefs`);
  assertEvidenceArrayV02(finding.evidence, `${label}.evidence`);
  assertProvenanceArrayV02(finding.provenance, `${label}.provenance`);
  assertCausalLinksV02(finding.causalLinks, `${label}.causalLinks`);
}

export function assertTriageActorV02(
  value: unknown,
  label: string,
): asserts value is TriageActorV02 {
  const actor = asRecord(value, label);
  assertEnum(actor.actorKind, ["human", "agent", "tool", "system"] as const, `${label}.actorKind`);
  assertOptionalUuid7(actor.actorId, `${label}.actorId`);
  assertOptionalString(actor.displayName, `${label}.displayName`);
}

export function assertTriageSubjectRefsV02(
  value: unknown,
  label: string,
): asserts value is TriageSubjectRefV02[] {
  const refs = asArray(value, label);
  for (const [index, ref] of refs.entries()) {
    assertTriageSubjectRefV02(ref, `${label}[${index}]`);
  }
}

export function assertTriageSubjectRefV02(
  value: unknown,
  label: string,
): asserts value is TriageSubjectRefV02 {
  const ref = asRecord(value, label);
  assertEnum(ref.subjectKind, TRIAGE_SUBJECT_KINDS, `${label}.subjectKind`);
  assertUuid7(ref.subjectId, `${label}.subjectId`);
  assertOptionalString(ref.label, `${label}.label`);
}

export function assertArtifactRefV02(
  value: unknown,
  label: string,
): asserts value is TriageArtifactRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertString(ref.artifactKind, `${label}.artifactKind`);
  assertOptionalString(ref.uri, `${label}.uri`);
  assertOptionalString(ref.hash, `${label}.hash`);
}

export function assertEvidenceArrayV02(
  value: unknown,
  label: string,
): asserts value is EvidenceRecordV02[] {
  const evidence = asArray(value, label);
  if (evidence.length === 0) {
    throw new Error(`${label} must contain at least one evidence record`);
  }
  for (const [index, record] of evidence.entries()) {
    assertEvidenceRecordV02(record, `${label}[${index}]`);
  }
}

export function assertEvidenceRecordV02(
  value: unknown,
  label: string,
): asserts value is EvidenceRecordV02 {
  const evidence = asRecord(value, label);
  assertUuid7(evidence.evidenceId, `${label}.evidenceId`);
  assertEnum(evidence.evidenceKind, EVIDENCE_KINDS, `${label}.evidenceKind`);
  assertString(evidence.summary, `${label}.summary`);
  if (evidence.subjectRef !== undefined) {
    assertTriageSubjectRefV02(evidence.subjectRef, `${label}.subjectRef`);
  }
  if (evidence.artifactRef !== undefined) {
    assertArtifactRefV02(evidence.artifactRef, `${label}.artifactRef`);
  }
  if (evidence.sourceLocation !== undefined) {
    assertSourceLocationV02(evidence.sourceLocation, `${label}.sourceLocation`);
  }
  assertOptionalString(evidence.expectedValue, `${label}.expectedValue`);
  assertOptionalString(evidence.observedValue, `${label}.observedValue`);
  assertUuid7Array(evidence.provenanceIds, `${label}.provenanceIds`);
}

export function assertProvenanceArrayV02(
  value: unknown,
  label: string,
): asserts value is ProvenanceRecordV02[] {
  const provenance = asArray(value, label);
  if (provenance.length === 0) {
    throw new Error(`${label} must contain at least one provenance record`);
  }
  for (const [index, record] of provenance.entries()) {
    assertProvenanceRecordV02(record, `${label}[${index}]`);
  }
}

export function assertProvenanceRecordV02(
  value: unknown,
  label: string,
): asserts value is ProvenanceRecordV02 {
  const provenance = asRecord(value, label);
  assertUuid7(provenance.provenanceId, `${label}.provenanceId`);
  assertEnum(provenance.provenanceKind, PROVENANCE_KINDS, `${label}.provenanceKind`);
  switch (provenance.provenanceKind) {
    case "source_annotation":
      assertUuid7(provenance.bridgeUnitId, `${label}.bridgeUnitId`);
      assertOptionalUuid7(provenance.spanId, `${label}.spanId`);
      if (provenance.sourceAssetRef !== undefined) {
        assertAssetRefV02(provenance.sourceAssetRef, `${label}.sourceAssetRef`);
      }
      if (provenance.sourceLocation !== undefined) {
        assertSourceLocationV02(provenance.sourceLocation, `${label}.sourceLocation`);
      }
      assertOptionalString(provenance.annotationText, `${label}.annotationText`);
      assertOptionalRfc3339Instant(provenance.observedAt, `${label}.observedAt`);
      break;
    case "style_guide":
      assertUuid7(provenance.styleGuideId, `${label}.styleGuideId`);
      assertUuid7(provenance.styleGuideVersionId, `${label}.styleGuideVersionId`);
      assertString(provenance.ruleId, `${label}.ruleId`);
      assertOptionalString(provenance.rulePath, `${label}.rulePath`);
      assertOptionalString(provenance.excerptHash, `${label}.excerptHash`);
      break;
    case "model_output":
      assertUuid7(provenance.modelOutputId, `${label}.modelOutputId`);
      assertOptionalUuid7(provenance.taskId, `${label}.taskId`);
      assertString(provenance.provider, `${label}.provider`);
      assertString(provenance.model, `${label}.model`);
      assertString(provenance.outputHash, `${label}.outputHash`);
      assertOptionalString(provenance.promptHash, `${label}.promptHash`);
      if (provenance.artifactRef !== undefined) {
        assertArtifactRefV02(provenance.artifactRef, `${label}.artifactRef`);
      }
      break;
    case "patching_cause":
      assertOptionalUuid7(provenance.patchResultId, `${label}.patchResultId`);
      assertOptionalUuid7(provenance.patchExportId, `${label}.patchExportId`);
      assertOptionalUuid7(provenance.bridgeUnitId, `${label}.bridgeUnitId`);
      if (provenance.assetRef !== undefined) {
        assertAssetRefV02(provenance.assetRef, `${label}.assetRef`);
      }
      if (provenance.writeMode !== undefined) {
        assertEnum(provenance.writeMode, PATCH_WRITE_MODES, `${label}.writeMode`);
      }
      assertOptionalString(provenance.failureCode, `${label}.failureCode`);
      assertOptionalString(provenance.failureDetail, `${label}.failureDetail`);
      if (provenance.patchResultId === undefined && provenance.patchExportId === undefined) {
        throw new Error(`${label} must include patchResultId or patchExportId`);
      }
      break;
    case "runtime_evidence":
      assertUuid7(provenance.runtimeReportId, `${label}.runtimeReportId`);
      assertOptionalUuid7(provenance.bridgeUnitId, `${label}.bridgeUnitId`);
      if (provenance.artifactRef !== undefined) {
        assertArtifactRefV02(provenance.artifactRef, `${label}.artifactRef`);
      }
      if (provenance.evidenceTier !== undefined) {
        assertEnum(provenance.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
      }
      break;
    case "human_review":
      assertOptionalUuid7(provenance.reviewerId, `${label}.reviewerId`);
      assertOptionalUuid7(provenance.reviewSessionId, `${label}.reviewSessionId`);
      assertString(provenance.noteHash, `${label}.noteHash`);
      break;
    case "deterministic_check":
      assertUuid7(provenance.checkId, `${label}.checkId`);
      assertString(provenance.checkName, `${label}.checkName`);
      assertString(provenance.checkVersion, `${label}.checkVersion`);
      if (provenance.artifactRef !== undefined) {
        assertArtifactRefV02(provenance.artifactRef, `${label}.artifactRef`);
      }
      break;
  }
}

export function assertCausalLinksV02(
  value: unknown,
  label: string,
): asserts value is CausalLinkV02[] {
  const links = asArray(value, label);
  for (const [index, link] of links.entries()) {
    assertCausalLinkV02(link, `${label}[${index}]`);
  }
}

export function assertCausalLinkV02(value: unknown, label: string): asserts value is CausalLinkV02 {
  const link = asRecord(value, label);
  assertUuid7(link.causalLinkId, `${label}.causalLinkId`);
  assertEnum(link.linkKind, CAUSAL_LINK_KINDS, `${label}.linkKind`);
  assertEnum(link.targetKind, CAUSAL_TARGET_KINDS, `${label}.targetKind`);
  assertUuid7(link.targetId, `${label}.targetId`);
  assertOptionalString(link.rationale, `${label}.rationale`);
}

export function assertEventLinksReferToPriorEvents(
  event: TriageEventV02,
  label: string,
  seenEventIds: ReadonlySet<Uuid7>,
): void {
  for (const [index, link] of event.causalLinks.entries()) {
    if (link.targetKind === "event" && !seenEventIds.has(link.targetId)) {
      throw new Error(`${label}.causalLinks[${index}].targetId must reference a prior event`);
    }
  }
}

export function buildTriageBundleReferenceIndexV02(
  events: readonly TriageEventV02[],
  tasks: readonly TriageTaskV02[],
  findings: readonly FindingRecordV02[],
): TriageBundleReferenceIndexV02 {
  const provenanceIds = new Set<Uuid7>();
  for (const event of events) {
    addProvenanceIdsV02(event.provenance, provenanceIds);
  }
  for (const task of tasks) {
    addProvenanceIdsV02(task.provenance, provenanceIds);
  }
  for (const finding of findings) {
    addProvenanceIdsV02(finding.provenance, provenanceIds);
  }

  return {
    eventIds: new Set(events.map((event) => event.eventId)),
    taskIds: new Set(tasks.map((task) => task.taskId)),
    findingIds: new Set(findings.map((finding) => finding.findingId)),
    provenanceIds,
  };
}

export function addProvenanceIdsV02(
  provenanceRecords: readonly ProvenanceRecordV02[],
  provenanceIds: Set<Uuid7>,
): void {
  for (const provenance of provenanceRecords) {
    provenanceIds.add(provenance.provenanceId);
  }
}

export function assertTriageBundleReferencesV02(
  events: readonly TriageEventV02[],
  tasks: readonly TriageTaskV02[],
  findings: readonly FindingRecordV02[],
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  for (const [index, event] of events.entries()) {
    const label = `TriageBundleV02.events[${index}]`;
    assertOptionalKnownReferenceV02(event.taskId, `${label}.taskId`, "task", referenceIndex);
    assertOptionalKnownReferenceV02(
      event.findingId,
      `${label}.findingId`,
      "finding",
      referenceIndex,
    );
    assertCausalLinkTargetsExistV02(event.causalLinks, `${label}.causalLinks`, referenceIndex);
  }

  for (const [index, task] of tasks.entries()) {
    const label = `TriageBundleV02.tasks[${index}]`;
    assertOptionalKnownReferenceV02(
      task.createdByEventId,
      `${label}.createdByEventId`,
      "event",
      referenceIndex,
    );
    assertCausalLinkTargetsExistV02(task.causalLinks, `${label}.causalLinks`, referenceIndex);
  }

  for (const [index, finding] of findings.entries()) {
    const label = `TriageBundleV02.findings[${index}]`;
    assertOptionalKnownReferenceV02(
      finding.reportedByTaskId,
      `${label}.reportedByTaskId`,
      "task",
      referenceIndex,
    );
    assertOptionalKnownReferenceV02(
      finding.firstSeenEventId,
      `${label}.firstSeenEventId`,
      "event",
      referenceIndex,
    );
    assertCausalLinkTargetsExistV02(finding.causalLinks, `${label}.causalLinks`, referenceIndex);
    assertFindingEvidenceProvenanceV02(finding, label, referenceIndex);
  }
}

export function assertOptionalKnownReferenceV02(
  id: Uuid7 | undefined,
  label: string,
  targetKind: CausalTargetKindV02,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  if (id !== undefined) {
    assertKnownTriageReferenceV02(id, label, targetKind, referenceIndex);
  }
}

export function assertCausalLinkTargetsExistV02(
  causalLinks: readonly CausalLinkV02[],
  label: string,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  for (const [index, link] of causalLinks.entries()) {
    assertKnownTriageReferenceV02(
      link.targetId,
      `${label}[${index}].targetId`,
      link.targetKind,
      referenceIndex,
    );
  }
}

export function assertKnownTriageReferenceV02(
  id: Uuid7,
  label: string,
  targetKind: CausalTargetKindV02,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  const targetIds = triageReferenceIdsForKindV02(targetKind, referenceIndex);
  if (!targetIds.has(id)) {
    throw new Error(`${label} must reference an existing triage ${targetKind}`);
  }
}

export function triageReferenceIdsForKindV02(
  targetKind: CausalTargetKindV02,
  referenceIndex: TriageBundleReferenceIndexV02,
): ReadonlySet<Uuid7> {
  switch (targetKind) {
    case "event":
      return referenceIndex.eventIds;
    case "task":
      return referenceIndex.taskIds;
    case "finding":
      return referenceIndex.findingIds;
  }
}

export function assertFindingEvidenceProvenanceV02(
  finding: FindingRecordV02,
  label: string,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  const findingProvenanceIds = new Set(finding.provenance.map((record) => record.provenanceId));
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    if (evidence.provenanceIds.length === 0) {
      throw new Error(`${evidenceLabel}.provenanceIds must contain at least one provenance id`);
    }
    for (const [provenanceIndex, provenanceId] of evidence.provenanceIds.entries()) {
      const provenanceLabel = `${evidenceLabel}.provenanceIds[${provenanceIndex}]`;
      if (!referenceIndex.provenanceIds.has(provenanceId)) {
        throw new Error(`${provenanceLabel} must reference provenance in TriageBundleV02`);
      }
      if (!findingProvenanceIds.has(provenanceId)) {
        throw new Error(`${provenanceLabel} must reference provenance on the same finding`);
      }
    }
  }
}
