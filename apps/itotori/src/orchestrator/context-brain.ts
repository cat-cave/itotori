// Persistent context brain — central context-artifact store as source, sink,
// and invalidation port for the primary agentic loop (node 6).
//
// Every semantic enrichment (scene / character / route / terminology / speaker)
// resolves into a Content-bearing artifact: id + body + citations + provenance
// + an immutable ContextEntryVersion id. `contentHash` verifies bytes but is
// not a version identity. The translation prompt renders the BODY, never bare
// ids. Missing/stale enrichment is built via the supervisor-routed agents and
// upserted before drafting; a failed enrichment persists a typed failure
// record (rejected artifact) rather than a silent drop.

import { createHash, randomUUID } from "node:crypto";
import type {
  AuthorizationActor,
  ContextArtifactCategory,
  ContextArtifactJsonRecord,
  ContextArtifactRecord,
  ContextArtifactRetrievalResult,
  ContextArtifactSourceUnitInput,
  ContextEntryVersionRecord,
  InvalidateContextArtifactsInput,
  ItotoriContextArtifactRepositoryPort,
  RetrieveContextArtifactsInput,
  UpsertContextArtifactInput,
} from "@itotori/db";
import { contextArtifactCategoryValues, contextArtifactStatusValues } from "@itotori/db";
import type { SpeakerLabel } from "@itotori/localization-bridge-schema";

export const CONTEXT_BRAIN_PRODUCER_TOOL = "tool.context-brain";
export const CONTEXT_BRAIN_PRODUCER_VERSION = "1.0.0";

/** One resolved, citable context artifact with real body content. */
export type ResolvedContextArtifact = {
  contextArtifactId: string;
  category: ContextArtifactCategory | string;
  title: string;
  body: string;
  data: ContextArtifactJsonRecord;
  /** Immutable ContextEntryVersion selected for this resolved packet. */
  contextEntryVersionId: string | null;
  contentHash: string;
  status: string;
  producedByAgent: string | null;
  producerVersion: string;
  provenance: ContextArtifactJsonRecord;
  citations: Array<{ bridgeUnitId: string; citation: string }>;
  /**
   * The semantic outcome represented by this durable artifact. An active
   * `no_content` record is an honest, reusable result — it is deliberately
   * distinct from generated content and from a rejected failure record.
   */
  semanticResult: ContextArtifactSemanticResult;
  /** Present when this row records a typed enrichment failure. */
  failure?: {
    agentLabel: string;
    code: EnrichmentFailureCode;
    reason: string;
  };
};

/**
 * Immutable, bounded packet resolved for one unit before drafting.
 * Same packet identity (version refs) rides the journal with the draft.
 */
export type UnitContextPacket = {
  unitId: string;
  /** entryId → immutable ContextEntryVersion id (revision identity). */
  resolvedFromVersions: Record<string, string>;
  artifacts: ResolvedContextArtifact[];
  speakers: SpeakerLabel[];
};

export type EnrichmentFailureCode =
  | "content_exhausted"
  | "parse_failure"
  | "validation_failure"
  | "provider_failure"
  | "persistence_failure"
  | "unknown";

export type ContextArtifactSemanticResult =
  | { kind: "content" }
  | { kind: "no_content"; agentLabel: string; reason: string }
  | { kind: "failure"; agentLabel: string; code: EnrichmentFailureCode; reason: string };

/** Stable, deterministic artifact id for a logical enrichment key. */
export function stableContextArtifactId(parts: ReadonlyArray<string>): string {
  const material = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\0");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  // UUID-shaped so store consumers that expect Uuid7-ish ids stay happy.
  return `019ed0c7-${digest.slice(0, 4)}-7000-8000-${digest.slice(4, 16)}`;
}

export function sceneSummaryArtifactId(projectId: string, sceneKey: string): string {
  return stableContextArtifactId(["scene_summary", projectId, sceneKey]);
}

