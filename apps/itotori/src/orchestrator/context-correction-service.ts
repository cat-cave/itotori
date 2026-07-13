// Play-tester context correction — the direct shared-brain mutation path.
//
// A correction directly reaches the canonical context path rather than a
// translation-memory writeback. The repository atomically appends a canonical
// ContextEntryVersion, invalidates dependent context while excluding that new
// head, and enqueues one registered redraft job. The job payload carries
// provenance only; its handler must resolve a fresh ContextPacket when it
// executes.

import { createHash } from "node:crypto";
import {
  type AuthorizationActor,
  contextArtifactCategoryValues,
  type ContextArtifactJsonRecord,
  type ContextArtifactRecord,
  type ContextArtifactCategory,
  type ContextCorrectionAuthority,
  type ItotoriContextCorrectionPersistencePort,
  type JobQueueRecord,
} from "@itotori/db";

export const playTesterContextKindValues = {
  scene: contextArtifactCategoryValues.sceneSummary,
  character: contextArtifactCategoryValues.characterNote,
  route: contextArtifactCategoryValues.routeMap,
  speaker: contextArtifactCategoryValues.speakerLabel,
  term: contextArtifactCategoryValues.terminologyCandidate,
  glossary: "glossary",
  style: "style",
  context: "context_note",
} as const;

/**
 * A wiki correction preserves the canonical category of the entry it edits.
 * The first three play-tester kinds were enough for node 8's initial feedback
 * path; the wiki also needs to correct the run-generated scene, character,
 * route, speaker, and terminology entries that already resolve into packets.
 */
export type PlayTesterContextKind = ContextArtifactCategory;

export const PLAY_TESTER_CONTEXT_CORRECTION_TOOL = "tool.play-tester-context-correction";
export const PLAY_TESTER_CONTEXT_CORRECTION_VERSION = "1.0.0";

export type ApplyContextCorrectionInput = {
  /** Defaults to project.import; feedback-originated corrections use feedback.import. */
  authority?: ContextCorrectionAuthority;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  /** Stable ContextEntry identity. Omit only when creating a deterministic new entry. */
  contextArtifactId?: string;
  /** Stable correction/event identity for idempotent queueing and audit joins. */
  correctionId?: string;
  kind: PlayTesterContextKind;
  title: string;
  body: string;
  reason: string;
  /** The units the play tester says this canonical edit changes. */
  affectedUnitIds: readonly string[];
  data?: ContextArtifactJsonRecord;
};

export type ContextCorrectionResult = {
  correctionId: string;
  contextArtifact: ContextArtifactRecord;
  affectedUnitIds: readonly string[];
  invalidatedArtifactIds: readonly string[];
  redraftJob: JobQueueRecord;
};

/**
 * The durable state of the exact queued rerun after a request-time worker
 * drain. A canonical correction is committed before the rerun starts, so a
 * caller must distinguish that successful write from the separate redraft
 * outcome instead of treating every edit receipt as an unqualified success.
 */
export type ContextCorrectionRerunStatus =
  | {
      state: "succeeded";
      jobStatus: "succeeded";
      error: null;
    }
  | {
      state: "pending";
      jobStatus: "queued" | "running" | "retry_waiting";
      error: string | null;
    }
  | {
      state: "failed";
      jobStatus: "dead_letter" | "cancelled";
      error: string | null;
    };

/** A correction receipt enriched by the installed worker's exact job state. */
export type ContextCorrectionRerunResult = ContextCorrectionResult & {
  rerun: ContextCorrectionRerunStatus;
};

export type ContextCorrectionServiceDeps = {
  actor: AuthorizationActor;
  contextArtifacts: ItotoriContextCorrectionPersistencePort;
};

export class ContextCorrectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextCorrectionInputError";
  }
}

/**
 * Direct API/service seam for the play-tester wiki. It accepts canonical
 * context edits across the generated enrichment categories without requiring
 * a separate decision record or result-revision model.
 */
export class ContextCorrectionService {
  constructor(private readonly deps: ContextCorrectionServiceDeps) {}

