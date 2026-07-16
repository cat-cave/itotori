import type { DatabaseContext } from "../connection.js";
import {
  assertLlmSha256,
  canonicalLlmJson,
  llmSha256,
  type LlmJsonValue,
} from "../llm-content-address.js";

export const LLM_CONTEXT_SNAPSHOT_SCHEMA_VERSION = "itotori.context-snapshot.v1" as const;
export const LLM_LOCALIZATION_SNAPSHOT_SCHEMA_VERSION = "itotori.localization-snapshot.v1" as const;

export interface LlmRevisionRef {
  revisionId: string;
  contentHash: string;
}

export interface LlmSourceUnitRef {
  unitId: string;
  sourceHash: string;
}

export type LlmSnapshotFactRouteScope =
  | { kind: "global" }
  | { kind: "route"; routeId: string }
  | { kind: "route-set"; routeIds: readonly string[] };

export interface LlmSnapshotFact {
  factId: string;
  playOrderIndex: number;
  routeScope: LlmSnapshotFactRouteScope;
}

export type LlmRevealHorizon =
  | { kind: "complete" }
  | { kind: "through-play-order"; playOrderIndex: number };

export interface LlmContextSnapshotInput {
  sourceLanguage: string;
  decode: LlmRevisionRef;
  sourceUnits: readonly LlmSourceUnitRef[];
  facts: readonly LlmSnapshotFact[];
  structure: LlmRevisionRef;
  routeGraph: LlmRevisionRef;
  glossary: LlmRevisionRef;
  style: LlmRevisionRef;
  revealHorizon: LlmRevealHorizon;
  humanCorrections: LlmRevisionRef;
  externalSources: LlmRevisionRef | null;
  contextScope: string;
  /**
   * Content hash of the deterministic fact-materialization pre-pass. Its
   * `contentHash` commits the ENTIRE materialized fact set (ordered units,
   * route/choice topology + reachability, scene cards, speaker/color identity,
   * character/terminology occurrences, glossary conflicts, play/reveal order,
   * protected skeletons, patch/runtime refs) into this snapshot — so the
   * snapshot is the trust root for those facts. Omitted for a bare context
   * snapshot; when omitted the committed identity is byte-identical to a
   * snapshot built without a fact materialization (no field is serialized).
   */
  factMaterialization?: LlmRevisionRef;
}

export interface LlmAcceptedHeadRef {
  headId: string;
  version: number;
  contentHash: string;
}

export interface LlmLocalizationSnapshotInput {
  contextSnapshotId: string;
  targetLocale: string;
  localeBranchId: string;
  acceptedBibleHead: LlmAcceptedHeadRef | null;
  acceptedTargetOutputHead: LlmAcceptedHeadRef | null;
}

export interface LlmContextSnapshot extends LlmContextSnapshotIdentity {
  snapshotId: `sha256:${string}`;
  contentHash: `sha256:${string}`;
}

export interface LlmLocalizationSnapshot extends LlmLocalizationSnapshotIdentity {
  snapshotId: `sha256:${string}`;
  contentHash: `sha256:${string}`;
}

export interface LlmContextSnapshotIdentity {
  schemaVersion: typeof LLM_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  sourceLanguage: string;
  decode: LlmRevisionRef;
  sourceUnits: readonly LlmSourceUnitRef[];
  facts: readonly LlmSnapshotFact[];
  structure: LlmRevisionRef;
  routeGraph: LlmRevisionRef;
  glossary: LlmRevisionRef;
  style: LlmRevisionRef;
  revealHorizon: LlmRevealHorizon;
  humanCorrections: LlmRevisionRef;
  externalSources: LlmRevisionRef | null;
  contextScope: string;
  /** See {@link LlmContextSnapshotInput.factMaterialization}. Present only when
   * the pre-pass committed a fact materialization into this snapshot. */
  factMaterialization?: LlmRevisionRef;
}

export interface LlmLocalizationSnapshotIdentity {
  schemaVersion: typeof LLM_LOCALIZATION_SNAPSHOT_SCHEMA_VERSION;
  contextSnapshot: { id: string; hash: string };
  targetLanguage: string;
  localeBranchId: string;
  acceptedBibleHead: LlmAcceptedHeadRef | null;
  acceptedTargetOutputHead: LlmAcceptedHeadRef | null;
}

