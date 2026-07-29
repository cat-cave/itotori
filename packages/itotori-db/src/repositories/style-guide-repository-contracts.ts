import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type { StyleGuideVersionStatus } from "../schema.js";
import type { OutboxEventRecord } from "./event-queue-repository.js";
import { stableJsonStringify } from "../stable-json.js";

export const styleGuideVersionChangedPayloadSchemaVersion =
  "itotori.style_guide_version_changed.v1";
export const affectedWorkInvalidatedPayloadSchemaVersion = "itotori.affected_work_invalidated.v1";

export type StyleGuideRecord = {
  styleGuideId: string;
  projectId: string;
  localeBranchId: string;
  latestVersionId: string | null;
  approvedVersionId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SourceRevisionReference = {
  sourceRevisionId: string;
  revisionKind: string;
  value: string;
};

export type LocaleBranchStyleGuideContext = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceBundleId: string;
  sourceRevisionReference: SourceRevisionReference;
};

export type StyleGuideVersionRecord = {
  styleGuideVersionId: string;
  styleGuideId: string;
  projectId: string;
  localeBranchId: string;
  previousVersionId: string | null;
  sourceRevisionReference: SourceRevisionReference;
  versionSequence: number;
  authorUserId: string;
  approverUserId: string | null;
  status: StyleGuideVersionStatus;
  contentHash: string;
  policy: Record<string, unknown>;
  semanticDiagnostics: Record<string, unknown>[];
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The full approval boundary carried by every primary style-guide approval
 * event. It is captured independently of affected-work fanout so an approval is
 * audit-complete even when no downstream work is invalidated.
 */
export type StyleGuideApprovalBoundary = {
  approverUserId: string;
  localeBranchId: string;
  priorVersionId: string | null;
  approvedVersionId: string;
  sourceRevisionBoundary: {
    prior: SourceRevisionReference | null;
    approved: SourceRevisionReference;
  };
};

type StyleGuideVersionChangedPayloadBase = {
  schemaVersion: typeof styleGuideVersionChangedPayloadSchemaVersion;
  eventName: "StyleGuideVersionChanged";
  projectId: string;
  localeBranchId: string;
  previousVersionId: string | null;
  newVersionId: string;
  sourceRevisionReference: SourceRevisionReference;
};

export type StyleGuideVersionCreatedPayload = StyleGuideVersionChangedPayloadBase & {
  changeKind: "version_created";
};

export type StyleGuideVersionApprovedPayload = StyleGuideVersionChangedPayloadBase & {
  changeKind: "version_approved";
  /**
   * The complete approval boundary is ALWAYS present on the primary approval
   * event, regardless of whether any AffectedWorkInvalidated fanout events are
   * emitted alongside it.
   */
  approvalBoundary: StyleGuideApprovalBoundary;
};

export type StyleGuideVersionChangedPayload =
  | StyleGuideVersionCreatedPayload
  | StyleGuideVersionApprovedPayload;

/**
 * Builds the primary style-guide "version created" event payload. Pure: no DB
 * access, so the event contract can be validated DB-less.
 */
export function buildStyleGuideVersionCreatedPayload(input: {
  projectId: string;
  localeBranchId: string;
  previousVersionId: string | null;
  version: StyleGuideVersionRecord;
}): StyleGuideVersionCreatedPayload {
  return {
    schemaVersion: styleGuideVersionChangedPayloadSchemaVersion,
    eventName: "StyleGuideVersionChanged",
    changeKind: "version_created",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    previousVersionId: input.previousVersionId,
    newVersionId: input.version.styleGuideVersionId,
    sourceRevisionReference: input.version.sourceRevisionReference,
  };
}

/**
 * Builds the primary style-guide APPROVAL event payload. Pure: no DB access.
 *
 * The returned payload ALWAYS carries the full approval boundary — approver id,
 * locale branch id, prior version id, approved version id, and the prior→approved
 * source-revision boundary — independent of whether any affected-work fanout
 * exists. This keeps every approval audit-complete on its own.
 */
export function buildStyleGuideApprovalEventPayload(input: {
  projectId: string;
  localeBranchId: string;
  approverUserId: string;
  priorVersion: StyleGuideVersionRecord | null;
  approvedVersion: StyleGuideVersionRecord;
}): StyleGuideVersionApprovedPayload {
  const priorVersionId = input.priorVersion?.styleGuideVersionId ?? null;
  return {
    schemaVersion: styleGuideVersionChangedPayloadSchemaVersion,
    eventName: "StyleGuideVersionChanged",
    changeKind: "version_approved",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    previousVersionId: priorVersionId,
    newVersionId: input.approvedVersion.styleGuideVersionId,
    sourceRevisionReference: input.approvedVersion.sourceRevisionReference,
    approvalBoundary: {
      approverUserId: input.approverUserId,
      localeBranchId: input.localeBranchId,
      priorVersionId,
      approvedVersionId: input.approvedVersion.styleGuideVersionId,
      sourceRevisionBoundary: {
        prior: input.priorVersion?.sourceRevisionReference ?? null,
        approved: input.approvedVersion.sourceRevisionReference,
      },
    },
  };
}

/**
 * Contract for the primary style-guide version-changed event payload.
 *
 * Enforces that every APPROVAL event (`changeKind === "version_approved"`)
 * carries a complete approval boundary — approver id, locale branch id, prior
 * version id (nullable but present), approved version id, and the source-revision
 * boundary (prior nullable but present, approved required). Throws when a
 * boundary field is missing so consumers can reject audit-incomplete events.
 */
export function assertStyleGuideVersionChangedPayload(
  payload: unknown,
): asserts payload is StyleGuideVersionChangedPayload {
  if (!isRecord(payload)) {
    throw new Error("style guide version changed payload must be an object");
  }
  if (payload.schemaVersion !== styleGuideVersionChangedPayloadSchemaVersion) {
    throw new Error(
      `style guide version changed payload schemaVersion must be ${styleGuideVersionChangedPayloadSchemaVersion}`,
    );
  }
  if (payload.eventName !== "StyleGuideVersionChanged") {
    throw new Error(
      'style guide version changed payload eventName must be "StyleGuideVersionChanged"',
    );
  }
  requireString(payload, "projectId");
  requireString(payload, "localeBranchId");
  requireNullableStringKey(payload, "previousVersionId");
  requireString(payload, "newVersionId");
  assertSourceRevisionReference(payload.sourceRevisionReference, "sourceRevisionReference");

  if (payload.changeKind !== "version_created" && payload.changeKind !== "version_approved") {
    throw new Error(
      'style guide version changed payload changeKind must be "version_created" or "version_approved"',
    );
  }

  if (payload.changeKind === "version_approved") {
    assertStyleGuideApprovalBoundary(payload.approvalBoundary);
  }
}

/**
 * Contract for the approval boundary. Rejects a payload that is missing any of
 * the five boundary fields, so a fanout-less approval cannot silently drop the
 * audit boundary.
 */
export function assertStyleGuideApprovalBoundary(
  boundary: unknown,
): asserts boundary is StyleGuideApprovalBoundary {
  if (!isRecord(boundary)) {
    throw new Error("style guide approval event must carry an approvalBoundary object");
  }
  requireString(boundary, "approverUserId", "approvalBoundary.approverUserId");
  requireString(boundary, "localeBranchId", "approvalBoundary.localeBranchId");
  requireNullableStringKey(boundary, "priorVersionId", "approvalBoundary.priorVersionId");
  requireString(boundary, "approvedVersionId", "approvalBoundary.approvedVersionId");

  const sourceRevisionBoundary = boundary.sourceRevisionBoundary;
  if (!isRecord(sourceRevisionBoundary)) {
    throw new Error("approvalBoundary.sourceRevisionBoundary must be an object");
  }
  if (!("prior" in sourceRevisionBoundary)) {
    throw new Error("approvalBoundary.sourceRevisionBoundary.prior must be present");
  }
  if (sourceRevisionBoundary.prior !== null) {
    assertSourceRevisionReference(
      sourceRevisionBoundary.prior,
      "approvalBoundary.sourceRevisionBoundary.prior",
    );
  }
  assertSourceRevisionReference(
    sourceRevisionBoundary.approved,
    "approvalBoundary.sourceRevisionBoundary.approved",
  );
}

function assertSourceRevisionReference(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a source revision reference object`);
  }
  requireString(value, "sourceRevisionId", `${path}.sourceRevisionId`);
  requireString(value, "revisionKind", `${path}.revisionKind`);
  requireString(value, "value", `${path}.value`);
}

function requireString(record: Record<string, unknown>, key: string, path = key): void {
  if (typeof record[key] !== "string") {
    throw new Error(`${path} must be a string`);
  }
}

function requireNullableStringKey(record: Record<string, unknown>, key: string, path = key): void {
  if (!(key in record)) {
    throw new Error(`${path} must be present`);
  }
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${path} must be a string or null`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type AffectedWorkSurface = "drafts" | "qa_findings" | "exports" | "benchmarks";

export type AffectedWorkReference =
  | {
      surface: "drafts";
      draftId: string;
      bridgeUnitId: string;
    }
  | {
      surface: "qa_findings";
      findingId: string;
    }
  | {
      surface: "exports";
      artifactId: string;
      artifactKind: string;
    }
  | {
      surface: "benchmarks";
      artifactId: string;
      artifactKind: string;
    };

export type AffectedWorkInvalidatedPayload = {
  schemaVersion: typeof affectedWorkInvalidatedPayloadSchemaVersion;
  eventName: "AffectedWorkInvalidated";
  invalidationKind: "style_guide_version_approved";
  projectId: string;
  localeBranchId: string;
  approverUserId: string;
  priorStyleGuideVersionId: string;
  approvedStyleGuideVersionId: string;
  sourceRevisionBoundary: {
    prior: SourceRevisionReference;
    approved: SourceRevisionReference;
  };
  affectedWork: {
    surface: AffectedWorkSurface;
    count: number;
    references: AffectedWorkReference[];
  };
};

export type CreateStyleGuideVersionInput = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId?: string;
  expectedPreviousVersionId?: string | null;
  sourceRevisionId?: string;
  authorUserId?: string;
  status?: StyleGuideVersionStatus;
  contentHash?: string;
  policy: Record<string, unknown>;
  semanticDiagnostics?: Record<string, unknown>[];
};

export type ApproveStyleGuideVersionInput = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId: string;
  expectedLatestVersionId: string;
  approverUserId?: string;
};