export function characterNoteArtifactId(projectId: string, characterId: string): string {
  return stableContextArtifactId(["character_note", projectId, characterId]);
}

/** Stable identity shared by standalone and live character-relationship enrichment. */
export function characterRelationshipArtifactId(
  projectId: string,
  relationshipKey: string,
): string {
  return characterNoteArtifactId(projectId, `rel:${relationshipKey}`);
}

export function routeMapArtifactId(projectId: string, routeKey: string): string {
  return stableContextArtifactId(["route_map", projectId, routeKey]);
}

export function terminologyCandidateArtifactId(projectId: string, surfaceForm: string): string {
  return stableContextArtifactId(["terminology_candidate", projectId, surfaceForm]);
}

export function speakerLabelArtifactId(projectId: string, bridgeUnitId: string): string {
  return stableContextArtifactId(["speaker_label", projectId, bridgeUnitId]);
}

export function recordToResolvedArtifact(record: ContextArtifactRecord): ResolvedContextArtifact {
  const failureRaw = record.data?.enrichmentFailure;
  const failure =
    typeof failureRaw === "object" && failureRaw !== null && !Array.isArray(failureRaw)
      ? {
          agentLabel: String((failureRaw as Record<string, unknown>).agentLabel ?? "unknown"),
          code:
            ((failureRaw as Record<string, unknown>).code as EnrichmentFailureCode) ?? "unknown",
          reason: String((failureRaw as Record<string, unknown>).reason ?? record.body),
        }
      : undefined;
  const noContentRaw = record.data?.semanticResult;
  const semanticResult: ContextArtifactSemanticResult =
    failure !== undefined
      ? { kind: "failure", ...failure }
      : isNoContentSemanticResult(noContentRaw)
        ? noContentRaw
        : { kind: "content" };
  return {
    contextArtifactId: record.contextArtifactId,
    category: record.category,
    title: record.title,
    body: record.body,
    data: { ...record.data },
    contextEntryVersionId: record.headVersionId,
    contentHash: record.contentHash,
    status: record.status,
    producedByAgent: record.producedByAgent,
    producerVersion: record.producerVersion,
    provenance: { ...record.provenance },
    citations: record.sourceUnits.map((unit) => ({
      bridgeUnitId: unit.bridgeUnitId,
      citation: unit.citation,
    })),
    semanticResult,
    ...(failure !== undefined ? { failure } : {}),
  };
}

export function buildUnitContextPacket(args: {
  unitId: string;
  artifacts: ReadonlyArray<ResolvedContextArtifact>;
  speakers: ReadonlyArray<SpeakerLabel>;
}): UnitContextPacket {
  const resolvedFromVersions: Record<string, string> = {};
  for (const artifact of args.artifacts) {
    if (
      artifact.status === contextArtifactStatusValues.active &&
      artifact.contextEntryVersionId !== null
    ) {
      resolvedFromVersions[artifact.contextArtifactId] = artifact.contextEntryVersionId;
    }
  }
  return {
    unitId: args.unitId,
    resolvedFromVersions,
    artifacts: args.artifacts.map((artifact) => ({
      ...artifact,
      data: { ...artifact.data },
      provenance: { ...artifact.provenance },
      citations: artifact.citations.map((citation) => ({ ...citation })),
      ...(artifact.failure !== undefined ? { failure: { ...artifact.failure } } : {}),
    })),
    speakers: args.speakers.map((label) => ({
      ...label,
      evidenceRefs: label.evidenceRefs.slice(),
    })),
  };
}

export type ContextBrainUpsertInput = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  category: ContextArtifactCategory | string;
  title: string;
  body: string;
  data?: ContextArtifactJsonRecord;
  producedByAgent: string;
  producerVersion: string;
  provenance?: ContextArtifactJsonRecord;
  sourceUnits: ContextArtifactSourceUnitInput[];
  status?: string;
};

/**
 * Persist one artifact through the central store. When no store is wired
 * (synthetic smoke path), synthesize a resolved record so the current unit
 * still receives real content in its packet. It intentionally has no durable
 * ContextEntryVersion id and therefore cannot masquerade as history.
 */
