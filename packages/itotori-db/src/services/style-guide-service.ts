import type { AuthorizationActor } from "../authorization.js";
import { outboxEventTypeValues } from "../schema.js";
import type {
  ItotoriEventQueueRepositoryPort,
  OutboxEventRecord,
} from "../repositories/event-queue-repository.js";
import type {
  CreateStyleGuideVersionInput,
  ItotoriStyleGuideRepositoryPort,
  SourceRevisionReference,
  StyleGuideVersionRecord,
} from "../repositories/style-guide-repository.js";

export const styleGuidePolicySchemaVersion = "style-guide-policy.v0";
export const styleGuideVersionChangedPayloadSchemaVersion =
  "itotori.style_guide_version_changed.v1";

export type StyleGuideDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  reasonCode: string;
  field?: string;
  metadata?: Record<string, unknown>;
};

export type StyleGuideVersionChangedPayload = {
  schemaVersion: typeof styleGuideVersionChangedPayloadSchemaVersion;
  eventName: "StyleGuideVersionChanged";
  changeKind: "version_created" | "version_approved";
  projectId: string;
  localeBranchId: string;
  previousVersionId: string | null;
  newVersionId: string;
  sourceRevisionReference: SourceRevisionReference;
};

export type SubmitStyleGuideVersionInput = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId?: string;
  expectedPreviousVersionId?: string | null;
  policy: Record<string, unknown>;
};

export type ApproveStyleGuideVersionCommand = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId: string;
  expectedLatestVersionId: string;
};

export type StyleGuideCommandResult = {
  status: "created" | "approved" | "invalid";
  diagnostics: StyleGuideDiagnostic[];
  version?: StyleGuideVersionRecord;
  outboxEvent?: OutboxEventRecord;
};

export class ItotoriStyleGuideService {
  constructor(
    private readonly repository: ItotoriStyleGuideRepositoryPort,
    private readonly queueRepository: ItotoriEventQueueRepositoryPort,
  ) {}

  async submitVersion(
    actor: AuthorizationActor,
    input: SubmitStyleGuideVersionInput,
  ): Promise<StyleGuideCommandResult> {
    const branch = await this.repository.getLocaleBranchContext(
      input.projectId,
      input.localeBranchId,
    );
    if (branch === null) {
      return invalid(
        diagnostic(
          "style_guide.locale_branch.missing",
          "error",
          `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
          "missing_locale_branch",
          "$.localeBranchId",
        ),
      );
    }

    const latest = await this.repository.getLatestVersionByLocaleBranchId(input.localeBranchId);
    const previousVersionId = latest?.styleGuideVersionId ?? null;
    if (
      input.expectedPreviousVersionId !== undefined &&
      input.expectedPreviousVersionId !== previousVersionId
    ) {
      return invalid(
        diagnostic(
          "style_guide.version.stale_write",
          "error",
          "style guide version write is based on a stale previous version",
          "stale_previous_version",
          "$.expectedPreviousVersionId",
          {
            expectedPreviousVersionId: input.expectedPreviousVersionId,
            latestVersionId: previousVersionId,
          },
        ),
      );
    }

    const policyDiagnostics = validatePolicy(input.policy);
    if (policyDiagnostics.some((entry) => entry.severity === "error")) {
      return { status: "invalid", diagnostics: policyDiagnostics };
    }

    const createInput: CreateStyleGuideVersionInput = {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      policy: input.policy,
      semanticDiagnostics: policyDiagnostics,
      ...(input.styleGuideVersionId === undefined
        ? {}
        : { styleGuideVersionId: input.styleGuideVersionId }),
    };
    const version = await this.repository.createVersion(actor, createInput);
    const outboxEvent = await this.appendVersionChangedEvent(actor, {
      changeKind: "version_created",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      previousVersionId,
      newVersionId: version.styleGuideVersionId,
      sourceRevisionReference: version.sourceRevisionReference,
    });

    return { status: "created", diagnostics: [], version, outboxEvent };
  }

  async approveVersion(
    actor: AuthorizationActor,
    input: ApproveStyleGuideVersionCommand,
  ): Promise<StyleGuideCommandResult> {
    const branch = await this.repository.getLocaleBranchContext(
      input.projectId,
      input.localeBranchId,
    );
    if (branch === null) {
      return invalid(
        diagnostic(
          "style_guide.locale_branch.missing",
          "error",
          `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
          "missing_locale_branch",
          "$.localeBranchId",
        ),
      );
    }

    const latest = await this.repository.getLatestVersionByLocaleBranchId(input.localeBranchId);
    if (latest === null || latest.styleGuideVersionId !== input.expectedLatestVersionId) {
      return invalid(
        diagnostic(
          "style_guide.approval.stale_version",
          "error",
          "style guide approval is based on a stale version",
          "stale_approval",
          "$.expectedLatestVersionId",
          {
            expectedLatestVersionId: input.expectedLatestVersionId,
            latestVersionId: latest?.styleGuideVersionId ?? null,
          },
        ),
      );
    }
    if (input.styleGuideVersionId !== latest.styleGuideVersionId) {
      return invalid(
        diagnostic(
          "style_guide.approval.not_latest_version",
          "error",
          "only the latest style guide version can be approved",
          "approval_target_not_latest",
          "$.styleGuideVersionId",
          {
            requestedVersionId: input.styleGuideVersionId,
            latestVersionId: latest.styleGuideVersionId,
          },
        ),
      );
    }

    const approved = await this.repository.approveVersion(actor, input);
    const outboxEvent = await this.appendVersionChangedEvent(actor, {
      changeKind: "version_approved",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      previousVersionId: approved.previousApprovedVersionId,
      newVersionId: approved.version.styleGuideVersionId,
      sourceRevisionReference: approved.version.sourceRevisionReference,
    });

    return {
      status: "approved",
      diagnostics: [],
      version: approved.version,
      outboxEvent,
    };
  }