export type CreateStyleGuideVersionResult = {
  version: StyleGuideVersionRecord;
  outboxEvent: OutboxEventRecord;
};

export type ApproveStyleGuideVersionResult = {
  previousApprovedVersionId: string | null;
  version: StyleGuideVersionRecord;
  outboxEvent: OutboxEventRecord;
  invalidationOutboxEvents: OutboxEventRecord[];
};

export interface ItotoriStyleGuideRepositoryPort {
  /**
   * Fail-closed approval authorization. Callers (the approval service) MUST
   * invoke this BEFORE reading any branch/version latest-state, so an
   * unauthorized caller is denied without any branch/version detail being read
   * or leaked back to them. Throws {@link AuthorizationError} when the actor
   * lacks the dedicated `style_guide.approve` permission.
   */
  authorizeApproval(actor: AuthorizationActor): Promise<void>;
  getLocaleBranchContext(
    projectId: string,
    localeBranchId: string,
  ): Promise<LocaleBranchStyleGuideContext | null>;
  getStyleGuideByLocaleBranchId(localeBranchId: string): Promise<StyleGuideRecord | null>;
  getLatestVersionByLocaleBranchId(localeBranchId: string): Promise<StyleGuideVersionRecord | null>;
  getApprovedVersionByLocaleBranchId(
    localeBranchId: string,
  ): Promise<StyleGuideVersionRecord | null>;
  listVersionsByLocaleBranchId(localeBranchId: string): Promise<StyleGuideVersionRecord[]>;
  createVersion(
    actor: AuthorizationActor,
    input: CreateStyleGuideVersionInput,
  ): Promise<CreateStyleGuideVersionResult>;
  approveVersion(
    actor: AuthorizationActor,
    input: ApproveStyleGuideVersionInput,
  ): Promise<ApproveStyleGuideVersionResult>;
}

export function contentHashForPolicy(policy: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(policy)).digest("hex")}`;
}
