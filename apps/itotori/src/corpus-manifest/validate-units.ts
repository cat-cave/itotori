import type { CorpusValidationEvidenceConventions } from "./corpus-validation-registry.js";
import {
  stableJson,
  type CorpusOutputScope,
  type CorpusUnit,
  type FileFingerprint,
  type OrdinalRange,
  type ProtectedSkeleton,
  type ProtectedSpanPart,
  type RedactedTextPart,
  type Sha256,
} from "./manifest.js";
import {
  array,
  assertExactKeys,
  integer,
  metadataString,
  nonNegativeInteger,
  nullableNativeString,
  positiveInteger,
  record,
  sha256,
  type JsonRecord,
} from "./validate-primitives.js";

const UUID7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function validateUnit(
  value: JsonRecord,
  label: string,
  sceneId: number,
  ordinalRange: OrdinalRange,
  dispatchIndex: number,
  evidence: CorpusValidationEvidenceConventions,
): CorpusUnit {
  assertExactKeys(
    value,
    [
      "bridgeUnitId",
      "sourceUnitKey",
      "occurrenceId",
      "surfaceKind",
      "sourceHash",
      "sourceRevision",
      "byteLocation",
      "protectedSkeleton",
      "route",
      "sceneMembership",
      "replayTarget",
    ],
    label,
  );
  const bridgeUnitId = metadataString(value.bridgeUnitId, `${label}.bridgeUnitId`);
  if (!UUID7_PATTERN.test(bridgeUnitId)) {
    throw new Error("private corpus unit id is not UUIDv7 metadata");
  }
  const ordinal = ordinalFromUnitKey(
    metadataString(value.sourceUnitKey, `${label}.sourceUnitKey`),
    sceneId,
    ordinalRange,
    evidence,
  );
  const occurrenceId = metadataString(value.occurrenceId, `${label}.occurrenceId`);
  if (occurrenceId !== evidence.occurrenceId(sceneId, ordinal)) {
    throw new Error("private corpus unit occurrence does not match its source ordinal");
  }
  if (metadataString(value.surfaceKind, `${label}.surfaceKind`) !== "dialogue") {
    throw new Error("private corpus scope contains a non-dialogue unit");
  }
  const sourceRevision = record(value.sourceRevision, `${label}.sourceRevision`);
  assertExactKeys(
    sourceRevision,
    ["revisionId", "revisionKind", "value"],
    `${label}.sourceRevision`,
  );
  const revisionId = metadataString(
    sourceRevision.revisionId,
    `${label}.sourceRevision.revisionId`,
  );
  if (
    !UUID7_PATTERN.test(revisionId) ||
    metadataString(sourceRevision.revisionKind, `${label}.sourceRevision.revisionKind`) !==
      "content_hash"
  ) {
    throw new Error("private corpus source revision metadata is invalid");
  }
  const byteLocation = validateByteLocation(
    record(value.byteLocation, `${label}.byteLocation`),
    label,
    sceneId,
    ordinal,
    evidence,
  );
  const protectedSkeleton = validateProtectedSkeleton(
    record(value.protectedSkeleton, `${label}.protectedSkeleton`),
    `${label}.protectedSkeleton`,
    byteLocation.range.endByte - byteLocation.range.startByte,
    evidence,
  );
  const route = record(value.route, `${label}.route`);
  assertExactKeys(route, ["sceneKey", "position"], `${label}.route`);
  if (
    stableJson({
      sceneKey: metadataString(route.sceneKey, `${label}.route.sceneKey`),
      position: metadataString(route.position, `${label}.route.position`),
    }) !== stableJson(evidence.route(sceneId, ordinal))
  ) {
    throw new Error("private corpus unit route does not match its source ordinal");
  }
  const membership = record(value.sceneMembership, `${label}.sceneMembership`);
  assertExactKeys(membership, ["sceneId", "structureDispatchIndex"], `${label}.sceneMembership`);
  if (
    nonNegativeInteger(membership.sceneId, `${label}.sceneMembership.sceneId`) !== sceneId ||
    nonNegativeInteger(
      membership.structureDispatchIndex,
      `${label}.sceneMembership.structureDispatchIndex`,
    ) !== dispatchIndex
  ) {
    throw new Error("private corpus unit scene membership drifted");
  }
  const replayTarget = record(value.replayTarget, `${label}.replayTarget`);
  assertExactKeys(replayTarget, ["expectationKind", "traceKey"], `${label}.replayTarget`);
  const traceKey = metadataString(replayTarget.traceKey, `${label}.replayTarget.traceKey`);
  if (
    metadataString(replayTarget.expectationKind, `${label}.replayTarget.expectationKind`) !==
      "trace_text" ||
    (traceKey !== occurrenceId && !traceKey.startsWith(`${occurrenceId}#voice=`))
  ) {
    throw new Error("private corpus unit replay target drifted");
  }
  return {
    bridgeUnitId,
    sourceUnitKey: evidence.sourceUnitKey(sceneId, ordinal),
    occurrenceId,
    surfaceKind: "dialogue",
    sourceHash: sha256(value.sourceHash, `${label}.sourceHash`),
    sourceRevision: {
      revisionId,
      revisionKind: "content_hash",
      value: sha256(sourceRevision.value, `${label}.sourceRevision.value`),
    },
    byteLocation,
    protectedSkeleton,
    route: evidence.route(sceneId, ordinal),
    sceneMembership: { sceneId, structureDispatchIndex: dispatchIndex },
    replayTarget: { expectationKind: "trace_text", traceKey },
  };
}

