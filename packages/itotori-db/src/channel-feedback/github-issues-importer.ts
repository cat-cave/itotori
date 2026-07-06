// ITOTORI-037 — Reference community-channel importer: GitHub issues.
//
// GitHub issues are the cleanest structured community source: each issue has a
// stable number, a repository, an author login, a body, labels, and a canonical
// URL. This importer maps a GitHub issues export (the subset of the REST
// `GET /repos/{owner}/{repo}/issues` payload we need — supplied as a fixture, we
// never call the live API) into `ManualFeedbackImportInput`s that flow through
// the proven `importManualFeedback` path.
//
// It realizes the three acceptance properties:
//   - metadata: `feedbackSource.sourceChannel = "github_issues"` and both the
//     source metadata and report metadata carry the repository + external id +
//     issue URL.
//   - dedup: `dedupeKey = "github_issues:owner/repo#N"`, so re-importing the
//     same issue aggregates under one canonical report (mirrors manual dedup).
//   - privacy: title + body are run through `redactChannelPii`; the author
//     login is a public handle (kept), but any email or phone number (both
//     `+`-prefixed international and domestic forms like `090-1234-5678` or
//     `(415) 555-0198`) in the body is redacted and `redactionState` is stamped
//     accordingly. Raw PII never reaches the input.

import {
  feedbackSourceKindValues,
  feedbackTypeValues,
  type FeedbackType,
  type ManualFeedbackImportInput,
} from "../repositories/feedback-repository.js";
import { redactChannelPii, type ChannelRedaction } from "./redaction.js";
import {
  ChannelImportError,
  type ChannelExternalRef,
  type ChannelFeedbackImportItem,
  type ChannelFeedbackImporter,
  type ChannelImportOptions,
} from "./types.js";

export const GITHUB_ISSUES_CHANNEL = "github_issues" as const;

/** A GitHub label, as either the REST object shape or a bare string. */
export type GitHubIssueLabel = { name: string } | string;

/**
 * The subset of a GitHub issue we consume. Matches the REST issues payload shape
 * (`number`, `title`, `body`, `html_url`, `user.login`, `labels`,
 * `created_at`), so a real export can be handed in verbatim.
 */
export type GitHubIssueRecord = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state?: string;
  user: { login: string };
  labels?: GitHubIssueLabel[];
  created_at?: string;
};

/** A GitHub issues export scoped to one repository. */
export type GitHubIssuesExport = {
  /** `owner/repo`. */
  repository: string;
  issues: GitHubIssueRecord[];
};

/**
 * Label → feedback type. Community issues rarely carry an Itotori bridge-unit
 * reference, so they land as `needs_context` regardless; the type still routes
 * the eventual triage label. Anything unrecognized defaults to a style
 * preference (the least destructive assumption for public-authored feedback).
 */
const LABEL_FEEDBACK_TYPE: ReadonlyArray<[readonly string[], FeedbackType]> = [
  [["bug", "defect", "typo", "error", "broken"], feedbackTypeValues.objectiveDefect],
  [["glossary", "terminology", "translation", "canon"], feedbackTypeValues.glossaryCanonIssue],
  [["style", "tone", "wording", "localization"], feedbackTypeValues.stylePreference],
  [["question", "unclear", "context"], feedbackTypeValues.unclearContext],
  [["asset", "image", "graphic", "ui"], feedbackTypeValues.assetIssue],
  [["runtime", "crash", "engine"], feedbackTypeValues.runtimeIssue],
];

function labelName(label: GitHubIssueLabel): string {
  return (typeof label === "string" ? label : label.name).toLowerCase();
}

function feedbackTypeForLabels(labels: readonly GitHubIssueLabel[]): FeedbackType {
  const names = labels.map(labelName);
  for (const [keywords, feedbackType] of LABEL_FEEDBACK_TYPE) {
    if (names.some((name) => keywords.some((keyword) => name.includes(keyword)))) {
      return feedbackType;
    }
  }
  return feedbackTypeValues.stylePreference;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ChannelImportError(GITHUB_ISSUES_CHANNEL, `${context} must be a non-empty string`);
  }
  return value;
}

function parseExport(value: unknown): GitHubIssuesExport {
  if (!isRecord(value)) {
    throw new ChannelImportError(GITHUB_ISSUES_CHANNEL, "export must be an object");
  }
  const repository = requireString(value.repository, "export.repository");
  if (!Array.isArray(value.issues)) {
    throw new ChannelImportError(GITHUB_ISSUES_CHANNEL, "export.issues must be an array");
  }
  return { repository, issues: value.issues.map((issue) => parseIssue(issue)) };
}

