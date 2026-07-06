// ITOTORI-037 — Community-channel feedback importers.
//
// A channel importer maps an external community channel's native export into the
// proven manual-feedback model (`ManualFeedbackImportInput`), preserving source
// metadata, deriving a dedup key, and redacting PII. The reference
// implementation is the GitHub-issues importer.

export {
  ChannelImportError,
  type ChannelExternalRef,
  type ChannelFeedbackImportItem,
  type ChannelFeedbackImporter,
  type ChannelImportOptions,
} from "./types.js";
export {
  CHANNEL_PII_KINDS,
  redactChannelPii,
  type ChannelPiiKind,
  type ChannelRedaction,
  type ChannelRedactionResult,
} from "./redaction.js";
export {
  GITHUB_ISSUES_CHANNEL,
  GitHubIssuesImporter,
  type GitHubIssueLabel,
  type GitHubIssueRecord,
  type GitHubIssuesExport,
} from "./github-issues-importer.js";