  private async appendVersionChangedEvent(
    actor: AuthorizationActor,
    payload: Omit<StyleGuideVersionChangedPayload, "schemaVersion" | "eventName">,
  ): Promise<OutboxEventRecord> {
    const eventPayload: StyleGuideVersionChangedPayload = {
      schemaVersion: styleGuideVersionChangedPayloadSchemaVersion,
      eventName: "StyleGuideVersionChanged",
      ...payload,
    };
    return this.queueRepository.appendOutboxEvent(actor, {
      projectId: payload.projectId,
      localeBranchId: payload.localeBranchId,
      eventType: outboxEventTypeValues.styleGuideVersionChanged,
      idempotencyKey: [
        "style-guide-version-changed",
        payload.changeKind,
        payload.localeBranchId,
        payload.previousVersionId ?? "none",
        payload.newVersionId,
      ].join(":"),
      payload: eventPayload,
    });
  }
}

export function validatePolicy(policy: Record<string, unknown>): StyleGuideDiagnostic[] {
  const diagnostics: StyleGuideDiagnostic[] = [];
  if (policy.schemaVersion !== styleGuidePolicySchemaVersion) {
    diagnostics.push(
      diagnostic(
        "style_guide.policy.schema_version",
        "error",
        `style guide policy schemaVersion must be ${styleGuidePolicySchemaVersion}`,
        "malformed_policy",
        "$.schemaVersion",
      ),
    );
  }

  const sections = policy.sections;
  if (!isRecord(sections)) {
    diagnostics.push(
      diagnostic(
        "style_guide.policy.sections_missing",
        "error",
        "style guide policy sections must be an object",
        "malformed_policy_sections",
        "$.sections",
      ),
    );
    return diagnostics;
  }

  for (const sectionName of ["tone", "terminology", "honorifics", "formatting", "protectedSpans"]) {
    const section = sections[sectionName];
    if (!Array.isArray(section)) {
      diagnostics.push(
        diagnostic(
          "style_guide.policy_section.malformed",
          "error",
          `style guide policy section ${sectionName} must be an array`,
          "malformed_policy_section",
          `$.sections.${sectionName}`,
        ),
      );
      continue;
    }
    for (const [index, entry] of section.entries()) {
      if (
        !isRecord(entry) ||
        stringValue(entry.ruleId) === null ||
        stringValue(entry.guidance) === null
      ) {
        diagnostics.push(
          diagnostic(
            "style_guide.policy_section.rule_malformed",
            "error",
            `style guide policy section ${sectionName}[${index}] must include ruleId and guidance`,
            "malformed_policy_rule",
            `$.sections.${sectionName}[${index}]`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

function diagnostic(
  code: string,
  severity: StyleGuideDiagnostic["severity"],
  message: string,
  reasonCode: string,
  field?: string,
  metadata?: Record<string, unknown>,
): StyleGuideDiagnostic {
  return {
    code,
    severity,
    message,
    reasonCode,
    ...(field === undefined ? {} : { field }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function invalid(...diagnostics: StyleGuideDiagnostic[]): StyleGuideCommandResult {
  return { status: "invalid", diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
