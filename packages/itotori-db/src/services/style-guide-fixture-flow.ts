import { createHash } from "node:crypto";
import {
  assertStyleGuideConversationTranscript,
  projectStyleGuideConversationToPolicyDraft,
  STYLE_GUIDE_POLICY_SECTIONS,
  type BridgeBundle,
  type BridgeUnit,
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
import { ItotoriStyleGuideService, type StyleGuideCommandResult } from "./style-guide-service.js";

export const styleGuideFixtureFlowSchemaVersion = "itotori.style-guide-fixture-flow.v0";
export const styleGuideSuggestionArtifactSchemaVersion =
  "itotori.style-guide-suggestion-artifact.v0";

/**
 * Schema version for the recorded style-guide fixture SEED WORK data file. The
 * seed work holds the hardcoded bridge/draft/affected-work/benchmark seed
 * records that accompany a recorded style-guide conversation transcript. Moving
 * them into DATA (a fixture file) keeps the fixture-flow service pure LOGIC:
 * editing fixture seed text is a data edit, not a code edit.
 */
export const styleGuideFixtureSeedWorkSchemaVersion =
  "itotori.style-guide-fixture-seed-work.v0" as const;

/**
 * Typed diagnostic code raised when the recorded style-guide fixture flow is
 * re-run against a locale branch it has already seeded. The flow is a
 * SEED-ONCE flow: it materialises a deterministic, append-only style-guide
 * version chain (base -> projected) keyed on fixed IDs drawn from the recorded
 * transcript. A second run cannot recreate that immutable chain without either
 * colliding on the fixed version IDs or forking a divergent chain, so the flow
 * rejects the rerun BEFORE mutating any state rather than leaving
 * partially-duplicated rows.
 */
export const styleGuideFixtureFlowRerunRejectedCode =
  "style_guide.fixture_flow.already_seeded" as const;

/**
 * Raised when the style-guide fixture flow is re-run against a locale branch it
 * has already seeded. Thrown from a fail-fast preflight BEFORE any write, so a
 * rejected rerun performs no mutation and cannot leave partial-duplicated
 * state. Carries a typed {@link code} and the offending identifiers so callers
 * (the CLI) can surface an actionable message.
 */
export class StyleGuideFixtureFlowRerunError extends Error {
  readonly code = styleGuideFixtureFlowRerunRejectedCode;

  constructor(
    readonly detail: {
      projectId: string;
      localeBranchId: string;
      fixtureId: string;
      existingLatestVersionId: string;
    },
  ) {
    super(
      `style-guide fixture flow already seeded: locale branch ${detail.localeBranchId} ` +
        `(project ${detail.projectId}, fixture ${detail.fixtureId}) already has style-guide ` +
        `version ${detail.existingLatestVersionId}. The fixture flow is seed-once and cannot be ` +
        `re-run in place; run it against a fresh/reset database to reseed.`,
    );
    this.name = "StyleGuideFixtureFlowRerunError";
  }
}

/**
 * Raised when recorded style-guide fixture SEED WORK data fails structural or
 * transcript-coherence validation. The seed work must structurally match the
 * seed-work schema AND cohere with the transcript it is replayed against
 * (locale-branch scope, base-policy version, bridge-unit references). An
 * incoherent seed file is rejected BEFORE any write so the flow cannot seed
 * partial-mismatched state.
 */
export class StyleGuideFixtureSeedWorkError extends Error {
  readonly code = "style_guide.fixture_flow.invalid_seed_work" as const;

  constructor(
    message: string,
    readonly detail: { field: string },
  ) {
    super(message);
    this.name = "StyleGuideFixtureSeedWorkError";
  }
}

export type StyleGuideFixtureSeedUnit = BridgeUnit & {
  /** Target draft text persisted for this bridge unit. */
  draft: string;
};

export type StyleGuideFixtureSeedArtifact = {
  artifactKind: string;
  idSuffix: string;
  uriSuffix: string;
};

export type StyleGuideFixtureSeedWork = {
  schemaVersion: typeof styleGuideFixtureSeedWorkSchemaVersion;
  /**
   * Bridge seed: the source units + extractor metadata. `bridgeId` and
   * `sourceBundleHash` are derived by the service from the transcript (they
   * are locale-branch-scoped), so the seed DATA omits them.
   */
  bridge: Omit<BridgeBundle, "bridgeId" | "sourceBundleHash" | "units"> & {
    units: StyleGuideFixtureSeedUnit[];
  };
  finding: FindingRecordV02;
  artifacts: StyleGuideFixtureSeedArtifact[];
};

export type StyleGuideFixtureFlowInput = {
  transcript: unknown;
  /**
   * Recorded seed work DATA for the fixture flow: the bridge/draft/affected-work/
   * benchmark seed records that accompany the transcript. The service loads no
   * hardcoded seed records; every seed row comes from this data. Editing seed
   * text is a data edit (edit the fixture file), not a service-code edit.
   */
  seedWork: unknown;
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
    private readonly styleGuideRepository: ItotoriStyleGuideRepositoryPort,
    private readonly actor: AuthorizationActor,
  ) {
    this.styleGuideService = new ItotoriStyleGuideService(styleGuideRepository);
  }

  async run(input: StyleGuideFixtureFlowInput): Promise<StyleGuideFixtureFlowResult> {
    assertStyleGuideConversationTranscript(input.transcript);
    const transcript = input.transcript;
    const projected = projectStyleGuideConversationToPolicyDraft(transcript);
    const fixtureId = input.fixtureId ?? transcript.transcriptId;
    const seedWork = parseSeedWork(input.seedWork);
    assertSeedWorkCoherence(seedWork, transcript);
    const project = projectFromSeedWork(transcript, seedWork);

    // Fail-fast rerun guard. This flow is seed-once: it materialises a fixed,
    // append-only style-guide version chain for this locale branch. If ANY
    // style-guide version already exists for the branch (a prior full or
    // partial run), reject the rerun HERE -- before the first write -- so the
    // rejected run mutates nothing and cannot leave partial-duplicated state.
    const existingLatest = await this.styleGuideRepository.getLatestVersionByLocaleBranchId(
      transcript.localeBranchId,
    );
    if (existingLatest !== null) {
      throw new StyleGuideFixtureFlowRerunError({
        projectId: transcript.projectId,
        localeBranchId: transcript.localeBranchId,
        fixtureId,
        existingLatestVersionId: existingLatest.styleGuideVersionId,
      });
    }

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
    await this.persistAffectedFixtureWork(transcript, seedWork);

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
    seedWork: StyleGuideFixtureSeedWork,
  ): Promise<void> {
    await this.projectRepository.recordFinding(this.actor, {
      projectId: transcript.projectId,
      localeBranchId: transcript.localeBranchId,
      finding: seedWork.finding,
      status: "open",
    });
    for (const artifact of seedWork.artifacts) {
      await this.projectRepository.linkArtifact(this.actor, {
        artifactId: `${transcript.transcriptId}:${artifact.idSuffix}`,
        projectId: transcript.projectId,
        localeBranchId: transcript.localeBranchId,
        artifactKind: artifact.artifactKind,
        uri: `fixture://itotori-style-guide/${transcript.transcriptId}/${artifact.uriSuffix}`,
        metadata: {
          fixtureId: transcript.transcriptId,
          styleGuideVersionId: transcript.basePolicyVersionId,
        },
      });
    }
  }
}

