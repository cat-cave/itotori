// Additional community-channel importer: generic form-response exports.
//
// This is intentionally an exported-file adapter, not a live forms-provider
// client. Callers provide recorded JSON from their form system at the adapter
// boundary, and this importer maps each response into the proven manual
// feedback path with source metadata, external-id dedup, and PII redaction.

import {
  feedbackSourceKindValues,
  feedbackTypeValues,
  type FeedbackType,
  type ManualFeedbackImportInput,
  type ManualFeedbackLineReference,
} from "../repositories/feedback-repository.js";
import { redactChannelPii, type ChannelRedaction } from "./redaction.js";
import {
  ChannelImportError,
  type ChannelExternalRef,
  type ChannelFeedbackImportItem,
  type ChannelFeedbackImporter,
  type ChannelImportOptions,
} from "./types.js";

export const COMMUNITY_FORMS_CHANNEL = "community_forms" as const;

/** External form data may omit the canonical bridge-unit target. */
type CommunityFormLineReference = Omit<ManualFeedbackLineReference, "bridgeUnitId"> & {
  bridgeUnitId?: string;
};

export type CommunityFormFeedbackKind =
  | "objective_defect"
  | "style_preference"
  | "glossary_canon_issue"
  | "unclear_context"
  | "runtime_issue"
  | "asset_issue";

export type CommunityFormResponseRecord = {
  responseId: string;
  submittedAt?: string;
  respondent?: {
    respondentId?: string;
    displayName?: string;
  };
  feedbackType?: CommunityFormFeedbackKind;
  title?: string;
  note: string;
  url?: string;
  lineReference?: CommunityFormLineReference;
  tags?: string[];
};

export type CommunityFormsExport = {
  formId: string;
  formTitle: string;
  sourceUrl?: string;
  responses: CommunityFormResponseRecord[];
};

