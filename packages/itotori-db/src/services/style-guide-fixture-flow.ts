import { createHash } from "node:crypto";
import {
  assertStyleGuideConversationTranscript,
  projectStyleGuideConversationToPolicyDraft,
  STYLE_GUIDE_POLICY_SECTIONS,
  type FindingRecordV02,
  type StyleGuideConversationTranscript,
  type StyleGuidePolicySection,
} from "@itotori/localization-bridge-schema";
import type { AuthorizationActor } from "../authorization.js";
import type {
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ProjectDashboardStatus,
} from "../repositories/project-repository.js";
import type { ItotoriStyleGuideRepositoryPort } from "../repositories/style-guide-repository.js";
import {
  ItotoriStyleGuideService,
  type StyleGuideCommandResult,
} from "./style-guide-service.js";

export const styleGuideFixtureFlowSchemaVersion = "itotori.style-guide-fixture-flow.v0";
export const styleGuideSuggestionArtifactSchemaVersion =
  "itotori.style-guide-suggestion-artifact.v0";

export type StyleGuideFixtureFlowInput = {
  transcript: unknown;
  fixtureId?: string;
};

export type StyleGuideFixtureFlowResult = {
  schemaVersion: typeof styleGuideFixtureFlowSchemaVersion;
  fixtureId: string;
  projectId: string;
  localeBranchId: string;
  baseStyleGuideVersionId: string;
  projectedStyleGuideVersionId: string;
  suggestionArtifactId: string;
  acceptedProposalIds: string[];
  policyRuleCounts: Record<StyleGuidePolicySection, number>;
  dashboard: {
    selectedLocaleBranchId: string | null;
    currentStyleGuidePolicyVersionId: string | null;
    branchCount: number;
    artifactCount: number;
    localeBranches: ProjectDashboardStatus["localeBranches"];
  };
  outbox: {
    styleGuideVersionChangedEventIds: string[];
    affectedWorkInvalidatedEventIds: string[];
    affectedSurfaces: string[];
  };
};

export class ItotoriStyleGuideFixtureFlowService {
  private readonly styleGuideService: ItotoriStyleGuideService;

  constructor(
    private readonly projectRepository: ItotoriProjectRepositoryPort,
    styleGuideRepository: ItotoriStyleGuideRepositoryPort,
    private readonly actor: AuthorizationActor,
  ) {
    this.styleGuideService = new ItotoriStyleGuideService(styleGuideRepository);
  }