function validateByteLocation(
  value: JsonRecord,
  label: string,
  sceneId: number,
  ordinal: string,
  evidence: CorpusValidationEvidenceConventions,
): CorpusUnit["byteLocation"] {
  assertExactKeys(value, ["containerKey", "entryPath", "range"], `${label}.byteLocation`);
  const entryPath = array(value.entryPath, `${label}.byteLocation.entryPath`).map((entry, index) =>
    metadataString(entry, `${label}.byteLocation.entryPath[${index}]`),
  );
  if (
    metadataString(value.containerKey, `${label}.byteLocation.containerKey`) !==
      evidence.containerKey(sceneId) ||
    stableJson(entryPath) !== stableJson(evidence.entryPath(sceneId, ordinal))
  ) {
    throw new Error("private corpus unit byte location does not match its source ordinal");
  }
  const range = record(value.range, `${label}.byteLocation.range`);
  assertExactKeys(range, ["startByte", "endByte"], `${label}.byteLocation.range`);
  const startByte = nonNegativeInteger(range.startByte, `${label}.byteLocation.range.startByte`);
  const endByte = nonNegativeInteger(range.endByte, `${label}.byteLocation.range.endByte`);
  if (endByte <= startByte) throw new Error("private corpus unit byte range is invalid");
  return { containerKey: evidence.containerKey(sceneId), entryPath, range: { startByte, endByte } };
}