function parseIssue(value: unknown): GitHubIssueRecord {
  if (!isRecord(value)) {
    throw new ChannelImportError(GITHUB_ISSUES_CHANNEL, "issue must be an object");
  }
  if (typeof value.number !== "number" || !Number.isInteger(value.number)) {
    throw new ChannelImportError(GITHUB_ISSUES_CHANNEL, "issue.number must be an integer");
  }
  const user = isRecord(value.user) ? value.user : undefined;
  const record: GitHubIssueRecord = {
    number: value.number,
    title: requireString(value.title, "issue.title"),
    html_url: requireString(value.html_url, "issue.html_url"),
    user: { login: requireString(user?.login, "issue.user.login") },
  };
  if (typeof value.body === "string") {
    record.body = value.body;
  }
  if (typeof value.state === "string") {
    record.state = value.state;
  }
  if (typeof value.created_at === "string") {
    record.created_at = value.created_at;
  }
  if (Array.isArray(value.labels)) {
    record.labels = value.labels.filter(
      (label): label is GitHubIssueLabel =>
        typeof label === "string" || (isRecord(label) && typeof label.name === "string"),
    );
  }
  return record;
}

/** Reference {@link ChannelFeedbackImporter} for GitHub issues. */
export class GitHubIssuesImporter implements ChannelFeedbackImporter<GitHubIssuesExport> {
  readonly channel = GITHUB_ISSUES_CHANNEL;

  mapExport(sourceExport: unknown, options: ChannelImportOptions): ChannelFeedbackImportItem[] {
    const parsed = parseExport(sourceExport);
    const feedbackSourceId = `feedback-source:github_issues:${parsed.repository}`;
    const privacyClassification = options.privacyClassification ?? "community";

    return parsed.issues.map((issue) =>
      this.mapIssue(issue, parsed.repository, feedbackSourceId, privacyClassification, options),
    );
  }

  private mapIssue(
    issue: GitHubIssueRecord,
    repository: string,
    feedbackSourceId: string,
    privacyClassification: string,
    options: ChannelImportOptions,
  ): ChannelFeedbackImportItem {
    const externalId = `${repository}#${issue.number}`;
    const externalRef: ChannelExternalRef = {
      channel: this.channel,
      externalId,
      url: issue.html_url,
    };

    // Redact the whole authored surface (title + body) before it becomes a note.
    const rawNote = issue.body ? `${issue.title}\n\n${issue.body}` : issue.title;
    const { text: reporterNote, redactions, redacted } = redactChannelPii(rawNote);
    const labels = issue.labels ?? [];
    const feedbackType = feedbackTypeForLabels(labels);

    const input: ManualFeedbackImportInput = {
      projectId: options.projectId,
      targetLocale: options.targetLocale,
      ...(options.localeBranchId === undefined ? {} : { localeBranchId: options.localeBranchId }),
      ...(options.sourceBundleId === undefined ? {} : { sourceBundleId: options.sourceBundleId }),
      feedbackType,
      // The GitHub author login is a public handle; the email in the body (if
      // any) has already been redacted out of `reporterNote`. No raw PII here.
      reporter: {
        role: "community",
        reporterId: issue.user.login,
        displayName: issue.user.login,
      },
      reporterNote,
      // dedupeKey carries the external id, so re-importing the same issue (or two
      // reports resolving to the same issue) aggregates instead of duplicating.
      dedupeKey: externalId,
      feedbackSourceId,
      feedbackSource: {
        feedbackSourceId,
        sourceKind: feedbackSourceKindValues.communityChannel,
        label: `GitHub issues: ${repository}`,
        sourceChannel: this.channel,
        privacyReviewState: redacted ? "redacted_pending_review" : "pending",
        metadata: {
          channel: this.channel,
          repository,
        },
      },
      privacyClassification,
      redactionState: redacted ? "redacted" : "raw",
      ...(issue.created_at === undefined ? {} : { reportedAt: issue.created_at }),
      metadata: {
        channel: this.channel,
        externalId,
        externalNumber: issue.number,
        url: issue.html_url,
        repository,
        ...(issue.state === undefined ? {} : { issueState: issue.state }),
        labels: labels.map(labelName),
        ...(redacted
          ? { redactedPii: redactions.map((redaction: ChannelRedaction) => redaction.kind) }
          : {}),
      },
    };

    return { input, externalRef, redactions };
  }
}