  async run(input: StyleGuideFixtureFlowInput): Promise<StyleGuideFixtureFlowResult> {
    assertStyleGuideConversationTranscript(input.transcript);
    const transcript = input.transcript;
    const projected = projectStyleGuideConversationToPolicyDraft(transcript);
    const fixtureId = input.fixtureId ?? transcript.transcriptId;
    const project = projectFromTranscript(transcript);

    await this.projectRepository.importSourceBundle(this.actor, project);

    const baseCreated = await this.styleGuideService.submitVersion(this.actor, {
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      styleGuideVersionId: transcript.basePolicyVersionId,
      expectedPreviousVersionId: null,
      policy: emptyBasePolicy(),
    });
    requireCreated(baseCreated, "base style guide version");

    const baseApproved = await this.styleGuideService.approveStyleGuideVersion(this.actor, {
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      styleGuideVersionId: transcript.basePolicyVersionId,
      expectedLatestVersionId: transcript.basePolicyVersionId,
    });
    requireApproved(baseApproved, "base style guide version");

    await this.projectRepository.saveDrafts(this.actor, project);
    await this.persistAffectedFixtureWork(transcript);

    const suggestionArtifactId = `style-guide-suggestions:${transcript.transcriptId}`;
    await this.projectRepository.linkArtifact(this.actor, {
      artifactId: suggestionArtifactId,
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      artifactKind: "style_guide_suggestions",
      uri: `fixture://itotori-style-guide/conversations/${transcript.transcriptId}`,
      hash: fixtureHash(transcript),
      metadata: {
        schemaVersion: styleGuideSuggestionArtifactSchemaVersion,
        fixtureId,
        transcript,
        acceptedProposalIds: projected.acceptedProposalIds,
        projectedStyleGuideVersionId: projected.styleGuideVersionId,
      },
    });

    const projectedCreated = await this.styleGuideService.submitVersion(this.actor, {
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      styleGuideVersionId: projected.styleGuideVersionId,
      expectedPreviousVersionId: projected.expectedPreviousVersionId,
      policy: projected.policy,
    });
    requireCreated(projectedCreated, "projected style guide version");

    const projectedApproved = await this.styleGuideService.approveStyleGuideVersion(this.actor, {
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      styleGuideVersionId: projected.styleGuideVersionId,
      expectedLatestVersionId: projected.styleGuideVersionId,
    });
    requireApproved(projectedApproved, "projected style guide version");

    const dashboard = await this.projectRepository.getDashboardStatus();
    const styleGuideVersionChangedEventIds = [
      baseCreated.outboxEvent?.outboxEventId,
      baseApproved.outboxEvent?.outboxEventId,
      projectedCreated.outboxEvent?.outboxEventId,
      projectedApproved.outboxEvent?.outboxEventId,
    ].filter(isString);
    const invalidationEvents = projectedApproved.invalidationOutboxEvents ?? [];

    return {
      schemaVersion: styleGuideFixtureFlowSchemaVersion,
      fixtureId,
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      baseStyleGuideVersionId: transcript.basePolicyVersionId,
      projectedStyleGuideVersionId: projected.styleGuideVersionId,
      suggestionArtifactId,
      acceptedProposalIds: projected.acceptedProposalIds,
      policyRuleCounts: policyRuleCounts(projected.policy.sections),
      dashboard: {
        selectedLocaleBranchId: dashboard.selectedLocaleBranchId,
        currentStyleGuidePolicyVersionId: dashboard.currentStyleGuidePolicyVersionId,
        branchCount: dashboard.branchCount,
        artifactCount: dashboard.artifactCount,
        localeBranches: dashboard.localeBranches,
      },
      outbox: {
        styleGuideVersionChangedEventIds,
        affectedWorkInvalidatedEventIds: invalidationEvents.map((event) => event.outboxEventId),
        affectedSurfaces: invalidationEvents
          .map((event) => affectedSurface(event.payload))
          .filter(isString),
      },
    };
  }

  private async persistAffectedFixtureWork(
    transcript: StyleGuideConversationTranscript,
  ): Promise<void> {
    await this.projectRepository.recordFinding(this.actor, {
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      finding: styleGuideFinding(transcript),
      status: "open",
    });
    await this.projectRepository.linkArtifact(this.actor, {
      artifactId: `${transcript.transcriptId}:patch-export-base-policy`,
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      artifactKind: "patch_export",
      uri: `fixture://itotori-style-guide/${transcript.transcriptId}/patch-export`,
      metadata: {
        fixtureId: transcript.transcriptId,
        styleGuideVersionId: transcript.basePolicyVersionId,
      },
    });
    await this.projectRepository.linkArtifact(this.actor, {
      artifactId: `${transcript.transcriptId}:benchmark-base-policy`,
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      artifactKind: "benchmark_report",
      uri: `fixture://itotori-style-guide/${transcript.transcriptId}/benchmark`,
      metadata: {
        fixtureId: transcript.transcriptId,
        styleGuideVersionId: transcript.basePolicyVersionId,
      },
    });
  }
}

function projectFromTranscript(transcript: StyleGuideConversationTranscript): ItotoriProjectRecord {
  const firstBridgeUnitId = bridgeUnitId(transcript, 1);
  const secondBridgeUnitId = bridgeUnitId(transcript, 2);
  return {
    projectId: transcript.projectId,
    localeBranchId: transcript.localeBranchId,
    targetLocale: transcript.targetLocale,
    drafts: {
      [firstBridgeUnitId]: "Welcome back, {player}.",
      [secondBridgeUnitId]: "We should go now.",
    },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: `${transcript.projectId}:style-guide-bridge`,
      sourceBundleHash: fixtureHash({
        transcriptId: transcript.transcriptId,
        fixture: "style-guide-conversation",
      }),
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: firstBridgeUnitId,
          sourceUnitKey: "style-guide.fixture.line.001",
          occurrenceId: "style-guide-fixture-occurrence-001",
          sourceHash: "sha256:style-guide-fixture-source-001",
          sourceLocale: "ja-JP",
          sourceText: "Hello, {player}.",
          textSurface: "dialogue",
          protectedSpans: [
            {
              kind: "placeholder",
              raw: "{player}",
              start: 7,
              end: 15,
              preserveMode: "exact",
            },
          ],
          patchRef: {
            assetId: "style-guide-fixture.json",
            writeMode: "replace",
            sourceUnitKey: "style-guide.fixture.line.001",
          },
        },
        {
          bridgeUnitId: secondBridgeUnitId,
          sourceUnitKey: "style-guide.fixture.line.002",
          occurrenceId: "style-guide-fixture-occurrence-002",
          sourceHash: "sha256:style-guide-fixture-source-002",
          sourceLocale: "ja-JP",
          sourceText: "We should go now.",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "style-guide-fixture.json",
            writeMode: "replace",
            sourceUnitKey: "style-guide.fixture.line.002",
          },
        },
      ],
    },
  };
}