function validateProtectedSkeleton(
  value: JsonRecord,
  label: string,
  decompressedLength: number,
  evidence: CorpusValidationEvidenceConventions,
): ProtectedSkeleton {
  assertExactKeys(
    value,
    [
      "format",
      "sourceEncoding",
      "sourceTextUtf8ByteLength",
      "decompressedSourceByteLength",
      "shell",
      "parts",
    ],
    label,
  );
  if (
    metadataString(value.format, `${label}.format`) !==
      "itotori.redacted-sjis-protected-shell.v1" ||
    metadataString(value.sourceEncoding, `${label}.sourceEncoding`) !== evidence.sourceEncoding
  ) {
    throw new Error("private corpus protected skeleton format is unsupported");
  }
  const sourceTextUtf8ByteLength = positiveInteger(
    value.sourceTextUtf8ByteLength,
    `${label}.sourceTextUtf8ByteLength`,
  );
  const decompressedSourceByteLength = positiveInteger(
    value.decompressedSourceByteLength,
    `${label}.decompressedSourceByteLength`,
  );
  if (decompressedSourceByteLength !== decompressedLength) {
    throw new Error("private corpus protected skeleton source length drifted");
  }
  const rawParts = array(value.parts, `${label}.parts`).map((part, index) =>
    record(part, `${label}.parts[${index}]`),
  );
  const parts: Array<RedactedTextPart | ProtectedSpanPart> = [];
  let cursor = 0;
  let expectedSpanIndex = 0;
  let protectedCount = 0;
  for (const [index, part] of rawParts.entries()) {
    const kind = metadataString(part.kind, `${label}.parts[${index}].kind`);
    const startByte = nonNegativeInteger(part.startByte, `${label}.parts[${index}].startByte`);
    const endByte = nonNegativeInteger(part.endByte, `${label}.parts[${index}].endByte`);
    const utf8ByteLength = nonNegativeInteger(
      part.utf8ByteLength,
      `${label}.parts[${index}].utf8ByteLength`,
    );
    if (startByte !== cursor || endByte < startByte || utf8ByteLength !== endByte - startByte) {
      throw new Error("private corpus protected skeleton parts are not contiguous");
    }
    cursor = endByte;
    if (kind === "redacted_text") {
      assertExactKeys(
        part,
        ["kind", "startByte", "endByte", "utf8ByteLength"],
        `${label}.parts[${index}]`,
      );
      parts.push({ kind: "redacted_text", startByte, endByte, utf8ByteLength });
      continue;
    }
    if (kind !== "protected_span") {
      throw new Error("private corpus protected skeleton has an unsupported part");
    }
    assertExactKeys(
      part,
      [
        "kind",
        "spanIndex",
        "spanKind",
        "parsedName",
        "startByte",
        "endByte",
        "utf8ByteLength",
        "rawSha256",
        "preserveMode",
        "outOfBand",
      ],
      `${label}.parts[${index}]`,
    );
    if (
      nonNegativeInteger(part.spanIndex, `${label}.parts[${index}].spanIndex`) !== expectedSpanIndex
    ) {
      throw new Error("private corpus protected skeleton span indexes are not consecutive");
    }
    expectedSpanIndex += 1;
    const parsedName = metadataString(part.parsedName, `${label}.parts[${index}].parsedName`);
    if (
      metadataString(part.spanKind, `${label}.parts[${index}].spanKind`) !== "control_markup" ||
      !evidence.protectedNames.includes(parsedName) ||
      metadataString(part.preserveMode, `${label}.parts[${index}].preserveMode`) !== "exact" ||
      part.outOfBand !== (parsedName === evidence.outOfBandProtectedName)
    ) {
      throw new Error("private corpus protected skeleton span metadata is invalid");
    }
    protectedCount += 1;
    parts.push({
      kind: "protected_span",
      spanIndex: expectedSpanIndex - 1,
      spanKind: "control_markup",
      parsedName,
      startByte,
      endByte,
      utf8ByteLength,
      rawSha256: sha256(part.rawSha256, `${label}.parts[${index}].rawSha256`),
      preserveMode: "exact",
      outOfBand: parsedName === evidence.outOfBandProtectedName,
    });
  }
  if (cursor !== sourceTextUtf8ByteLength || protectedCount === 0) {
    throw new Error("private corpus protected skeleton does not cover its source");
  }
  const shell = parts
    .map((part) =>
      part.kind === "redacted_text"
        ? `<REDACTED_TEXT:utf8=${part.utf8ByteLength}>`
        : `<PROTECTED:${part.parsedName ?? part.spanKind}:utf8=${part.utf8ByteLength}>`,
    )
    .join("");
  if (metadataString(value.shell, `${label}.shell`) !== shell) {
    throw new Error("private corpus protected skeleton shell drifted");
  }
  return {
    format: "itotori.redacted-sjis-protected-shell.v1",
    sourceEncoding: evidence.sourceEncoding,
    sourceTextUtf8ByteLength,
    decompressedSourceByteLength,
    shell,
    parts,
  };
}

