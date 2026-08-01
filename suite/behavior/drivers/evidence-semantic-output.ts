import { readFileSync } from "node:fs";

import { digest, isRecord, type EvidenceRecord } from "./evidence-contract.js";
import { portableFile } from "./evidence-portability.js";

interface SemanticOutput {
  schema: "itotori.evidence-semantic-output.v2";
  caseId: string;
  scope: string;
  sourceRevision: string;
  projection: Record<string, unknown>;
  projectionCommitment: string;
  resultRevision: string;
}

export type SemanticResolution = { valid: true; commitment: string } | { valid: false };

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function semanticOutput(value: unknown): SemanticOutput | null {
  if (!isRecord(value) || value.schema !== "itotori.evidence-semantic-output.v2") return null;
  const keys = Object.keys(value).toSorted();
  if (
    keys.join("\0") !==
    [
      "caseId",
      "projection",
      "projectionCommitment",
      "resultRevision",
      "schema",
      "scope",
      "sourceRevision",
    ].join("\0")
  ) {
    return null;
  }
  const caseId = text(value.caseId);
  const scope = text(value.scope);
  const sourceRevision = text(value.sourceRevision);
  const projectionCommitment = text(value.projectionCommitment);
  const resultRevision = text(value.resultRevision);
  if (
    caseId === null ||
    scope === null ||
    sourceRevision === null ||
    !isRecord(value.projection) ||
    projectionCommitment === null ||
    resultRevision === null ||
    !/^[a-f0-9]{64}$/u.test(sourceRevision) ||
    projectionCommitment !==
      digest(`itotori.evidence-observed-projection.v1\0${stableJson(value.projection)}`) ||
    resultRevision !==
      digest(
        `itotori.evidence-semantic-result.v2\0${caseId}\0${scope}\0${sourceRevision}\0${projectionCommitment}`,
      )
  ) {
    return null;
  }
  return {
    schema: value.schema,
    caseId,
    scope,
    sourceRevision,
    projection: value.projection,
    projectionCommitment,
    resultRevision,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const item = isRecord(value) ? value : {};
  return `{${Object.keys(item)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`)
    .join(",")}}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function parsedArtifact(record: EvidenceRecord, bytes: Buffer): unknown {
  const content = bytes.toString("utf8");
  if (record.role === "evaluated") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        !isRecord(parsed) ||
        Object.keys(parsed).toSorted().join("\0") !==
          ["managedArtifact", "role", "schema", "semanticOutput"].join("\0") ||
        parsed.schema !== "itotori.evaluated-product-evidence.v4" ||
        parsed.role !== record.role ||
        !sameJson(parsed.managedArtifact, record.productProof.publishedRef)
      ) {
        return null;
      }
      return parsed.semanticOutput;
    } catch {
      return null;
    }
  }
  const prefix = "ITOTORI-INDEPENDENT-PRODUCT-EXPECTATION-V4\n";
  if (record.role !== "expectation" || !content.startsWith(prefix) || !content.endsWith("\n")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content.slice(prefix.length, -1));
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).toSorted().join("\0") !==
        ["managedArtifact", "semanticOutput"].join("\0") ||
      !sameJson(parsed.managedArtifact, record.productProof.publishedRef)
    ) {
      return null;
    }
    return parsed.semanticOutput;
  } catch {
    return null;
  }
}

export function resolveSemanticOutput(
  bundleRoot: string,
  record: EvidenceRecord,
): SemanticResolution {
  if (record.recordClass === "public-evidence" && !record.published) {
    return /^[a-f0-9]{64}$/u.test(record.semanticCommitment)
      ? { valid: true, commitment: record.semanticCommitment }
      : { valid: false };
  }
  const path = portableFile(bundleRoot, record.reference);
  if (path === null) return { valid: false };
  const bytes = readFileSync(path);
  if (digest(bytes) !== record.outputHash) return { valid: false };
  const parsed = semanticOutput(parsedArtifact(record, bytes));
  if (
    parsed === null ||
    parsed.caseId !== record.caseId ||
    parsed.scope !== record.scope ||
    parsed.sourceRevision !== record.sourceRevision ||
    parsed.projectionCommitment !== record.semanticCommitment
  ) {
    return { valid: false };
  }
  return { valid: true, commitment: parsed.projectionCommitment };
}