const FORM_FEEDBACK_TYPE: Record<CommunityFormFeedbackKind, FeedbackType> = {
  objective_defect: feedbackTypeValues.objectiveDefect,
  style_preference: feedbackTypeValues.stylePreference,
  glossary_canon_issue: feedbackTypeValues.glossaryCanonIssue,
  unclear_context: feedbackTypeValues.unclearContext,
  runtime_issue: feedbackTypeValues.runtimeIssue,
  asset_issue: feedbackTypeValues.assetIssue,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, `${context} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, `${context} must be a string`);
  }
  return value;
}

function parseLineReference(value: unknown): CommunityFormLineReference | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ChannelImportError(
      COMMUNITY_FORMS_CHANNEL,
      "response.lineReference must be an object",
    );
  }
  const lineReference: CommunityFormLineReference = {};
  for (const key of [
    "bridgeUnitId",
    "sourceUnitKey",
    "sourceHash",
    "assetId",
    "path",
    "quotedText",
  ] as const) {
    const entry = value[key];
    if (entry !== undefined) {
      lineReference[key] = requireString(entry, `response.lineReference.${key}`);
    }
  }
  for (const key of ["line", "column"] as const) {
    const entry = value[key];
    if (entry !== undefined) {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
        throw new ChannelImportError(
          COMMUNITY_FORMS_CHANNEL,
          `response.lineReference.${key} must be a non-negative integer`,
        );
      }
      lineReference[key] = entry;
    }
  }
  if (value.sourceLocation !== undefined) {
    if (!isRecord(value.sourceLocation)) {
      throw new ChannelImportError(
        COMMUNITY_FORMS_CHANNEL,
        "response.lineReference.sourceLocation must be an object",
      );
    }
    lineReference.sourceLocation = value.sourceLocation;
  }
  return Object.keys(lineReference).length === 0 ? undefined : lineReference;
}

function parseFeedbackType(value: unknown): FeedbackType {
  if (value === undefined || value === null) {
    return feedbackTypeValues.stylePreference;
  }
  if (typeof value !== "string" || !(value in FORM_FEEDBACK_TYPE)) {
    throw new ChannelImportError(
      COMMUNITY_FORMS_CHANNEL,
      `response.feedbackType must be one of ${Object.keys(FORM_FEEDBACK_TYPE).join(", ")}`,
    );
  }
  return FORM_FEEDBACK_TYPE[value as CommunityFormFeedbackKind];
}

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, "response.tags must be an array");
  }
  return value.map((tag, index) => requireString(tag, `response.tags[${String(index)}]`));
}

function parseResponse(value: unknown): CommunityFormResponseRecord {
  if (!isRecord(value)) {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, "response must be an object");
  }
  const respondent = value.respondent;
  if (respondent !== undefined && !isRecord(respondent)) {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, "response.respondent must be an object");
  }
  const record: CommunityFormResponseRecord = {
    responseId: requireString(value.responseId, "response.responseId"),
    note: requireString(value.note, "response.note"),
  };
  const submittedAt = optionalString(value.submittedAt, "response.submittedAt");
  if (submittedAt !== undefined) record.submittedAt = submittedAt;
  const title = optionalString(value.title, "response.title");
  if (title !== undefined) record.title = title;
  const url = optionalString(value.url, "response.url");
  if (url !== undefined) record.url = url;
  const feedbackType = optionalString(value.feedbackType, "response.feedbackType");
  if (feedbackType !== undefined) {
    record.feedbackType = feedbackType as CommunityFormFeedbackKind;
  }
  const lineReference = parseLineReference(value.lineReference);
  if (lineReference !== undefined) record.lineReference = lineReference;
  const tags = parseTags(value.tags);
  if (tags.length > 0) record.tags = tags;
  if (isRecord(respondent)) {
    const respondentRecord: NonNullable<CommunityFormResponseRecord["respondent"]> = {};
    const respondentId = optionalString(
      respondent.respondentId,
      "response.respondent.respondentId",
    );
    if (respondentId !== undefined) respondentRecord.respondentId = respondentId;
    const displayName = optionalString(respondent.displayName, "response.respondent.displayName");
    if (displayName !== undefined) respondentRecord.displayName = displayName;
    if (Object.keys(respondentRecord).length > 0) {
      record.respondent = respondentRecord;
    }
  }
  return record;
}

function parseExport(value: unknown): CommunityFormsExport {
  if (!isRecord(value)) {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, "export must be an object");
  }
  if (!Array.isArray(value.responses)) {
    throw new ChannelImportError(COMMUNITY_FORMS_CHANNEL, "export.responses must be an array");
  }
  const sourceUrl = optionalString(value.sourceUrl, "export.sourceUrl");
  const parsed: CommunityFormsExport = {
    formId: requireString(value.formId, "export.formId"),
    formTitle: requireString(value.formTitle, "export.formTitle"),
    responses: value.responses.map((response) => parseResponse(response)),
  };
  if (sourceUrl !== undefined) parsed.sourceUrl = sourceUrl;
  return parsed;
}

/** Community form-response importer for recorded/exported JSON form data. */
export class CommunityFormsImporter implements ChannelFeedbackImporter<CommunityFormsExport> {
  readonly channel = COMMUNITY_FORMS_CHANNEL;

  mapExport(sourceExport: unknown, options: ChannelImportOptions): ChannelFeedbackImportItem[] {
    const parsed = parseExport(sourceExport);
    const localeBranchId = requiredLocaleBranchId(options);
    const feedbackSourceId = `feedback-source:community_forms:${parsed.formId}`;
    const privacyClassification = options.privacyClassification ?? "community";

    return parsed.responses.map((response) =>
      this.mapResponse(
        response,
        parsed,
        feedbackSourceId,
        privacyClassification,
        options,
        localeBranchId,
      ),
    );
  }

  private mapResponse(
    response: CommunityFormResponseRecord,
    sourceExport: CommunityFormsExport,
    feedbackSourceId: string,
    privacyClassification: string,
    options: ChannelImportOptions,
    localeBranchId: string,
  ): ChannelFeedbackImportItem {
    const externalId = `${sourceExport.formId}:${response.responseId}`;
    const externalRef: ChannelExternalRef = {
      channel: this.channel,
      externalId,
      ...(response.url === undefined ? {} : { url: response.url }),
    };
    const rawNote =
      response.title === undefined ? response.note : `${response.title}\n\n${response.note}`;
    const { text: reporterNote, redactions, redacted } = redactChannelPii(rawNote);
    const respondent = response.respondent ?? {};
    const tags = response.tags ?? [];

    const input: ManualFeedbackImportInput = {
      projectId: options.projectId,
      localeBranchId,
      ...(options.sourceBundleId === undefined ? {} : { sourceBundleId: options.sourceBundleId }),
      lineReference: lineReferenceFor(response.lineReference, options),
      feedbackType: parseFeedbackType(response.feedbackType),
      reporter: {
        role: "community",
        ...(respondent.respondentId === undefined ? {} : { reporterId: respondent.respondentId }),
        ...(respondent.displayName === undefined ? {} : { displayName: respondent.displayName }),
      },
      reporterNote,
      dedupeKey: externalId,
      feedbackSourceId,
      feedbackSource: {
        feedbackSourceId,
        sourceKind: feedbackSourceKindValues.communityChannel,
        label: `Community form: ${sourceExport.formTitle}`,
        sourceChannel: this.channel,
        privacyReviewState: redacted ? "redacted_pending_review" : "pending",
        metadata: {
          channel: this.channel,
          formId: sourceExport.formId,
          formTitle: sourceExport.formTitle,
          ...(sourceExport.sourceUrl === undefined ? {} : { sourceUrl: sourceExport.sourceUrl }),
        },
      },
      privacyClassification,
      redactionState: redacted ? "redacted" : "raw",
      ...(response.submittedAt === undefined ? {} : { reportedAt: response.submittedAt }),
      metadata: {
        channel: this.channel,
        externalId,
        responseId: response.responseId,
        formId: sourceExport.formId,
        formTitle: sourceExport.formTitle,
        ...(response.url === undefined ? {} : { url: response.url }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(redacted
          ? { redactedPii: redactions.map((redaction: ChannelRedaction) => redaction.kind) }
          : {}),
      },
    };

    return { input, externalRef, redactions };
  }
}

function requiredLocaleBranchId(options: ChannelImportOptions): string {
  const localeBranchId = options.localeBranchId.trim();
  if (localeBranchId.length === 0) {
    throw new ChannelImportError(
      COMMUNITY_FORMS_CHANNEL,
      "localeBranchId must be a non-empty string",
    );
  }
  return localeBranchId;
}

function lineReferenceFor(
  source: CommunityFormLineReference | undefined,
  options: ChannelImportOptions,
): ManualFeedbackLineReference {
  const bridgeUnitId = source?.bridgeUnitId?.trim() || options.bridgeUnitId?.trim();
  if (bridgeUnitId === undefined || bridgeUnitId.length === 0) {
    throw new ChannelImportError(
      COMMUNITY_FORMS_CHANNEL,
      "each form response needs lineReference.bridgeUnitId or an explicit bridgeUnitId import target",
    );
  }
  const { bridgeUnitId: _sourceBridgeUnitId, ...detail } = source ?? {};
  return { bridgeUnitId, ...detail };
}
