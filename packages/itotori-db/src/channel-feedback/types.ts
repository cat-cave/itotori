// ITOTORI-037 — Community-channel feedback importer interface.
//
// The manual-feedback model (`ManualFeedbackImportInput` +
// `ItotoriFeedbackRepository.importManualFeedback`) is proven: it persists a
// report, dedups by `dedupeKey`, and stamps privacy/redaction state. External
// community channels (GitHub issues, forms, chat exports) should feed that SAME
// model rather than a parallel one.
//
// A `ChannelFeedbackImporter` is the boundary that maps a channel-native export
// into `ManualFeedbackImportInput`s. It never touches the database itself — it
// is a pure, deterministic mapping. The caller feeds each produced `input`
// through the existing `importManualFeedback` path, which is where dedup,
// persistence, and reviewer-queue enqueue already happen.
//
// The importer is responsible for the three acceptance properties BEFORE the
// input reaches the repository:
//   1. metadata  — every input carries its channel + external id (on the
//                  feedback source AND the report metadata), so an imported
//                  report can always be traced back to its origin.
//   2. dedup     — every input sets a `dedupeKey` derived from the channel +
//                  external id, so re-importing the same external report (or two
//                  reports that resolve to the same external id) aggregates
//                  under one canonical report instead of double-counting.
//   3. privacy   — free-text content is run through `redactChannelPii` before it
//                  becomes a `reporterNote`; `redactionState` is stamped and raw
//                  PII (e.g. author emails) is never copied into the input.

import type { ManualFeedbackImportInput } from "../repositories/feedback-repository.js";
import type { ChannelRedaction } from "./redaction.js";

/** Stable pointer back to the external record an imported report came from. */
export type ChannelExternalRef = {
  /** Channel identifier, e.g. `"github_issues"`. */
  channel: string;
  /** Channel-stable external id, e.g. `"owner/repo#42"`. */
  externalId: string;
  /** Canonical URL of the external record, when the channel provides one. */
  url?: string;
};

/**
 * One mapped feedback item: the `ManualFeedbackImportInput` to feed through
 * `importManualFeedback`, plus the external reference it was derived from and a
 * record of any PII that was redacted from its content.
 */
export type ChannelFeedbackImportItem = {
  input: ManualFeedbackImportInput;
  externalRef: ChannelExternalRef;
  redactions: ChannelRedaction[];
};

/** Project-scoping the importer needs to build valid feedback inputs. */
export type ChannelImportOptions = {
  projectId: string;
  targetLocale: string;
  localeBranchId?: string;
  sourceBundleId?: string;
  /**
   * Privacy classification stamped on every produced report. Community-channel
   * content defaults to `"community"` (public-authored, pre-review).
   */
  privacyClassification?: string;
};

/**
 * A channel importer maps a channel-native export into feedback inputs. One
 * implementation exists per external channel; the reference implementation is
 * {@link GitHubIssuesImporter}.
 */
export interface ChannelFeedbackImporter<TExport = unknown> {
  /** Channel identifier stamped onto every produced item (e.g. `"github_issues"`). */
  readonly channel: string;
  /** Map a channel-native export into deterministic feedback import items. */
  mapExport(sourceExport: TExport, options: ChannelImportOptions): ChannelFeedbackImportItem[];
}

/** Thrown when a channel export is malformed and cannot be mapped. */
export class ChannelImportError extends Error {
  readonly channel: string;
  constructor(channel: string, message: string) {
    super(message);
    this.name = "ChannelImportError";
    this.channel = channel;
  }
}
