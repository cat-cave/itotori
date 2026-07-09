import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  feedbackContextStatusValues,
  feedbackSourceKindValues,
  ItotoriFeedbackRepository,
} from "../src/repositories/feedback-repository.js";
import {
  CommunityFormsImporter,
  GitHubIssuesImporter,
  redactChannelPii,
  type CommunityFormsExport,
  type GitHubIssuesExport,
} from "../src/channel-feedback/index.js";
import { feedbackReportEvidence, feedbackReports, feedbackSources } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello, {player}." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
}

function githubIssuesExport(): GitHubIssuesExport {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, "fixtures", "github-issues-export.json"), "utf8"),
  ) as GitHubIssuesExport;
}

function communityFormsExport(): CommunityFormsExport {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, "fixtures", "community-forms-export.json"), "utf8"),
  ) as CommunityFormsExport;
}

const importOptions = {
  projectId: "project-test",
  targetLocale: "en-US",
  localeBranchId: "locale-en-us",
  sourceBundleId: "bridge-test",
} as const;

const ISSUE_41_EXTERNAL_ID = "example-org/example-localization#41";
const ISSUE_42_EXTERNAL_ID = "example-org/example-localization#42";
const FORM_RESPONSE_1_EXTERNAL_ID = "public-feedback-form:resp-001";
const FORM_RESPONSE_2_EXTERNAL_ID = "public-feedback-form:resp-002";

describe("GitHubIssuesImporter (pure mapping)", () => {
  it("keeps source + channel metadata and derives a dedupe key from the external id", () => {
    const importer = new GitHubIssuesImporter();
    const items = importer.mapExport(githubIssuesExport(), importOptions);

    expect(items).toHaveLength(3);
    const first = items[0]!;
    expect(first.externalRef).toEqual({
      channel: "github_issues",
      externalId: ISSUE_41_EXTERNAL_ID,
      url: "https://github.com/example-org/example-localization/issues/41",
    });
    expect(first.input.dedupeKey).toBe(ISSUE_41_EXTERNAL_ID);
    expect(first.input.feedbackSource?.sourceChannel).toBe("github_issues");
    expect(first.input.feedbackSource?.sourceKind).toBe(feedbackSourceKindValues.communityChannel);
    expect(first.input.metadata).toMatchObject({
      channel: "github_issues",
      externalId: ISSUE_41_EXTERNAL_ID,
      repository: "example-org/example-localization",
    });
    // The public author handle is retained as the reporter id.
    expect(first.input.reporter.reporterId).toBe("casual-reader");
  });

  it("redacts PII out of content before it becomes a reporter note", () => {
    const importer = new GitHubIssuesImporter();
    const items = importer.mapExport(githubIssuesExport(), importOptions);

    const withPii = items.find((item) => item.externalRef.externalId === ISSUE_42_EXTERNAL_ID)!;
    expect(withPii.input.reporterNote).not.toContain("reporter@example.com");
    // International (`+1 (415) 555-0198`) AND domestic (`090-1234-5678`) numbers
    // are both scrubbed — no raw digits of either survive.
    expect(withPii.input.reporterNote).not.toContain("555-0198");
    expect(withPii.input.reporterNote).not.toContain("090-1234-5678");
    expect(withPii.input.reporterNote).not.toContain("1234-5678");
    expect(withPii.input.reporterNote).toContain("[redacted-email]");
    expect(withPii.input.reporterNote).toContain("[redacted-phone]");
    expect(withPii.input.redactionState).toBe("redacted");
    expect(withPii.redactions.map((redaction) => redaction.kind).sort()).toEqual([
      "email",
      "phone",
    ]);
    // Two phone numbers, one `phone` kind, count === 2.
    expect(withPii.redactions.find((redaction) => redaction.kind === "phone")?.count).toBe(2);

    // False-positive guard: issue 41's body carries an issue id, a year, a
    // semver build, and a price — none of which are phone numbers, so nothing is
    // redacted and the report stays raw.
    const withoutPii = items.find((item) => item.externalRef.externalId === ISSUE_41_EXTERNAL_ID)!;
    expect(withoutPii.input.redactionState).toBe("raw");
    expect(withoutPii.redactions).toHaveLength(0);
    expect(withoutPii.input.reporterNote).toContain("#12345");
    expect(withoutPii.input.reporterNote).toContain("2026");
    expect(withoutPii.input.reporterNote).toContain("1.2.3");
    expect(withoutPii.input.reporterNote).toContain("$1,499");
  });

  it("rejects a malformed export", () => {
    const importer = new GitHubIssuesImporter();
    expect(() => importer.mapExport({ repository: "x" }, importOptions)).toThrow(
      /export\.issues must be an array/,
    );
  });
});