  async apply(input: ApplyContextCorrectionInput): Promise<ContextCorrectionResult> {
    assertCorrectionInput(input);
    // A retry through WikiBrainService reloads the last canonical entry, whose
    // data already contains node-8's bookkeeping. That bookkeeping must never
    // become part of the semantic correction identity or a retry would append
    // a second version instead of deduplicating the original correction.
    const semanticData = withoutCorrectionMarkers(input.data);
    const contextArtifactId =
      input.contextArtifactId ??
      playTesterContextArtifactId({
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        kind: input.kind,
        title: input.title,
      });
    const correctionId =
      input.correctionId ??
      playTesterContextCorrectionId({
        contextArtifactId,
        sourceRevisionId: input.sourceRevisionId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        reason: input.reason,
        affectedUnitIds: input.affectedUnitIds,
        ...(semanticData === undefined ? {} : { data: semanticData }),
      });

    const persisted = await this.deps.contextArtifacts.persistContextCorrection(this.deps.actor, {
      ...(input.authority === undefined ? {} : { authority: input.authority }),
      correctionId,
      contextArtifactId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      category: input.kind,
      title: input.title.trim(),
      body: input.body,
      reason: input.reason,
      requestedAffectedUnitIds: input.affectedUnitIds,
      data: {
        ...semanticData,
        // Keep a correction-specific marker separate from `data.kind`.
        // Run-generated relationship/term artifacts use `kind` as semantic
        // payload, and overwriting it would make a wiki edit stop resolving
        // as the same context entry on the next packet.
        correctionKind: input.kind,
        correctionId,
      },
      producedByAgent: "play-tester",
      producedByTool: PLAY_TESTER_CONTEXT_CORRECTION_TOOL,
      producerVersion: PLAY_TESTER_CONTEXT_CORRECTION_VERSION,
      provenance: {
        correctionId,
        origin: "play_tester_edit",
        reason: input.reason.trim(),
      },
    });
    const { contextArtifact } = persisted;
    if (contextArtifact.headVersionId === null) {
      throw new Error(`context correction ${correctionId} did not persist a canonical version`);
    }

    return {
      correctionId,
      contextArtifact,
      affectedUnitIds: persisted.affectedUnitIds,
      invalidatedArtifactIds: persisted.invalidatedArtifactIds,
      redraftJob: persisted.redraftJob,
    };
  }
}

export function playTesterContextArtifactId(input: {
  projectId: string;
  localeBranchId: string;
  kind: PlayTesterContextKind;
  title: string;
}): string {
  return `play-tester-context-${shortHash(
    [input.projectId, input.localeBranchId, input.kind, normalize(input.title)].join("\0"),
  )}`;
}

function playTesterContextCorrectionId(input: {
  contextArtifactId: string;
  sourceRevisionId: string;
  kind: PlayTesterContextKind;
  title: string;
  body: string;
  reason: string;
  affectedUnitIds: readonly string[];
  data?: ContextArtifactJsonRecord;
}): string {
  return `context-correction-${shortHash(
    [
      input.contextArtifactId,
      input.sourceRevisionId,
      input.kind,
      input.title,
      input.body,
      input.reason,
      stableJson(input.data ?? {}),
      ...sortedUnique(input.affectedUnitIds),
    ].join("\0"),
  )}`;
}

function assertCorrectionInput(input: ApplyContextCorrectionInput): void {
  for (const [label, value] of [
    ["projectId", input.projectId],
    ["localeBranchId", input.localeBranchId],
    ["sourceRevisionId", input.sourceRevisionId],
    ["title", input.title],
    ["body", input.body],
    ["reason", input.reason],
  ] as const) {
    if (value.trim().length === 0) {
      throw new ContextCorrectionInputError(`context correction ${label} must be non-empty`);
    }
  }
  if (!Object.values(playTesterContextKindValues).includes(input.kind)) {
    throw new ContextCorrectionInputError(`unsupported play-tester context kind ${input.kind}`);
  }
  if (input.affectedUnitIds.some((unitId) => unitId.trim().length === 0)) {
    throw new ContextCorrectionInputError("affectedUnitIds must contain only non-empty ids");
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Remove only node-8-owned metadata before hashing or writing canonical data. */
function withoutCorrectionMarkers(
  data: ContextArtifactJsonRecord | undefined,
): ContextArtifactJsonRecord | undefined {
  if (data === undefined) {
    return undefined;
  }
  const { correctionId: _correctionId, correctionKind: _correctionKind, ...semanticData } = data;
  return semanticData;
}

/** Stable object serialization keeps correction dedupe independent of key order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