export type LlmFactNamespace = "unit" | "scene" | "character" | "choice" | "glossary" | "output";

export class ItotoriLlmSnapshotRepository {
  constructor(private readonly pool: DatabaseContext["pool"]) {}

  async putContext(input: LlmContextSnapshotInput): Promise<LlmContextSnapshot> {
    const snapshot = contextSnapshot(input);
    await this.pool.query(
      `
        insert into itotori_llm_context_snapshots (
          snapshot_id, schema_version, snapshot_content_hash, snapshot_identity, created_at
        ) values ($1, $2, $3, $4::jsonb, now())
        on conflict (snapshot_id) do nothing
      `,
      [
        snapshot.snapshotId,
        snapshot.schemaVersion,
        snapshot.contentHash,
        canonicalLlmJson(snapshotIdentity(snapshot) as unknown as LlmJsonValue),
      ],
    );
    const stored = await this.readContext(snapshot.snapshotId);
    if (!stored || canonicalIdentity(stored) !== canonicalIdentity(snapshot)) {
      throw new Error("context snapshot content-address collision");
    }
    return stored;
  }

  async putLocalization(input: LlmLocalizationSnapshotInput): Promise<LlmLocalizationSnapshot> {
    const snapshot = localizationSnapshot(input);
    await this.pool.query(
      `
        insert into itotori_llm_localization_snapshots (
          snapshot_id, schema_version, snapshot_content_hash, context_snapshot_id,
          snapshot_identity, created_at
        ) values ($1, $2, $3, $4, $5::jsonb, now())
        on conflict (snapshot_id) do nothing
      `,
      [
        snapshot.snapshotId,
        snapshot.schemaVersion,
        snapshot.contentHash,
        snapshot.contextSnapshot.id,
        canonicalLlmJson(snapshotIdentity(snapshot) as unknown as LlmJsonValue),
      ],
    );
    const stored = await this.readLocalization(snapshot.snapshotId);
    if (!stored || canonicalIdentity(stored) !== canonicalIdentity(snapshot)) {
      throw new Error("localization snapshot content-address collision");
    }
    return stored;
  }

  async readContext(snapshotId: string): Promise<LlmContextSnapshot | null> {
    assertLlmSha256(snapshotId, "context snapshot ID");
    const result = await this.pool.query<SnapshotRow>(
      `
        select snapshot_id, schema_version, snapshot_content_hash, snapshot_identity
        from itotori_llm_context_snapshots where snapshot_id = $1
      `,
      [snapshotId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.schema_version !== LLM_CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("unsupported context snapshot schema version");
    }
    const identity = row.snapshot_identity as unknown as LlmContextSnapshotIdentity;
    const computed = contextSnapshot(identity);
    assertStoredSnapshot(row, computed);
    return computed;
  }

  async readLocalization(snapshotId: string): Promise<LlmLocalizationSnapshot | null> {
    assertLlmSha256(snapshotId, "localization snapshot ID");
    const result = await this.pool.query<SnapshotRow>(
      `
        select snapshot_id, schema_version, snapshot_content_hash, snapshot_identity
        from itotori_llm_localization_snapshots where snapshot_id = $1
      `,
      [snapshotId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.schema_version !== LLM_LOCALIZATION_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("unsupported localization snapshot schema version");
    }
    const identity = row.snapshot_identity as unknown as LlmLocalizationSnapshotIdentity;
    const computed = localizationSnapshot({
      contextSnapshotId: identity.contextSnapshot.id,
      targetLocale: identity.targetLanguage,
      localeBranchId: identity.localeBranchId,
      acceptedBibleHead: identity.acceptedBibleHead,
      acceptedTargetOutputHead: identity.acceptedTargetOutputHead,
    });
    assertStoredSnapshot(row, computed);
    return computed;
  }
}

export function contextSnapshot(input: LlmContextSnapshotInput): LlmContextSnapshot {
  const identity = normalizeContext(input);
  const contentHash = llmSha256(identity as unknown as LlmJsonValue);
  return {
    ...identity,
    snapshotId: contentHash,
    contentHash,
  };
}

export function localizationSnapshot(input: LlmLocalizationSnapshotInput): LlmLocalizationSnapshot {
  const identity = normalizeLocalization(input);
  const contentHash = llmSha256(identity as unknown as LlmJsonValue);
  return {
    ...identity,
    snapshotId: contentHash,
    contentHash,
  };
}

export function namespacedFactId(
  namespace: LlmFactNamespace,
  ...stableParts: readonly string[]
): string {
  if (stableParts.length === 0) throw new Error("a fact ID requires a stable subject");
  for (const part of stableParts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)) {
      throw new Error("fact ID parts must be stable identifier segments");
    }
  }
  const factId = `${namespace}:${stableParts.join(":")}`;
  if (factId.length > 256) throw new Error("fact ID exceeds the stable identifier limit");
  return factId;
}