function styleGuideFinding(transcript: StyleGuideConversationTranscript): FindingRecordV02 {
  return {
    findingId: "019ed007-0000-7000-8000-000000000901",
    findingKind: "style_guide_violation",
    severity: "P2",
    qualityCategory: "style",
    title: "Base policy wording needs style-guide recheck",
    description:
      "The recorded fixture keeps an open style finding tied to the prior style-guide policy.",
    impact: "Approval of the projected style guide must invalidate the affected finding.",
    createdAt: "2026-06-19T00:00:00.000Z",
    affectedRefs: [
      {
        subjectKind: "bridge_unit",
        subjectId: bridgeUnitId(transcript, 1),
        label: "style-guide.fixture.line.001",
      },
    ],
    evidence: [
      {
        evidenceId: "019ed007-0000-7000-8000-000000000902",
        evidenceKind: "text_excerpt",
        summary: "The prior policy lacks the accepted warm direct player-address guidance.",
        expectedValue: "warm direct address",
        observedValue: "base policy address",
        provenanceIds: ["019ed007-0000-7000-8000-000000000903"],
      },
    ],
    provenance: [
      {
        provenanceId: "019ed007-0000-7000-8000-000000000903",
        provenanceKind: "style_guide",
        styleGuideId: `style-guide:${transcript.localeBranchId}`,
        styleGuideVersionId: transcript.basePolicyVersionId,
        ruleId: "tone-player-address-warm-direct",
        rulePath: "sections.tone",
      },
    ],
    causalLinks: [],
  };
}

function emptyBasePolicy(): Record<string, unknown> {
  return {
    schemaVersion: "style-guide-policy.v0",
    sections: Object.fromEntries(STYLE_GUIDE_POLICY_SECTIONS.map((section) => [section, []])),
  };
}

function policyRuleCounts(
  sections: Record<StyleGuidePolicySection, readonly unknown[]>,
): Record<StyleGuidePolicySection, number> {
  return Object.fromEntries(
    STYLE_GUIDE_POLICY_SECTIONS.map((section) => [section, sections[section].length]),
  ) as Record<StyleGuidePolicySection, number>;
}

function requireCreated(result: StyleGuideCommandResult, label: string): void {
  if (result.status !== "created") {
    throw new Error(`${label} was not created: ${diagnosticsSummary(result)}`);
  }
}

function requireApproved(result: StyleGuideCommandResult, label: string): void {
  if (result.status !== "approved") {
    throw new Error(`${label} was not approved: ${diagnosticsSummary(result)}`);
  }
}

function diagnosticsSummary(result: StyleGuideCommandResult): string {
  return result.diagnostics.map((diagnostic) => diagnostic.code).join(", ") || result.status;
}

function bridgeUnitId(transcript: StyleGuideConversationTranscript, index: 1 | 2): string {
  return `019ed007-0000-7000-8000-00000000010${index}`;
}

function fixtureHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function affectedSurface(payload: Record<string, unknown>): string | null {
  const affectedWork = payload.affectedWork;
  if (affectedWork === null || typeof affectedWork !== "object" || Array.isArray(affectedWork)) {
    return null;
  }
  const surface = (affectedWork as Record<string, unknown>).surface;
  return typeof surface === "string" ? surface : null;
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string";
}
