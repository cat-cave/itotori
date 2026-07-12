// Play-tester context correction — the direct shared-brain mutation path.
//
// A correction is deliberately not routed through the reviewer queue or a
// translation-memory writeback. It appends a canonical ContextEntryVersion,
// invalidates the dependent context before advancing the head, then enqueues
// one registered redraft job. The job payload carries provenance only; its
// handler must resolve a fresh ContextPacket when it executes.

import { createHash } from "node:crypto";
import {
  buildRegisteredJobInput,
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
  jobIdempotencyPolicyValues,
  type AuthorizationActor,
  type ContextArtifactJsonRecord,
  type ContextArtifactRecord,
  type ItotoriContextArtifactRepositoryPort,
  type ItotoriEventQueueRepositoryPort,
  type JobQueueRecord,
  type NonEmptyReadonlyArray,
} from "@itotori/db";

export const playTesterContextKindValues = {
  glossary: "glossary",
  style: "style",
  context: "context_note",
} as const;

export type PlayTesterContextKind =
  (typeof playTesterContextKindValues)[keyof typeof playTesterContextKindValues];

export const PLAY_TESTER_CONTEXT_CORRECTION_TOOL = "tool.play-tester-context-correction";
export const PLAY_TESTER_CONTEXT_CORRECTION_VERSION = "1.0.0";

export type ApplyContextCorrectionInput = {
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

export type ContextCorrectionServiceDeps = {
  actor: AuthorizationActor;
  contextArtifacts: ItotoriContextArtifactRepositoryPort;
  jobs: Pick<ItotoriEventQueueRepositoryPort, "enqueueJobs">;
};

export class ContextCorrectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextCorrectionInputError";
  }
}

/**
 * Direct API/service seam for node 9's future play-tester surface. It accepts
 * canonical glossary, style, and free-form context edits without assuming a
 * UI, a reviewer decision, or any result-revision model.
 */
export class ContextCorrectionService {
  constructor(private readonly deps: ContextCorrectionServiceDeps) {}

  async apply(input: ApplyContextCorrectionInput): Promise<ContextCorrectionResult> {
    assertCorrectionInput(input);
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
        body: input.body,
        reason: input.reason,
        affectedUnitIds: input.affectedUnitIds,
      });

    // Include the previous head's citations as well as the edit's new
    // citations. Shrinking a context entry's scope must still refresh units
    // that were influenced by the old head.
    const previous = await this.deps.contextArtifacts.loadArtifact(this.deps.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      contextArtifactId,
    });
    const affectedUnitIds = sortedUnique([
      ...input.affectedUnitIds,
      ...(previous?.sourceUnits.map((sourceUnit) => sourceUnit.bridgeUnitId) ?? []),
    ]);
    if (affectedUnitIds.length === 0) {
      throw new ContextCorrectionInputError(
        "context correction requires at least one affected unit",
      );
    }

    // Node 6 invalidation must happen BEFORE the append. The invalidator marks
    // every active artifact citing these units stale; doing it after upsert
    // would immediately stale the new canonical head too.
    const invalidation = await this.deps.contextArtifacts.invalidateAffectedArtifacts(
      this.deps.actor,
      {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        bridgeUnitIds: affectedUnitIds,
        reason: `play_tester_context_correction:${correctionId}`,
      },
    );
    if (invalidation.status !== "completed") {
      const detail = invalidation.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
      throw new Error(
        `context correction invalidation failed${detail.length === 0 ? "" : `: ${detail}`}`,
      );
    }

    const contextArtifact = await this.deps.contextArtifacts.upsertArtifact(this.deps.actor, {
      contextArtifactId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      category: input.kind,
      title: input.title.trim(),
      body: input.body,
      data: {
        kind: input.kind,
        correctionId,
        ...input.data,
      },
      producedByAgent: "play-tester",
      producedByTool: PLAY_TESTER_CONTEXT_CORRECTION_TOOL,
      producerVersion: PLAY_TESTER_CONTEXT_CORRECTION_VERSION,
      provenance: {
        correctionId,
        origin: "play_tester_edit",
        reason: input.reason.trim(),
      },
      sourceUnits: affectedUnitIds.map((bridgeUnitId) => ({
        bridgeUnitId,
        citation: `play-tester context correction: ${input.reason.trim()}`,
      })),
    });
    if (contextArtifact.headVersionId === null) {
      throw new Error(`context correction ${correctionId} did not persist a canonical version`);
    }

    const nonEmptyAffectedUnitIds = requireNonEmptyAffectedUnitIds(affectedUnitIds);
    const payload = {
      schemaVersion: contextCorrectionRedraftPayloadSchemaVersion,
      correctionId,
      contextArtifactId,
      contextEntryVersionId: contextArtifact.headVersionId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      affectedUnitIds: nonEmptyAffectedUnitIds,
    };
    const jobId = `context-correction-${shortHash(`${correctionId}:${contextArtifact.headVersionId}`)}`;
    const [redraftJob] = await this.deps.jobs.enqueueJobs(this.deps.actor, [
      buildRegisteredJobInput(contextCorrectionRedraftJobName, payload, {
        jobId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        queueName: "context-correction",
        idempotency: {
          policy: jobIdempotencyPolicyValues.idempotent,
          key: `context-correction:${contextArtifact.headVersionId}`,
        },
        correlationId: correctionId,
        causationId: contextArtifact.headVersionId,
        subjectRefs: [
          { subjectKind: "context_artifact", subjectId: contextArtifactId },
          { subjectKind: "context_entry_version", subjectId: contextArtifact.headVersionId },
          { subjectKind: "locale_branch", subjectId: input.localeBranchId },
          ...affectedUnitIds.map((subjectId) => ({ subjectKind: "bridge_unit", subjectId })),
        ],
        priority: 40,
      }),
    ]);
    if (redraftJob === undefined) {
      throw new Error(`context correction ${correctionId} did not enqueue a redraft job`);
    }

    return {
      correctionId,
      contextArtifact,
      affectedUnitIds,
      invalidatedArtifactIds: invalidation.invalidatedArtifactIds,
      redraftJob,
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
  body: string;
  reason: string;
  affectedUnitIds: readonly string[];
}): string {
  return `context-correction-${shortHash(
    [
      input.contextArtifactId,
      input.sourceRevisionId,
      input.body,
      input.reason,
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

function requireNonEmptyAffectedUnitIds(values: readonly string[]): NonEmptyReadonlyArray<string> {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new ContextCorrectionInputError("context correction requires at least one affected unit");
  }
  return [first, ...rest];
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