describe("CommunityFormsImporter (pure mapping)", () => {
  it("keeps form source metadata and derives a dedupe key from the response id", () => {
    const importer = new CommunityFormsImporter();
    const items = importer.mapExport(communityFormsExport(), importOptions);

    expect(items).toHaveLength(2);
    const first = items[0]!;
    expect(first.externalRef).toEqual({
      channel: "community_forms",
      externalId: FORM_RESPONSE_1_EXTERNAL_ID,
    });
    expect(first.input.dedupeKey).toBe(FORM_RESPONSE_1_EXTERNAL_ID);
    expect(first.input.feedbackSource?.sourceChannel).toBe("community_forms");
    expect(first.input.feedbackSource?.sourceKind).toBe(
      feedbackSourceKindValues.communityChannel,
    );
    expect(first.input.feedbackSource?.metadata).toMatchObject({
      channel: "community_forms",
      formId: "public-feedback-form",
      formTitle: "Public localization feedback",
    });
    expect(first.input.metadata).toMatchObject({
      channel: "community_forms",
      externalId: FORM_RESPONSE_1_EXTERNAL_ID,
      responseId: "resp-001",
      tags: ["glossary", "hero-name"],
    });
    expect(first.input.lineReference).toEqual({
      bridgeUnitId: "bridge-unit-test",
      sourceUnitKey: "hello.scene.001.line.001",
    });
  });

  it("redacts PII from form response text and keeps respondent metadata non-contact", () => {
    const importer = new CommunityFormsImporter();
    const items = importer.mapExport(communityFormsExport(), importOptions);

    const withPii = items.find(
      (item) => item.externalRef.externalId === FORM_RESPONSE_2_EXTERNAL_ID,
    )!;
    expect(withPii.input.reporterNote).not.toContain("fan@example.com");
    expect(withPii.input.reporterNote).not.toContain("415-555-0198");
    expect(withPii.input.reporterNote).toContain("[redacted-email]");
    expect(withPii.input.reporterNote).toContain("[redacted-phone]");
    expect(withPii.input.redactionState).toBe("redacted");
    expect(withPii.input.reporter).toEqual({
      role: "community",
      reporterId: "anon-8",
      displayName: "Playtester 8",
    });
    expect(JSON.stringify(withPii.input.reporter)).not.toContain("fan@example.com");
    expect(withPii.input.metadata).toMatchObject({
      redactedPii: ["email", "phone"],
    });
  });

  it("rejects a malformed form export", () => {
    const importer = new CommunityFormsImporter();
    expect(() => importer.mapExport({ formId: "public-feedback-form" }, importOptions)).toThrow(
      /export\.responses must be an array/,
    );
  });
});

