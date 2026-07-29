import {
  feedbackSourceKindValues,
  feedbackTypeValues,
  type FeedbackReporter,
  type ManualFeedbackAttachment,
  type ManualFeedbackContextAttachment,
  type ManualFeedbackImportInput,
  type ManualFeedbackLineReference,
  type ManualFeedbackRuntimeArtifactAttachment,
  type ManualFeedbackSaveContextAttachment,
  type ManualFeedbackScreenshotAttachment,
  type ManualFeedbackSourceInput,
} from "./feedback-repository-types.js";
import { isRecord } from "./feedback-repository-utils.js";

export function parseManualFeedbackImportInput(value: unknown): ManualFeedbackImportInput {
  const input = requireRecord(value, "manual feedback input");
  if ("targetLocale" in input) {
    throw new Error(
      "manual feedback targetLocale is server-owned by localeBranchId and must not be supplied",
    );
  }
  const parsed: ManualFeedbackImportInput = {
    projectId: requiredString(input, "projectId"),
    localeBranchId: requiredNonBlankString(input, "localeBranchId"),
    feedbackType: requiredEnum(input, "feedbackType", Object.values(feedbackTypeValues)),
    reporter: parseReporter(input.reporter),
    reporterNote: requiredString(input, "reporterNote"),
    lineReference: parseLineReference(input.lineReference),
  };

  assignOptionalString(parsed, input, "feedbackReportId");
  assignOptionalString(parsed, input, "feedbackEvidenceId");
  assignOptionalString(parsed, input, "feedbackSourceId");
  assignOptionalString(parsed, input, "sourceBundleId");
  assignOptionalString(parsed, input, "privacyClassification");
  assignOptionalString(parsed, input, "redactionState");
  assignOptionalString(parsed, input, "reportedAt");
  assignOptionalString(parsed, input, "dedupeKey");
  assignOptionalString(parsed, input, "suggestedEdit");

  if (input.feedbackSource !== undefined) {
    parsed.feedbackSource = parseFeedbackSourceInput(input.feedbackSource);
  }
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) {
      throw new Error("manual feedback attachments must be an array");
    }
    parsed.attachments = input.attachments.map((attachment, index) =>
      parseAttachment(attachment, `manual feedback attachments[${index}]`),
    );
  }
  if (input.metadata !== undefined) {
    parsed.metadata = requireRecord(input.metadata, "manual feedback metadata");
  }
  if (parsed.reportedAt !== undefined && Number.isNaN(new Date(parsed.reportedAt).getTime())) {
    throw new Error("manual feedback reportedAt must be a valid date string");
  }

  return parsed;
}

function parseReporter(value: unknown): FeedbackReporter {
  const reporter = requireRecord(value, "manual feedback reporter");
  const parsed: FeedbackReporter = {
    role: requiredString(reporter, "reporter.role"),
  };
  assignOptionalString(parsed, reporter, "reporterId");
  assignOptionalString(parsed, reporter, "displayName");
  assignOptionalString(parsed, reporter, "contact");
  return parsed;
}

function parseFeedbackSourceInput(value: unknown): ManualFeedbackSourceInput {
  const source = requireRecord(value, "manual feedback feedbackSource");
  const parsed: ManualFeedbackSourceInput = {};
  assignOptionalString(parsed, source, "feedbackSourceId");
  if (source.sourceKind !== undefined) {
    parsed.sourceKind = requiredEnum(
      source,
      "feedbackSource.sourceKind",
      Object.values(feedbackSourceKindValues),
    );
  }
  assignOptionalString(parsed, source, "label");
  assignOptionalString(parsed, source, "sourceChannel");
  assignOptionalString(parsed, source, "privacyReviewState");
  if (source.metadata !== undefined) {
    parsed.metadata = requireRecord(source.metadata, "feedbackSource.metadata");
  }
  return parsed;
}