function normalizeContext(input: LlmContextSnapshotInput): LlmContextSnapshotIdentity {
  assertLanguageTag(input.sourceLanguage, "source language");
  assertRevision(input.decode, "decode revision");
  assertRevision(input.structure, "narrative structure revision");
  assertRevision(input.routeGraph, "route graph revision");
  assertRevision(input.glossary, "glossary revision");
  assertRevision(input.style, "style-guide revision");
  assertRevision(input.humanCorrections, "human-correction revision");
  if (input.externalSources) assertRevision(input.externalSources, "external-source revision");
  if (
    input.contextScope !== "whole-game" &&
    input.contextScope !== "external-augmented" &&
    !/^narrowed:[^\s].{0,127}$/u.test(input.contextScope)
  ) {
    throw new Error("context scope is invalid");
  }
  if ((input.contextScope === "external-augmented") !== (input.externalSources !== null)) {
    throw new Error("external-augmented scope requires an external-source revision");
  }
  if (input.sourceUnits.length === 0) throw new Error("a context snapshot requires source units");
  const sourceUnits = input.sourceUnits
    .map((unit) => {
      assertIdentifier(unit.unitId, "source unit ID");
      assertLlmSha256(unit.sourceHash, "source unit content hash");
      return { unitId: unit.unitId, sourceHash: unit.sourceHash };
    })
    .sort((left, right) => compareCodeUnits(left.unitId, right.unitId));
  if (new Set(sourceUnits.map((unit) => unit.unitId)).size !== sourceUnits.length) {
    throw new Error("context snapshot source unit IDs must be unique");
  }
  if (input.facts.length === 0) throw new Error("a context snapshot requires committed facts");
  const facts = input.facts
    .map((fact) => normalizeFact(fact))
    .sort((left, right) => compareCodeUnits(left.factId, right.factId));
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) {
    throw new Error("context snapshot fact IDs must be unique");
  }
  const revealHorizon = normalizeHorizon(input.revealHorizon);
  if (input.factMaterialization !== undefined) {
    assertRevision(input.factMaterialization, "fact-materialization revision");
  }
  return {
    schemaVersion: LLM_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    sourceLanguage: input.sourceLanguage,
    decode: copyRevision(input.decode),
    sourceUnits,
    facts,
    structure: copyRevision(input.structure),
    routeGraph: copyRevision(input.routeGraph),
    glossary: copyRevision(input.glossary),
    style: copyRevision(input.style),
    revealHorizon,
    humanCorrections: copyRevision(input.humanCorrections),
    externalSources: input.externalSources ? copyRevision(input.externalSources) : null,
    contextScope: input.contextScope,
    // Omit entirely when absent so a bare context snapshot's committed identity
    // (and thus its snapshotId) is byte-identical to a snapshot built without a
    // fact materialization.
    ...(input.factMaterialization === undefined
      ? {}
      : { factMaterialization: copyRevision(input.factMaterialization) }),
  };
}

function normalizeLocalization(
  input: LlmLocalizationSnapshotInput,
): LlmLocalizationSnapshotIdentity {
  assertLlmSha256(input.contextSnapshotId, "localization context snapshot ID");
  assertLanguageTag(input.targetLocale, "target locale");
  assertIdentifier(input.localeBranchId, "locale branch ID");
  assertAcceptedHead(input.acceptedBibleHead, "accepted bible head");
  assertAcceptedHead(input.acceptedTargetOutputHead, "accepted target-output head");
  return {
    schemaVersion: LLM_LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
    contextSnapshot: { id: input.contextSnapshotId, hash: input.contextSnapshotId },
    targetLanguage: input.targetLocale,
    localeBranchId: input.localeBranchId,
    acceptedBibleHead: copyHead(input.acceptedBibleHead),
    acceptedTargetOutputHead: copyHead(input.acceptedTargetOutputHead),
  };
}