export function assertExactOrdinals(
  units: CorpusUnit[],
  range: OrdinalRange,
  evidence: CorpusValidationEvidenceConventions,
): void {
  const actual = new Set(
    units.map((unit) =>
      ordinalFromUnitKey(unit.sourceUnitKey, unit.sceneMembership.sceneId, range, evidence),
    ),
  );
  // Each source key has already passed ordinalFromUnitKey, so it belongs to
  // this range. With the unit-count check above, a smaller set can only mean
  // a duplicate and a corresponding gap.
  if (actual.size !== ordinalCount(range)) {
    throw new Error("private corpus source ordinals must be the exact complete manifest range");
  }
}

function ordinalFromUnitKey(
  key: string,
  sceneId: number,
  range: OrdinalRange,
  evidence: CorpusValidationEvidenceConventions,
): string {
  const prefix = evidence.sourceUnitKey(sceneId, "");
  const ordinal = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (!new RegExp(`^\\d{${range.width}}$`, "u").test(ordinal)) {
    throw new Error("private corpus source unit key does not carry a canonical ordinal");
  }
  const numeric = Number(ordinal);
  if (numeric < range.start || numeric > range.end || formatOrdinal(numeric, range) !== ordinal) {
    throw new Error("private corpus source unit ordinal is outside its manifest range");
  }
  return ordinal;
}

function formatOrdinal(ordinal: number, range: OrdinalRange): string {
  return String(ordinal).padStart(range.width, "0");
}

export function ordinalCount(range: OrdinalRange): number {
  return range.end - range.start + 1;
}

export function validateBaseline(value: JsonRecord, outputScope: CorpusOutputScope): void {
  assertExactKeys(
    value,
    [
      "source",
      "reportSha256",
      "runId",
      "sceneId",
      "scopedUnitCount",
      "physicalAttempts",
      "unitsWritten",
      "finalizedPatchCount",
      "acceptedOutputsDiscarded",
      "retranslatedUnitCount",
      "failureMode",
    ],
    "manifest.failedRunBaseline",
  );
  metadataString(value.source, "manifest.failedRunBaseline.source");
  sha256(value.reportSha256, "manifest.failedRunBaseline.reportSha256");
  metadataString(value.runId, "manifest.failedRunBaseline.runId");
  metadataString(value.failureMode, "manifest.failedRunBaseline.failureMode");
  if (
    nonNegativeInteger(value.sceneId, "manifest.failedRunBaseline.sceneId") !==
      outputScope.sceneId ||
    positiveInteger(value.scopedUnitCount, "manifest.failedRunBaseline.scopedUnitCount") !==
      outputScope.bridge.unitCount
  ) {
    throw new Error("private corpus failed-run baseline scope drifted");
  }
  const attempts = positiveInteger(
    value.physicalAttempts,
    "manifest.failedRunBaseline.physicalAttempts",
  );
  const written = nonNegativeInteger(value.unitsWritten, "manifest.failedRunBaseline.unitsWritten");
  const finalized = nonNegativeInteger(
    value.finalizedPatchCount,
    "manifest.failedRunBaseline.finalizedPatchCount",
  );
  const discarded = nonNegativeInteger(
    value.acceptedOutputsDiscarded,
    "manifest.failedRunBaseline.acceptedOutputsDiscarded",
  );
  nonNegativeInteger(
    value.retranslatedUnitCount,
    "manifest.failedRunBaseline.retranslatedUnitCount",
  );
  if (written > attempts || finalized > written || discarded > attempts) {
    throw new Error("private corpus failed-run baseline counts are inconsistent");
  }
}

export function validateFingerprint(value: JsonRecord, label: string): FileFingerprint {
  assertExactKeys(value, ["sha256", "byteLength"], label);
  const byteLength = positiveInteger(value.byteLength, `${label}.byteLength`);
  return { sha256: sha256(value.sha256, `${label}.sha256`), byteLength };
}