export async function upsertContextBrainArtifact(args: {
  repository: ItotoriContextArtifactRepositoryPort | undefined;
  actor: AuthorizationActor;
  input: ContextBrainUpsertInput;
}): Promise<ResolvedContextArtifact> {
  const { repository, actor, input } = args;
  if (repository === undefined) {
    return ephemeralResolvedArtifact(input);
  }
  const record = await repository.upsertArtifact(actor, {
    contextArtifactId: input.contextArtifactId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    category: input.category,
    ...(input.status !== undefined ? { status: input.status } : {}),
    title: input.title,
    body: input.body,
    data: input.data ?? {},
    producedByAgent: input.producedByAgent,
    producedByTool: CONTEXT_BRAIN_PRODUCER_TOOL,
    producerVersion: input.producerVersion,
    provenance: input.provenance ?? {},
    sourceUnits: input.sourceUnits,
  });
  return recordToResolvedArtifact(record);
}

function isNoContentSemanticResult(
  value: unknown,
): value is Extract<ContextArtifactSemanticResult, { kind: "no_content" }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "no_content" &&
    typeof candidate.agentLabel === "string" &&
    typeof candidate.reason === "string"
  );
}

export async function retrieveActiveContextArtifacts(args: {
  repository: ItotoriContextArtifactRepositoryPort | undefined;
  actor: AuthorizationActor;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  categories?: ReadonlyArray<string>;
  bridgeUnitIds?: ReadonlyArray<string>;
  limit?: number;
}): Promise<ResolvedContextArtifact[]> {
  if (args.repository === undefined) {
    return [];
  }
  const result = await args.repository.retrieveArtifacts(args.actor, {
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    sourceRevisionId: args.sourceRevisionId,
    ...(args.categories !== undefined ? { categories: args.categories } : {}),
    ...(args.bridgeUnitIds !== undefined ? { bridgeUnitIds: args.bridgeUnitIds } : {}),
    includeStale: false,
    limit: args.limit ?? 50,
  });
  if (result.status !== "completed") {
    return [];
  }
  return result.matches.map(recordToResolvedArtifact);
}

/**
 * Find a reusable active artifact by stable id. Returns undefined when missing
 * or when the content hash of cited units no longer matches (stale evidence).
 */
export function findReusableArtifact(args: {
  artifacts: ReadonlyArray<ResolvedContextArtifact>;
  contextArtifactId: string;
  expectedSourceHashes?: ReadonlyMap<string, string>;
}): ResolvedContextArtifact | undefined {
  const match = args.artifacts.find(
    (artifact) =>
      artifact.contextArtifactId === args.contextArtifactId &&
      artifact.status === contextArtifactStatusValues.active,
  );
  if (match === undefined) {
    return undefined;
  }
  if (args.expectedSourceHashes === undefined || args.expectedSourceHashes.size === 0) {
    return match;
  }
  // If the artifact carries per-unit source hashes in data, enforce them.
  const citedHashes = match.data.citedUnitHashes;
  if (!Array.isArray(citedHashes)) {
    return match;
  }
  const citedIds = match.data.citedUnitIds;
  if (!Array.isArray(citedIds) || citedIds.length !== citedHashes.length) {
    return match;
  }
  for (let index = 0; index < citedIds.length; index += 1) {
    const unitId = citedIds[index];
    const hash = citedHashes[index];
    if (typeof unitId !== "string" || typeof hash !== "string") {
      continue;
    }
    const expected = args.expectedSourceHashes.get(unitId);
    if (expected !== undefined && expected !== hash) {
      return undefined;
    }
  }
  return match;
}

export function speakerLabelsFromArtifacts(
  artifacts: ReadonlyArray<ResolvedContextArtifact>,
): SpeakerLabel[] {
  const labels: SpeakerLabel[] = [];
  for (const artifact of artifacts) {
    if (artifact.category !== contextArtifactCategoryValues.speakerLabel) {
      continue;
    }
    const raw = artifact.data.speakerLabel;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    labels.push(raw as SpeakerLabel);
  }
  return labels;
}