function parseLineReference(value: unknown): ManualFeedbackLineReference {
  const reference = requireRecord(value, "manual feedback lineReference");
  const parsed: ManualFeedbackLineReference = {
    bridgeUnitId: requiredNonBlankString(reference, "lineReference.bridgeUnitId"),
  };
  assignOptionalString(parsed, reference, "sourceUnitKey");
  assignOptionalString(parsed, reference, "sourceHash");
  assignOptionalString(parsed, reference, "assetId");
  assignOptionalString(parsed, reference, "path");
  assignOptionalNumber(parsed, reference, "line");
  assignOptionalNumber(parsed, reference, "column");
  assignOptionalString(parsed, reference, "quotedText");
  if (reference.sourceLocation !== undefined) {
    parsed.sourceLocation = requireRecord(reference.sourceLocation, "lineReference.sourceLocation");
  }
  return parsed;
}

function parseAttachment(value: unknown, context: string): ManualFeedbackAttachment {
  const attachment = requireRecord(value, context);
  const base: Omit<
    ManualFeedbackScreenshotAttachment,
    "attachmentKind" | "caption" | "capturePosition" | "evidenceTier"
  > = {};
  assignOptionalString(base, attachment, "attachmentId");
  assignOptionalString(base, attachment, "artifactId");
  assignOptionalString(base, attachment, "uri");
  assignOptionalString(base, attachment, "hash");
  if (attachment.metadata !== undefined) {
    base.metadata = requireRecord(attachment.metadata, `${context}.metadata`);
  }

  const attachmentKind = requiredEnum(attachment, `${context}.attachmentKind`, [
    "screenshot",
    "save_context",
    "context",
    "runtime_artifact",
  ] as const);
  switch (attachmentKind) {
    case "screenshot": {
      const screenshot: ManualFeedbackScreenshotAttachment = {
        ...base,
        attachmentKind,
      };
      assignOptionalString(screenshot, attachment, "caption");
      assignOptionalString(screenshot, attachment, "capturePosition");
      assignOptionalString(screenshot, attachment, "evidenceTier");
      return screenshot;
    }
    case "save_context": {
      const saveContext: ManualFeedbackSaveContextAttachment = {
        ...base,
        attachmentKind,
      };
      assignOptionalString(saveContext, attachment, "contextToken");
      assignOptionalString(saveContext, attachment, "routeRef");
      assignOptionalString(saveContext, attachment, "sceneRef");
      assignOptionalString(saveContext, attachment, "createdAt");
      return saveContext;
    }
    case "context": {
      const contextAttachment: ManualFeedbackContextAttachment = {
        ...base,
        attachmentKind,
        contextKind: requiredString(attachment, `${context}.contextKind`),
      };
      assignOptionalString(contextAttachment, attachment, "contextId");
      assignOptionalString(contextAttachment, attachment, "routeRef");
      assignOptionalString(contextAttachment, attachment, "sceneRef");
      assignOptionalString(contextAttachment, attachment, "speakerRef");
      assignOptionalString(contextAttachment, attachment, "visibleText");
      return contextAttachment;
    }
    case "runtime_artifact": {
      const runtimeArtifact: ManualFeedbackRuntimeArtifactAttachment = {
        ...base,
        attachmentKind,
        runtimeArtifactId: requiredString(attachment, `${context}.runtimeArtifactId`),
      };
      assignOptionalString(runtimeArtifact, attachment, "evidenceTier");
      return runtimeArtifact;
    }
  }
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[fieldName(field)];
  if (typeof value !== "string") {
    throw new Error(`manual feedback ${field} must be a string`);
  }
  return value;
}

function requiredNonBlankString(record: Record<string, unknown>, field: string): string {
  const raw = record[fieldName(field)];
  if (typeof raw !== "string") {
    throw new Error(`manual feedback ${field} must be a non-empty string`);
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`manual feedback ${field} must be a non-empty string`);
  }
  return value;
}

function assignOptionalString(
  target: object,
  source: Record<string, unknown>,
  field: string,
): void {
  const value = source[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new Error(`manual feedback ${field} must be a string`);
  }
  (target as Record<string, unknown>)[field] = value;
}

function assignOptionalNumber(
  target: object,
  source: Record<string, unknown>,
  field: string,
): void {
  const value = source[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`manual feedback ${field} must be a finite number`);
  }
  (target as Record<string, unknown>)[field] = value;
}

function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  values: T,
): T[number] {
  const value = record[fieldName(field)];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`manual feedback ${field} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function fieldName(field: string): string {
  return field.slice(field.lastIndexOf(".") + 1);
}
