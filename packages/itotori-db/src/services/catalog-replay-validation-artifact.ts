// CATALOG-076: durable catalog replay VALIDATION records.
//
// The catalog crawler runner (CATALOG-072/073) already produces an in-memory
// `replayValidation: CatalogCrawlerReplayValidationRecord[]` per replay run
// proving CATALOG-065 idempotent fact-import acceptance. That evidence only
// lives in the test process, so source-adapter acceptance can cite nothing more
// durable than a green test log.
//
// This module turns those in-memory records into a DURABLE, DETERMINISTIC, and
// REDACTED validation artifact (a JSON document, gitignored under `.tmp/`) that
// records, per replay run: source id, fixture id, stable import key, import
// transaction id, deterministic fact count, and deterministic fact identities.
// Adapter acceptance can then CITE the artifact (path + digest) instead of only
// pointing at test logs.
//
// Redaction: the artifact is an explicit WHITELIST projection of the safe
// identity metadata. Raw source payloads and any private local paths are never
// part of the projected record, so they cannot leak — even if an upstream record
// object carried extra fields, the projection drops everything outside the
// whitelist.
//
// Determinism: records are sorted by a stable content key (never by wall-clock
// or per-job ids), serialization sorts object keys, and the artifact carries a
// content digest but NO run-varying timestamp, so two runs of the same replay
// serialize byte-identically.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  catalogCrawlerIdempotentFactImportContractId,
  type CatalogCrawlerReplayValidationRecord,
} from "./catalog-crawler-runner.js";

export const catalogReplayValidationArtifactVersion = "catalog-replay-validation.v1" as const;

export const catalogReplayValidationArtifactNode = "CATALOG-076" as const;

/**
 * The SAFE, whitelisted identity metadata persisted per replay-validated step.
 * This is the redaction boundary: only these fields are ever emitted. There is
 * deliberately no payload, no request body, and no local filesystem path.
 */
export const catalogReplayValidationRecordFields = [
  "contractId",
  "catalogSource",
  "sourceId",
  "fixtureId",
  "stepKey",
  "stableImportKey",
  "importTransactionId",
  "factCount",
  "factIdentities",
  "alreadyImported",
] as const;

export type CatalogReplayValidationArtifactRecord = {
  contractId: typeof catalogCrawlerIdempotentFactImportContractId;
  catalogSource: string;
  sourceId: string;
  fixtureId: string;
  stepKey: string;
  stableImportKey: string;
  importTransactionId: string;
  factCount: number;
  factIdentities: readonly string[];
  alreadyImported: boolean;
};

export type CatalogReplayValidationArtifact = {
  artifactVersion: typeof catalogReplayValidationArtifactVersion;
  node: typeof catalogReplayValidationArtifactNode;
  contractId: typeof catalogCrawlerIdempotentFactImportContractId;
  recordCount: number;
  records: readonly CatalogReplayValidationArtifactRecord[];
  /** sha256 over the canonical serialization of the sorted records. */
  digest: string;
};

/**
 * Project a runner replay-validation record down to the safe whitelist. This is
 * where redaction happens: only `catalogReplayValidationRecordFields` survive,
 * so no raw payload / local path can ride along even if the input object carried
 * extra properties.
 */
function redactToWhitelist(
  record: CatalogCrawlerReplayValidationRecord,
): CatalogReplayValidationArtifactRecord {
  return {
    contractId: record.contractId,
    catalogSource: record.catalogSource,
    sourceId: record.sourceId,
    fixtureId: record.fixtureId,
    stepKey: record.stepKey,
    stableImportKey: record.stableImportKey,
    importTransactionId: record.importTransactionId,
    factCount: record.factCount,
    // Copy the array so the artifact never aliases caller state; fact identity
    // ORDER is deterministic (fact order) and is preserved verbatim.
    factIdentities: [...record.factIdentities],
    alreadyImported: record.alreadyImported,
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Build a deterministic, redacted validation artifact from one or more replay
 * runs' in-memory `replayValidation` records. Records are sorted by a stable
 * content key (never by wall-clock or per-job id) so the output is byte-stable
 * across runs and independent of the order records were collected in.
 */
export function buildCatalogReplayValidationArtifact(
  records: readonly CatalogCrawlerReplayValidationRecord[],
): CatalogReplayValidationArtifact {
  const projected = records
    .map(redactToWhitelist)
    .sort(
      (left, right) =>
        compareStrings(left.stableImportKey, right.stableImportKey) ||
        compareStrings(left.stepKey, right.stepKey) ||
        compareStrings(left.sourceId, right.sourceId) ||
        compareStrings(left.fixtureId, right.fixtureId),
    );
  const digest = `sha256:${sha256(stableJsonStringify(projected))}`;
  return {
    artifactVersion: catalogReplayValidationArtifactVersion,
    node: catalogReplayValidationArtifactNode,
    contractId: catalogCrawlerIdempotentFactImportContractId,
    recordCount: projected.length,
    records: projected,
    digest,
  };
}

/**
 * Serialize an artifact to a byte-stable JSON string (sorted keys, 2-space
 * indent, trailing newline). Two artifacts with identical content serialize to
 * byte-identical output.
 */
export function serializeCatalogReplayValidationArtifact(
  artifact: CatalogReplayValidationArtifact,
): string {
  return `${JSON.stringify(artifact, sortedKeyReplacer, 2)}\n`;
}

/**
 * Emit the durable validation artifact to disk deterministically. The default
 * location is gitignored (`.tmp/`), and callers may cite `{ path, digest }` as
 * durable acceptance evidence.
 */
export async function writeCatalogReplayValidationArtifact(
  records: readonly CatalogCrawlerReplayValidationRecord[],
  outputPath: string,
): Promise<{
  path: string;
  artifact: CatalogReplayValidationArtifact;
  json: string;
}> {
  const artifact = buildCatalogReplayValidationArtifact(records);
  const json = serializeCatalogReplayValidationArtifact(artifact);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json);
  return { path: outputPath, artifact, json };
}

function sortedKeyReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareStrings)) {
    sorted[key] = source[key];
  }
  return sorted;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableJsonStringify(input: unknown): string {
  if (input === undefined) {
    return "undefined";
  }
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input) ?? "undefined";
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) =>
    compareStrings(left, right),
  );
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonStringify(value)}`)
    .join(",")}}`;
}