export function speakerLabelToMap(labels: ReadonlyArray<SpeakerLabel>): Map<string, SpeakerLabel> {
  const map = new Map<string, SpeakerLabel>();
  for (const label of labels) {
    map.set(label.bridgeUnitId, label);
  }
  return map;
}

function ephemeralResolvedArtifact(input: ContextBrainUpsertInput): ResolvedContextArtifact {
  const data = input.data ?? {};
  const contentHash = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        category: input.category,
        title: input.title,
        body: input.body,
        data,
        sourceUnits: input.sourceUnits,
      }),
    )
    .digest("hex")}`;
  const failureRaw = data.enrichmentFailure;
  const failure =
    typeof failureRaw === "object" && failureRaw !== null && !Array.isArray(failureRaw)
      ? {
          agentLabel: String((failureRaw as Record<string, unknown>).agentLabel ?? "unknown"),
          code:
            ((failureRaw as Record<string, unknown>).code as EnrichmentFailureCode) ?? "unknown",
          reason: String((failureRaw as Record<string, unknown>).reason ?? input.body),
        }
      : undefined;
  const noContentRaw = data.semanticResult;
  const semanticResult: ContextArtifactSemanticResult =
    failure !== undefined
      ? { kind: "failure", ...failure }
      : isNoContentSemanticResult(noContentRaw)
        ? noContentRaw
        : { kind: "content" };
  return {
    contextArtifactId: input.contextArtifactId,
    category: input.category,
    title: input.title,
    body: input.body,
    data: { ...data },
    contextEntryVersionId: null,
    contentHash,
    status: input.status ?? contextArtifactStatusValues.active,
    producedByAgent: input.producedByAgent,
    producerVersion: input.producerVersion,
    provenance: {
      ...input.provenance,
      ephemeral: true,
      producedByTool: CONTEXT_BRAIN_PRODUCER_TOOL,
    },
    citations: input.sourceUnits.map((unit) => ({
      bridgeUnitId: unit.bridgeUnitId,
      citation: unit.citation,
    })),
    semanticResult,
    ...(failure !== undefined ? { failure } : {}),
  };
}

/**
 * In-memory central context store for unit tests and smoke paths that need
 * cross-unit reuse without Postgres. Implements the real repository port so
 * the live loop path is exercised end-to-end.
 */
export class InMemoryContextArtifactRepository implements ItotoriContextArtifactRepositoryPort {
  private readonly artifacts = new Map<string, ContextArtifactRecord>();
  private readonly entryVersions = new Map<string, ContextEntryVersionRecord[]>();

  async upsertArtifact(
    actor: AuthorizationActor,
    input: UpsertContextArtifactInput,
  ): Promise<ContextArtifactRecord> {
    const contextArtifactId = input.contextArtifactId ?? randomUUID();
    const previous = this.artifacts.get(contextArtifactId);
    const now = new Date();
    const data = input.data ?? {};
    const contentHash = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          category: input.category,
          title: input.title,
          body: input.body,
          data,
          sourceUnits: input.sourceUnits,
        }),
      )
      .digest("hex")}`;
    const status = (input.status ??
      contextArtifactStatusValues.active) as ContextArtifactRecord["status"];
    const versionCount = (this.entryVersions.get(contextArtifactId)?.length ?? 0) + 1;
    const contextEntryVersionId = `in-memory-context-entry-version:${contextArtifactId}:${versionCount}`;
    const sourceUnits = input.sourceUnits.map((unit) => ({
      contextArtifactId,
      bridgeUnitId: unit.bridgeUnitId,
      sourceRevisionId: input.sourceRevisionId,
      sourceHash: typeof unit.metadata?.sourceHash === "string" ? unit.metadata.sourceHash : "",
      citation: unit.citation,
      metadata: unit.metadata ?? {},
      createdAt: now,
    }));
    const record: ContextArtifactRecord = {
      contextArtifactId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      category: input.category as ContextArtifactRecord["category"],
      status,
      title: input.title,
      normalizedTitle: input.title
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/\s+/gu, " ")
        .trim(),
      body: input.body,
      data,
      headVersionId: contextEntryVersionId,
      contentHash,
      producedByAgent: input.producedByAgent ?? null,
      producedByTool: input.producedByTool ?? null,
      producerVersion: input.producerVersion,
      provenance: {
        ...input.provenance,
        schemaVersion: "itotori.context-artifact.v1",
        producedByAgent: input.producedByAgent ?? null,
        producedByTool: input.producedByTool ?? null,
        producerVersion: input.producerVersion,
      },
      invalidatedReason:
        status === contextArtifactStatusValues.active ? null : (input.status ?? "rejected"),
      invalidatedAt: status === contextArtifactStatusValues.active ? null : now,
      createdByUserId: actor.userId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      sourceUnits,
    };
    const version: ContextEntryVersionRecord = {
      contextEntryVersionId,
      contextArtifactId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      parentVersionId: previous?.headVersionId ?? null,
      sourceRevisionId: input.sourceRevisionId,
      category: record.category,
      status,
      title: input.title,
      normalizedTitle: record.normalizedTitle,
      body: input.body,
      data: { ...data },
      contentHash,
      producedByAgent: input.producedByAgent ?? null,
      producedByTool: input.producedByTool ?? null,
      producerVersion: input.producerVersion,
      provenance: { ...record.provenance },
      citations: sourceUnits.map((unit) => ({
        bridgeUnitId: unit.bridgeUnitId,
        sourceRevisionId: unit.sourceRevisionId,
        sourceHash: unit.sourceHash,
        citation: unit.citation,
        metadata: { ...unit.metadata },
      })),
      affectedUnitIds: sourceUnits.map((unit) => unit.bridgeUnitId).sort(),
      invalidatedReason: record.invalidatedReason,
      invalidatedAt: record.invalidatedAt,
      createdByUserId: actor.userId,
      createdAt: now,
    };
    this.artifacts.set(contextArtifactId, record);
    this.entryVersions.set(contextArtifactId, [
      ...(this.entryVersions.get(contextArtifactId) ?? []),
      version,
    ]);
    return record;
  }

  async invalidateAffectedArtifacts(
    _actor: AuthorizationActor,
    input: InvalidateContextArtifactsInput,
  ): Promise<{
    status: "completed" | "failed";
    projectId: string;
    localeBranchId: string;
    sourceRevisionId: string | null;
    invalidatedCount: number;
    invalidatedArtifactIds: string[];
    diagnostics: [];
  }> {
    const bridgeSet = input.bridgeUnitIds !== undefined ? new Set(input.bridgeUnitIds) : undefined;
    const invalidatedArtifactIds: string[] = [];
    const now = new Date();
    for (const [id, artifact] of this.artifacts) {
      if (
        artifact.projectId !== input.projectId ||
        artifact.localeBranchId !== input.localeBranchId
      ) {
        continue;
      }
      if (
        bridgeSet !== undefined &&
        !artifact.sourceUnits.some((unit) => bridgeSet.has(unit.bridgeUnitId))
      ) {
        continue;
      }
      if (
        input.sourceRevisionId !== undefined &&
        artifact.sourceRevisionId === input.sourceRevisionId &&
        bridgeSet === undefined
      ) {
        continue;
      }
      this.artifacts.set(id, {
        ...artifact,
        status: contextArtifactStatusValues.stale,
        invalidatedReason: input.reason ?? "invalidated",
        invalidatedAt: now,
        updatedAt: now,
      });
      invalidatedArtifactIds.push(id);
    }
    return {
      status: "completed",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId ?? null,
      invalidatedCount: invalidatedArtifactIds.length,
      invalidatedArtifactIds,
      diagnostics: [],
    };
  }

  async retrieveArtifacts(
    _actor: AuthorizationActor,
    input: RetrieveContextArtifactsInput,
  ): Promise<ContextArtifactRetrievalResult> {
    const includeStale = input.includeStale ?? false;
    const categorySet =
      input.categories !== undefined && input.categories.length > 0
        ? new Set(input.categories)
        : undefined;
    const bridgeSet =
      input.bridgeUnitIds !== undefined && input.bridgeUnitIds.length > 0
        ? new Set(input.bridgeUnitIds)
        : undefined;
    const matches = [...this.artifacts.values()]
      .filter((artifact) => artifact.projectId === input.projectId)
      .filter((artifact) => artifact.localeBranchId === input.localeBranchId)
      .filter(
        (artifact) =>
          input.sourceRevisionId === undefined ||
          artifact.sourceRevisionId === input.sourceRevisionId,
      )
      .filter((artifact) => includeStale || artifact.status === contextArtifactStatusValues.active)
      .filter((artifact) => categorySet === undefined || categorySet.has(artifact.category))
      .filter(
        (artifact) =>
          bridgeSet === undefined ||
          artifact.sourceUnits.some((unit) => bridgeSet.has(unit.bridgeUnitId)),
      )
      .slice(0, input.limit ?? 50)
      .map((artifact) => ({
        ...artifact,
        retrievalScore: 1,
        retrievalReasons: ["in_memory"],
        citations: artifact.sourceUnits,
        provenance: {
          ...artifact.provenance,
          schemaVersion: "itotori.context-artifact.v1" as const,
          toolName: "tool.context-artifacts" as const,
          toolVersion: "1.0.0" as const,
          contextArtifactId: artifact.contextArtifactId,
          category: artifact.category,
          sourceRevisionId: artifact.sourceRevisionId,
          producedByAgent: artifact.producedByAgent,
          producedByTool: artifact.producedByTool,
          producerVersion: artifact.producerVersion,
        },
      }));
    return {
      status: "completed",
      toolName: "tool.context-artifacts",
      toolVersion: "1.0.0",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId ?? null,
      query: input.query ?? null,
      normalizedQuery: input.query ?? null,
      categories: (input.categories ?? []) as ContextArtifactCategory[],
      matches,
      diagnostics: [],
    };
  }

  async loadArtifact(
    _actor: AuthorizationActor,
    input: {
      projectId: string;
      localeBranchId: string;
      contextArtifactId: string;
    },
  ): Promise<ContextArtifactRecord | null> {
    const artifact = this.artifacts.get(input.contextArtifactId);
    if (
      artifact === undefined ||
      artifact.projectId !== input.projectId ||
      artifact.localeBranchId !== input.localeBranchId
    ) {
      return null;
    }
    return {
      ...artifact,
      data: { ...artifact.data },
      provenance: { ...artifact.provenance },
      sourceUnits: artifact.sourceUnits.map((unit) => ({
        ...unit,
        metadata: { ...unit.metadata },
      })),
    };
  }

  async listEntryVersions(
    _actor: AuthorizationActor,
    input: {
      projectId: string;
      localeBranchId: string;
      contextArtifactId: string;
    },
  ): Promise<ContextEntryVersionRecord[]> {
    return (this.entryVersions.get(input.contextArtifactId) ?? [])
      .filter((version) => version.projectId === input.projectId)
      .filter((version) => version.localeBranchId === input.localeBranchId)
      .map((version) => ({
        ...version,
        data: { ...version.data },
        provenance: { ...version.provenance },
        citations: version.citations.map((citation) => ({
          ...citation,
          metadata: { ...citation.metadata },
        })),
        affectedUnitIds: version.affectedUnitIds.slice(),
      }));
  }

  /** Test helper — snapshot of every stored artifact. */
  listAll(): ContextArtifactRecord[] {
    return [...this.artifacts.values()];
  }
}