describe("redactChannelPii (phone coverage)", () => {
  it("redacts domestic-format phone numbers without a country code", () => {
    for (const raw of [
      "call 090-1234-5678 today", // JP mobile, 11 digits
      "reach me on 03-1234-5678", // JP landline, 9 digits
      "dial (415) 555-0198 anytime", // US, parenthesized area code, 10 digits
      "my line is 415 555 0198 ok", // US, space-separated, 10 digits
    ]) {
      const result = redactChannelPii(raw);
      expect(result.redacted).toBe(true);
      expect(result.text).toContain("[redacted-phone]");
      expect(result.text).not.toMatch(/\d{3,}/);
      expect(result.redactions).toEqual([
        { kind: "phone", count: 1, placeholder: "[redacted-phone]" },
      ]);
    }
  });

  it("keeps the international `+`-prefixed phone case", () => {
    const result = redactChannelPii("ping +1 (415) 555-0198 please");
    expect(result.text).toContain("[redacted-phone]");
    expect(result.text).not.toContain("555-0198");
    expect(result.redactions).toEqual([
      { kind: "phone", count: 1, placeholder: "[redacted-phone]" },
    ]);
  });

  it("does NOT over-redact non-phone numerics (issue ids, years, versions, prices, dates, ips)", () => {
    for (const raw of [
      "see issue #12345 for details",
      "reported in 2026",
      "regressed on build 1.2.3.4",
      "it costs $1,499.00 in goodwill",
      "landed on 2026-06-21", // ISO date, 8 digits
      "server 192.168.1.100 is fine", // dotted IP
      "zip is 12345-6789 here", // ZIP+4, only two groups
      "hash abcdef1234567890 stays", // alnum token
      "order 1234567890123 pending", // 13-digit run, no separators
    ]) {
      const result = redactChannelPii(raw);
      expect(result.redacted).toBe(false);
      expect(result.text).toBe(raw);
      expect(result.redactions).toHaveLength(0);
    }
  });
});

describe("GitHub channel feedback import (real Postgres)", () => {
  it("persists imported reports with source + channel metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const importer = new GitHubIssuesImporter();
      const items = importer.mapExport(githubIssuesExport(), importOptions);
      const results = [];
      for (const item of items) {
        results.push(await feedbackRepo.importManualFeedback(localActor, item.input));
      }

      expect(results.every((result) => !result.duplicate)).toBe(true);

      // (metadata) — the feedback source carries the channel identity.
      const sources = await context.db
        .select()
        .from(feedbackSources)
        .where(eq(feedbackSources.projectId, "project-test"));
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        sourceKind: feedbackSourceKindValues.communityChannel,
        sourceChannel: "github_issues",
      });
      expect(sources[0]?.metadata).toMatchObject({
        channel: "github_issues",
        repository: "example-org/example-localization",
      });

      // (metadata) — every report carries its channel + external id.
      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.projectId, "project-test"));
      expect(reports).toHaveLength(3);
      const issue41 = reports.find(
        (report) =>
          (report.metadata as Record<string, unknown>).externalId === ISSUE_41_EXTERNAL_ID,
      );
      expect(issue41?.metadata).toMatchObject({
        channel: "github_issues",
        externalId: ISSUE_41_EXTERNAL_ID,
        url: "https://github.com/example-org/example-localization/issues/41",
      });
      expect(issue41?.reporterRole).toBe("community");
      // No bridge-unit reference on a raw community report → needs context.
      expect(issue41?.contextStatus).toBe(feedbackContextStatusValues.needsContext);
    } finally {
      await context.close();
    }
  });

  it("aggregates a re-imported issue under one canonical report instead of duplicating", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const importer = new GitHubIssuesImporter();
      const items = importer.mapExport(githubIssuesExport(), importOptions);

      // First import of the whole export.
      for (const item of items) {
        const first = await feedbackRepo.importManualFeedback(localActor, item.input);
        expect(first.duplicate).toBe(false);
      }

      // Re-import the SAME export (same external ids) — mirrors the same issue
      // arriving twice, or two reports resolving to the same issue.
      const issue42 = items.find((item) => item.externalRef.externalId === ISSUE_42_EXTERNAL_ID)!;
      const reimport = await feedbackRepo.importManualFeedback(localActor, {
        ...issue42.input,
        // A fresh evidence row (distinct reporter run) that still resolves to the
        // same external id → aggregates rather than double-counts.
        feedbackEvidenceId: "github-issue-42-evidence-2",
      });
      expect(reimport.duplicate).toBe(true);
      expect(reimport.reportCount).toBe(2);

      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.projectId, "project-test"));
      // Still three canonical reports — the re-import aggregated, did not add one.
      expect(reports).toHaveLength(3);
      const aggregated = reports.find(
        (report) =>
          (report.metadata as Record<string, unknown>).externalId === ISSUE_42_EXTERNAL_ID,
      );
      expect(aggregated?.reportCount).toBe(2);

      // Two evidence rows aggregated under the one canonical report.
      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, reimport.feedbackReportId));
      expect(evidence).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("never persists raw PII from channel content", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const importer = new GitHubIssuesImporter();
      const items = importer.mapExport(githubIssuesExport(), importOptions);
      const issue42 = items.find((item) => item.externalRef.externalId === ISSUE_42_EXTERNAL_ID)!;
      const result = await feedbackRepo.importManualFeedback(localActor, issue42.input);

      const report = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.feedbackReportId, result.feedbackReportId))
        .limit(1);
      const persistedNote = report[0]?.reporterNote ?? "";
      expect(persistedNote).not.toContain("reporter@example.com");
      expect(persistedNote).not.toContain("555-0198");
      expect(persistedNote).not.toContain("090-1234-5678");
      expect(persistedNote).toContain("[redacted-email]");
      expect(persistedNote).toContain("[redacted-phone]");
      expect(report[0]?.redactionState).toBe("redacted");
      expect(report[0]?.metadata).toMatchObject({ redactedPii: ["email", "phone"] });

      // The evidence copy must also be redaction-safe.
      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, result.feedbackReportId))
        .limit(1);
      expect(evidence[0]?.reporterNote ?? "").not.toContain("reporter@example.com");
      expect(JSON.stringify(evidence[0]?.reporter ?? {})).not.toContain("reporter@example.com");
    } finally {
      await context.close();
    }
  });
});