function projectFromSeedWork(
  transcript: StyleGuideConversationTranscript,
  seedWork: StyleGuideFixtureSeedWork,
): ItotoriProjectRecord {
  const drafts: Record<string, string> = {};
  const units: BridgeUnit[] = [];
  for (const unit of seedWork.bridge.units) {
    drafts[unit.bridgeUnitId] = unit.draft;
    const { draft: _draft, ...bridgeUnit } = unit;
    void _draft;
    units.push(bridgeUnit);
  }
  return {
    projectId: transcript.projectId,
    localeBranchId: transcript.localeBranchId,
    targetLocale: transcript.targetLocale,
    drafts,
    bridge: {
      schemaVersion: seedWork.bridge.schemaVersion,
      bridgeId: `${transcript.projectId}:style-guide-bridge`,
      sourceBundleHash: fixtureHash({
        transcriptId: transcript.transcriptId,
        fixture: "style-guide-conversation",
      }),
      sourceLocale: seedWork.bridge.sourceLocale,
      extractorName: seedWork.bridge.extractorName,
      extractorVersion: seedWork.bridge.extractorVersion,
      units,
    },
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

/**
 * Structural validation of recorded style-guide fixture SEED WORK data. Checks
 * the seed-work schema envelope and the presence/shape of the bridge units,
 * finding, and affected-work artifact descriptors the service persists. Throws
 * a {@link StyleGuideFixtureSeedWorkError} naming the offending field on any
 * structural shortfall so a malformed seed file is rejected before any write.
 */
function parseSeedWork(value: unknown): StyleGuideFixtureSeedWork {
  const seed = recordAt(value, "$");
  checkStringLiteral(seed.schemaVersion, styleGuideFixtureSeedWorkSchemaVersion, "$.schemaVersion");
  const bridge = recordAt(seed.bridge, "$.bridge");
  checkNonBlankString(bridge.schemaVersion, "$.bridge.schemaVersion");
  checkNonBlankString(bridge.sourceLocale, "$.bridge.sourceLocale");
  checkNonBlankString(bridge.extractorName, "$.bridge.extractorName");
  checkNonBlankString(bridge.extractorVersion, "$.bridge.extractorVersion");
  if (!Array.isArray(bridge.units) || bridge.units.length === 0) {
    throw seedError("$.bridge.units", "bridge.units must be a non-empty array");
  }
  for (const [index, unitValue] of bridge.units.entries()) {
    const field = `$.bridge.units[${index}]`;
    const unit = recordAt(unitValue, field);
    checkNonBlankString(unit.bridgeUnitId, `${field}.bridgeUnitId`);
    checkNonBlankString(unit.sourceUnitKey, `${field}.sourceUnitKey`);
    checkNonBlankString(unit.occurrenceId, `${field}.occurrenceId`);
    checkNonBlankString(unit.sourceHash, `${field}.sourceHash`);
    checkNonBlankString(unit.sourceLocale, `${field}.sourceLocale`);
    checkNonBlankString(unit.sourceText, `${field}.sourceText`);
    checkNonBlankString(unit.textSurface, `${field}.textSurface`);
    checkNonBlankString(unit.draft, `${field}.draft`);
    if (!Array.isArray(unit.protectedSpans)) {
      throw seedError(`${field}.protectedSpans`, "protectedSpans must be an array");
    }
    recordAt(unit.patchRef, `${field}.patchRef`);
  }
  recordAt(seed.finding, "$.finding");
  checkNonBlankString((seed.finding as { findingId?: unknown }).findingId, "$.finding.findingId");
  if (!Array.isArray(seed.artifacts) || seed.artifacts.length === 0) {
    throw seedError("$.artifacts", "artifacts must be a non-empty array");
  }
  for (const [index, artifactValue] of seed.artifacts.entries()) {
    const field = `$.artifacts[${index}]`;
    const artifact = recordAt(artifactValue, field);
    checkNonBlankString(artifact.artifactKind, `${field}.artifactKind`);
    checkNonBlankString(artifact.idSuffix, `${field}.idSuffix`);
    checkNonBlankString(artifact.uriSuffix, `${field}.uriSuffix`);
  }
  return seed as unknown as StyleGuideFixtureSeedWork;
}

/**
 * Coherence validation between recorded SEED WORK and the transcript it is
 * replayed against. Guarantees the seed data is scoped to this locale branch:
 * style-guide provenance references the transcript's locale branch + base
 * policy version, and every affected-work finding reference points at a bridge
 * unit declared in the seed. An incoherent pairing is rejected before any
 * write so the flow cannot seed partial-mismatched state.
 */
function assertSeedWorkCoherence(
  seedWork: StyleGuideFixtureSeedWork,
  transcript: StyleGuideConversationTranscript,
): void {
  const expectedStyleGuideId = `style-guide:${transcript.localeBranchId}`;
  const bridgeUnitIds = new Set(seedWork.bridge.units.map((unit) => unit.bridgeUnitId));
  for (const [index, provenance] of seedWork.finding.provenance.entries()) {
    if (provenance.provenanceKind !== "style_guide") {
      continue;
    }
    if (provenance.styleGuideId !== expectedStyleGuideId) {
      throw seedError(
        `$.finding.provenance[${index}].styleGuideId`,
        `provenance styleGuideId ${provenance.styleGuideId} must match transcript locale branch ${expectedStyleGuideId}`,
      );
    }
    if (provenance.styleGuideVersionId !== transcript.basePolicyVersionId) {
      throw seedError(
        `$.finding.provenance[${index}].styleGuideVersionId`,
        `provenance styleGuideVersionId ${provenance.styleGuideVersionId} must match transcript base policy version ${transcript.basePolicyVersionId}`,
      );
    }
  }
  for (const [index, ref] of seedWork.finding.affectedRefs.entries()) {
    if (ref.subjectKind === "bridge_unit" && !bridgeUnitIds.has(ref.subjectId)) {
      throw seedError(
        `$.finding.affectedRefs[${index}].subjectId`,
        `affected bridge unit ${ref.subjectId} must be declared in $.bridge.units`,
      );
    }
  }
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

function recordAt(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw seedError(field, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function checkNonBlankString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw seedError(field, `${field} must be a non-empty string`);
  }
}

function checkStringLiteral(value: unknown, expected: string, field: string): void {
  if (value !== expected) {
    throw seedError(field, `${field} must be ${expected}`);
  }
}

function seedError(field: string, message: string): StyleGuideFixtureSeedWorkError {
  return new StyleGuideFixtureSeedWorkError(message, { field });
}