function normalizeHorizon(input: LlmRevealHorizon): LlmRevealHorizon {
  if (input.kind === "complete") return { kind: "complete" };
  if (!Number.isSafeInteger(input.playOrderIndex) || input.playOrderIndex < 0) {
    throw new Error("reveal play-order horizon must be a non-negative safe integer");
  }
  return { kind: "through-play-order", playOrderIndex: input.playOrderIndex };
}

function normalizeFact(input: LlmSnapshotFact): LlmSnapshotFact {
  assertFactId(input.factId);
  if (!Number.isSafeInteger(input.playOrderIndex) || input.playOrderIndex < 0) {
    throw new Error("snapshot fact play order must be a non-negative safe integer");
  }
  return {
    factId: input.factId,
    playOrderIndex: input.playOrderIndex,
    routeScope: normalizeFactRouteScope(input.routeScope),
  };
}

function normalizeFactRouteScope(input: LlmSnapshotFactRouteScope): LlmSnapshotFactRouteScope {
  if (input.kind === "global") return { kind: "global" };
  if (input.kind === "route") {
    assertIdentifier(input.routeId, "snapshot fact route ID");
    return { kind: "route", routeId: input.routeId };
  }
  const routeIds = [...input.routeIds].sort(compareCodeUnits);
  if (routeIds.length === 0) throw new Error("snapshot fact route set must not be empty");
  for (const routeId of routeIds) assertIdentifier(routeId, "snapshot fact route ID");
  if (new Set(routeIds).size !== routeIds.length) {
    throw new Error("snapshot fact route IDs must be unique");
  }
  return { kind: "route-set", routeIds };
}

function assertFactId(value: string): void {
  if (
    !/^(?:unit|scene|character|choice|glossary|output):[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(
      value,
    )
  ) {
    throw new Error("snapshot fact ID is not a stable namespaced identifier");
  }
  if (value.length > 256) throw new Error("snapshot fact ID exceeds the stable identifier limit");
}

function assertRevision(value: LlmRevisionRef, label: string): void {
  assertIdentifier(value.revisionId, `${label} ID`);
  assertLlmSha256(value.contentHash, `${label} content hash`);
}

function assertAcceptedHead(value: LlmAcceptedHeadRef | null, label: string): void {
  if (value === null) return;
  assertIdentifier(value.headId, `${label} ID`);
  if (!Number.isSafeInteger(value.version) || value.version <= 0) {
    throw new Error(`${label} version must be a positive safe integer`);
  }
  assertLlmSha256(value.contentHash, `${label} content hash`);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/u.test(value)) {
    throw new Error(`${label} is not a stable identifier`);
  }
}

function assertLanguageTag(value: string, label: string): void {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value)) {
    throw new Error(`${label} is not a language tag`);
  }
}

function copyRevision(value: LlmRevisionRef): LlmRevisionRef {
  return { revisionId: value.revisionId, contentHash: value.contentHash };
}

function copyHead(value: LlmAcceptedHeadRef | null): LlmAcceptedHeadRef | null {
  return value
    ? { headId: value.headId, version: value.version, contentHash: value.contentHash }
    : null;
}

function canonicalIdentity(value: object): string {
  return canonicalLlmJson(value as unknown as LlmJsonValue);
}

function snapshotIdentity(
  snapshot: LlmContextSnapshot | LlmLocalizationSnapshot,
): LlmContextSnapshotIdentity | LlmLocalizationSnapshotIdentity {
  const { snapshotId, contentHash, ...identity } = snapshot;
  void snapshotId;
  void contentHash;
  return identity;
}

function assertStoredSnapshot(
  row: SnapshotRow,
  computed: LlmContextSnapshot | LlmLocalizationSnapshot,
): void {
  if (
    row.snapshot_id !== computed.snapshotId ||
    row.snapshot_content_hash !== computed.contentHash
  ) {
    throw new Error("stored snapshot content hash mismatch");
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type SnapshotRow = {
  snapshot_id: string;
  schema_version: string;
  snapshot_content_hash: string;
  snapshot_identity: unknown;
};