describe("Community forms channel feedback import (real Postgres)", () => {
  it("persists form responses with channel metadata, dedup, and redacted content", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const importer = new CommunityFormsImporter();
      const items = importer.mapExport(communityFormsExport(), importOptions);
      const firstImport = [];
      for (const item of items) {
        firstImport.push(await feedbackRepo.importManualFeedback(localActor, item.input));
      }
      expect(firstImport.every((result) => !result.duplicate)).toBe(true);

      const reimport = await feedbackRepo.importManualFeedback(localActor, {
        ...items[1]!.input,
        feedbackEvidenceId: "community-form-resp-002-evidence-2",
      });
      expect(reimport.duplicate).toBe(true);
      expect(reimport.reportCount).toBe(2);

      const sources = await context.db
        .select()
        .from(feedbackSources)
        .where(eq(feedbackSources.projectId, "project-test"));
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        sourceKind: feedbackSourceKindValues.communityChannel,
        sourceChannel: "community_forms",
      });
      expect(sources[0]?.metadata).toMatchObject({
        channel: "community_forms",
        formId: "public-feedback-form",
      });

      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.projectId, "project-test"));
      expect(reports).toHaveLength(2);
      const redacted = reports.find(
        (report) =>
          (report.metadata as Record<string, unknown>).externalId === FORM_RESPONSE_2_EXTERNAL_ID,
      );
      expect(redacted?.reporterNote ?? "").not.toContain("fan@example.com");
      expect(redacted?.reporterNote ?? "").not.toContain("415-555-0198");
      expect(redacted?.reporterNote).toContain("[redacted-email]");
      expect(redacted?.reporterNote).toContain("[redacted-phone]");
      expect(redacted?.redactionState).toBe("redacted");
      expect(redacted?.reportCount).toBe(2);
      expect(redacted?.metadata).toMatchObject({
        channel: "community_forms",
        externalId: FORM_RESPONSE_2_EXTERNAL_ID,
        redactedPii: ["email", "phone"],
      });
    } finally {
      await context.close();
    }
  });
});
