import {
  permissionValues,
  type LocaleBranchStyleGuideContext,
  type Permission,
  type SourceRevisionReference,
} from "@itotori/db";
import {
  STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION,
  STYLE_GUIDE_POLICY_SCHEMA_VERSION,
  projectStyleGuideConversationToPolicyDraft,
  validateStyleGuideConversationTranscript,
  type StyleGuideConversationDiagnostic,
  type StyleGuideConversationTranscript,
  type StyleGuidePolicySection,
  type StyleGuidePolicyV0Draft,
  type StyleGuideProjectedVersionDraft,
  type StyleGuideProposal,
} from "@itotori/localization-bridge-schema";

export const styleGuideBuilderFixtureStateValues = [
  "empty_policy",
  "validation_error",
  "conflicting_proposal",
  "approved_version",
  "stale_version",
] as const;

export type StyleGuideBuilderFixtureState = (typeof styleGuideBuilderFixtureStateValues)[number];

export const styleGuideBuilderPermissionProfiles = ["reviewer", "reader"] as const;
export type StyleGuideBuilderPermissionProfile =
  (typeof styleGuideBuilderPermissionProfiles)[number];

export type LoadStyleGuideContextInput = {
  localeBranchId: string;
  policyVersionId: string;
  fixtureState?: StyleGuideBuilderFixtureState;
  permissionProfile?: StyleGuideBuilderPermissionProfile;
};

export type StyleGuidePolicyVersionSummary = {
  styleGuideVersionId: string;
  expectedPreviousVersionId: string | null;
  latestVersionId: string;
  approvedVersionId: string | null;
  status: "empty" | "draft" | "approved" | "stale";
  policy: StyleGuidePolicyV0Draft;
};

export type StyleGuideValidationState = {
  status: "valid" | "invalid" | "approved" | "stale";
  diagnostics: StyleGuideBuilderDiagnostic[];
};

export type StyleGuideBuilderDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  field: string;
  source: "conversation" | "policy" | "permission" | "version" | "route";
};

export type StyleGuideBuilderRouteInput =
  | { status: "ready"; input: Required<LoadStyleGuideContextInput> }
  | { status: "missing_context"; diagnostics: StyleGuideBuilderDiagnostic[] };

export type StyleGuideConsequencePreview = {
  affectedDrafts: ConsequencePreviewItem[];
  glossaryEntries: ConsequencePreviewItem[];
  exports: ConsequencePreviewItem[];
};

export type ConsequencePreviewItem = {
  id: string;
  label: string;
  impact: "blocked" | "stale" | "rerun" | "unchanged";
  reason: string;
};

export type StyleGuideBuilderPermissions = {
  actorId: string;
  grantedPermissions: Permission[];
  requiredMutationPermissions: Permission[];
  canReview: boolean;
  canApprove: boolean;
  denialReasons: string[];
};

export type StyleGuideBuilderContext = {
  state: StyleGuideBuilderFixtureState;
  route: {
    localeBranchId: string;
    policyVersionId: string;
  };
  branch: LocaleBranchStyleGuideContext;
  currentPolicy: StyleGuidePolicyVersionSummary;
  proposal: {
    transcript: StyleGuideConversationTranscript;
    proposedVersion: StyleGuideProjectedVersionDraft | null;
    proposals: StyleGuideProposal[];
  };
  validation: StyleGuideValidationState;
  consequences: StyleGuideConsequencePreview;
  permissions: StyleGuideBuilderPermissions;
};

export type StyleGuideApprovalResult =
  | {
      status: "denied";
      diagnostics: StyleGuideBuilderDiagnostic[];
    }
  | {
      status: "invalid";
      diagnostics: StyleGuideBuilderDiagnostic[];
    }
  | {
      status: "approved";
      versionId: string;
      affected: StyleGuideConsequencePreview;
    };

const styleGuideMutationPermissions = [permissionValues.draftWrite] as const;
const fixtureProjectId = "019ed065-0000-7000-8000-000000000001";
const fixtureBasePolicyVersionId = "019ed065-0000-7000-8000-000000000020";
const fixtureUuidByName = {
  base: fixtureBasePolicyVersionId,
  detached: "019ed065-0000-7000-8000-000000000021",
  latest: "019ed065-0000-7000-8000-000000000022",
  proposal: "019ed065-0000-7000-8000-000000000030",
  "proposal-conflicting": "019ed065-0000-7000-8000-000000000031",
  "proposal-tone": "019ed065-0000-7000-8000-000000000201",
  "proposal-protected-spans": "019ed065-0000-7000-8000-000000000202",
  "proposal-conflict-neutral": "019ed065-0000-7000-8000-000000000231",
  "proposal-conflict-playful": "019ed065-0000-7000-8000-000000000232",
} as const satisfies Record<string, string>;

export async function loadStyleGuideContext(
  input: LoadStyleGuideContextInput,
): Promise<StyleGuideBuilderContext> {
  const state = input.fixtureState ?? "empty_policy";
  const permissionProfile = input.permissionProfile ?? "reviewer";
  assertValidRouteId("locale branch id", input.localeBranchId);
  assertValidRouteId("policy version id", input.policyVersionId);
  const branch = localeBranchContext(input.localeBranchId);
  const latestVersionId = state === "stale_version" ? versionId("latest") : input.policyVersionId;
  const currentPolicy = currentPolicyForState({
    localeBranchId: input.localeBranchId,
    policyVersionId: input.policyVersionId,
    latestVersionId,
    state,
  });
  const transcript = transcriptForState(input.localeBranchId, input.policyVersionId, state);
  const conversationDiagnostics =
    validateStyleGuideConversationTranscript(transcript).map(conversationDiagnostic);
  const projected = conversationDiagnostics.length === 0 ? projectOrNull(transcript) : null;
  const versionDiagnostics = versionDiagnosticsForState(
    input.policyVersionId,
    latestVersionId,
    state,
  );
  const validation = validationForState(state, [...conversationDiagnostics, ...versionDiagnostics]);
  const permissions = permissionsForProfile(permissionProfile);

  return {
    state,
    route: {
      localeBranchId: input.localeBranchId,
      policyVersionId: input.policyVersionId,
    },
    branch,
    currentPolicy,
    proposal: {
      transcript,
      proposedVersion: projected,
      proposals: transcript.proposals,
    },
    validation,
    consequences: consequencePreviewForState(input.localeBranchId, state),
    permissions,
  };
}

export async function approveStyleGuideProposal(
  context: StyleGuideBuilderContext,
): Promise<StyleGuideApprovalResult> {
  if (!context.permissions.canApprove) {
    return {
      status: "denied",
      diagnostics: context.permissions.denialReasons.map((message) => ({
        code: "style_guide.permission.denied",
        severity: "error",
        message,
        field: "$.permissions",
        source: "permission",
      })),
    };
  }
  if (context.validation.status !== "valid" || context.proposal.proposedVersion === null) {
    return {
      status: "invalid",
      diagnostics: context.validation.diagnostics,
    };
  }
  return {
    status: "approved",
    versionId: context.proposal.proposedVersion.styleGuideVersionId,
    affected: context.consequences,
  };
}

export async function renderStyleGuideBuilderRoute(
  root: HTMLElement,
  url = currentUrl(),
): Promise<void> {
  renderStyleGuideBuilderLoading(root);
  const routeInput = parseStyleGuideBuilderRouteInput(url);
  if (routeInput.status === "missing_context") {
    renderStyleGuideBuilderMissingContext(root, routeInput.diagnostics);
    return;
  }
  try {
    const context = await loadStyleGuideContext(routeInput.input);
    renderStyleGuideBuilder(root, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.innerHTML = `
      ${styleGuideBuilderStyles()}
      <main class="itotori-shell" data-state="style-guide-error">
        <section class="state-panel state-panel-error" aria-label="Style guide builder error">
          <h1>Style-guide builder unavailable</h1>
          <p role="alert">${escapeHtml(message)}</p>
        </section>
      </main>
    `;
  }
}

export function renderStyleGuideBuilder(
  root: HTMLElement,
  context: StyleGuideBuilderContext,
): void {
  root.innerHTML = `
    ${styleGuideBuilderStyles()}
    <main class="itotori-shell" data-state="style-guide-${context.validation.status}">
      ${renderStyleGuideBuilderContent(context, true)}
    </main>
  `;
}

export function renderStyleGuideBuilderPanel(context: StyleGuideBuilderContext): string {
  return `
    <div class="style-builder-embed">
      ${renderStyleGuideBuilderContent(context, false)}
    </div>
  `;
}

function renderStyleGuideBuilderContent(
  context: StyleGuideBuilderContext,
  includeHeading: boolean,
): string {
  const approveDisabled =
    context.permissions.canApprove && context.validation.status === "valid" ? "" : " disabled";
  const denial = context.permissions.canApprove
    ? ""
    : `<p class="denial-copy" role="alert">${escapeHtml(context.permissions.denialReasons.join(" "))}</p>`;
  return `
    <header class="style-builder-header">
      <div>
        <p class="eyebrow">Style-guide builder</p>
        ${includeHeading ? "<h1>Policy proposal review</h1>" : "<h3>Policy proposal review</h3>"}
      </div>
      <dl class="builder-context" aria-label="Style guide context">
        <div><dt>Locale branch</dt><dd>${escapeHtml(context.branch.localeBranchId)}</dd></div>
        <div><dt>Target locale</dt><dd>${escapeHtml(context.branch.targetLocale)}</dd></div>
        <div><dt>Policy version</dt><dd>${escapeHtml(context.route.policyVersionId)}</dd></div>
        <div><dt>Latest version</dt><dd>${escapeHtml(context.currentPolicy.latestVersionId)}</dd></div>
      </dl>
    </header>
    ${denial}
    <section class="builder-layout" aria-label="Style guide builder dashboard">
      ${renderCurrentPolicy(context.currentPolicy)}
      ${renderProposals(context.proposal.proposals)}
      ${renderValidation(context.validation)}
      ${renderConsequences(context.consequences)}
    </section>
    <section class="builder-actions" aria-label="Style guide actions">
      <button type="button"${approveDisabled} data-action="approve-style-guide">Approve proposal</button>
      <button type="button" disabled data-action="mutate-policy">Mutate policy</button>
    </section>
  `;
}

function renderStyleGuideBuilderLoading(root: HTMLElement): void {
  root.innerHTML = `
    ${styleGuideBuilderStyles()}
    <main class="itotori-shell" data-state="style-guide-loading">
      <section class="state-panel" aria-label="Style guide builder loading">
        <h1>Loading style-guide builder</h1>
        <p role="status">Loading locale branch context, current policy, proposal, validation, and consequences...</p>
      </section>
    </main>
  `;
}

function renderCurrentPolicy(policy: StyleGuidePolicyVersionSummary): string {
  const sections = Object.entries(policy.policy.sections)
    .map(
      ([section, rules]) => `
      <tr>
        <td>${escapeHtml(section)}</td>
        <td>${rules.length}</td>
        <td>${escapeHtml(rules.map((rule) => rule.ruleId).join(", ") || "empty")}</td>
      </tr>
    `,
    )
    .join("");
  return builderCard(
    "Current policy",
    `
      <dl class="compact-metrics">
        <div><dt>Status</dt><dd>${badge(policy.status)}</dd></div>
        <div><dt>Previous</dt><dd>${escapeHtml(policy.expectedPreviousVersionId ?? "none")}</dd></div>
        <div><dt>Approved</dt><dd>${escapeHtml(policy.approvedVersionId ?? "none")}</dd></div>
      </dl>
      <table>
        <thead><tr><th>Section</th><th>Rules</th><th>Rule ids</th></tr></thead>
        <tbody>${sections}</tbody>
      </table>
    `,
  );
}

function renderProposals(proposals: StyleGuideProposal[]): string {
  const rows = proposals
    .flatMap((proposal) =>
      proposal.edits.map(
        (edit) => `
          <tr>
            <td>${escapeHtml(edit.section)}</td>
            <td>${escapeHtml(edit.operation)}</td>
            <td>${escapeHtml(edit.rule.ruleId)}</td>
            <td>${escapeHtml(edit.rule.guidance)}</td>
            <td>${badge(proposal.decision.status)}</td>
          </tr>
        `,
      ),
    )
    .join("");
  return builderCard(
    "Proposed policy",
    rows.length === 0
      ? `<p class="empty-copy">No policy proposal is attached to this fixture.</p>`
      : `
        <table>
          <thead><tr><th>Section</th><th>Operation</th><th>Rule</th><th>Guidance</th><th>Decision</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `,
  );
}

function renderValidation(validation: StyleGuideValidationState): string {
  const diagnostics = validation.diagnostics
    .map(
      (diagnostic) => `
        <tr>
          <td>${badge(diagnostic.severity)}</td>
          <td>${escapeHtml(diagnostic.code)}</td>
          <td>${escapeHtml(diagnostic.field)}</td>
          <td>${escapeHtml(diagnostic.message)}</td>
        </tr>
      `,
    )
    .join("");
  return builderCard(
    "Validation",
    `
      <p>${badge(validation.status)}</p>
      ${
        diagnostics.length === 0
          ? `<p class="empty-copy">No validation diagnostics.</p>`
          : `
            <table>
              <thead><tr><th>Severity</th><th>Code</th><th>Field</th><th>Message</th></tr></thead>
              <tbody>${diagnostics}</tbody>
            </table>
          `
      }
    `,
  );
}

function renderConsequences(consequences: StyleGuideConsequencePreview): string {
  return builderCard(
    "Consequence preview",
    `
      ${consequenceTable("Affected drafts", consequences.affectedDrafts)}
      ${consequenceTable("Glossary entries", consequences.glossaryEntries)}
      ${consequenceTable("Exports", consequences.exports)}
    `,
  );
}

function consequenceTable(title: string, items: ConsequencePreviewItem[]): string {
  const rows = items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.label)}</td>
          <td>${badge(item.impact)}</td>
          <td>${escapeHtml(item.reason)}</td>
        </tr>
      `,
    )
    .join("");
  return `
    <h3>${escapeHtml(title)}</h3>
    <table>
      <thead><tr><th>Item</th><th>Impact</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function builderCard(title: string, body: string): string {
  return `
    <section class="builder-card" aria-label="${escapeHtml(title)}">
      <header><h2>${escapeHtml(title)}</h2></header>
      ${body}
    </section>
  `;
}

function currentPolicyForState(input: {
  localeBranchId: string;
  policyVersionId: string;
  latestVersionId: string;
  state: StyleGuideBuilderFixtureState;
}): StyleGuidePolicyVersionSummary {
  if (input.state === "approved_version") {
    return {
      styleGuideVersionId: input.policyVersionId,
      expectedPreviousVersionId: versionId("base"),
      latestVersionId: input.latestVersionId,
      approvedVersionId: input.policyVersionId,
      status: "approved",
      policy: populatedPolicy(),
    };
  }
  return {
    styleGuideVersionId: input.policyVersionId,
    expectedPreviousVersionId: null,
    latestVersionId: input.latestVersionId,
    approvedVersionId: null,
    status: input.state === "stale_version" ? "stale" : "empty",
    policy: emptyPolicy(),
  };
}

function transcriptForState(
  localeBranchId: string,
  policyVersionId: string,
  state: StyleGuideBuilderFixtureState,
): StyleGuideConversationTranscript {
  const transcript = acceptedTranscript(localeBranchId, policyVersionId);
  if (state === "validation_error") {
    return {
      ...transcript,
      proposals: transcript.proposals.map((proposal, index) =>
        index === 0 ? { ...proposal, policyVersionId: versionId("detached") } : proposal,
      ),
    };
  }
  if (state === "conflicting_proposal") {
    return conflictingTranscript(localeBranchId, policyVersionId);
  }
  return transcript;
}

function acceptedTranscript(
  localeBranchId: string,
  policyVersionId: string,
): StyleGuideConversationTranscript {
  const toneProposalId = versionId("proposal-tone");
  const protectedSpanProposalId = versionId("proposal-protected-spans");
  return {
    schemaVersion: STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION,
    transcriptId: `style-guide-conversation:${localeBranchId}:accepted`,
    projectId: fixtureProjectId,
    localeBranchId,
    targetLocale: "en-US",
    basePolicyVersionId: policyVersionId,
    projectedStyleGuideVersionId: versionId("proposal"),
    recordingMode: "public_fixture",
    turns: [
      {
        turnId: "turn-human-context",
        role: "human",
        localeBranchId,
        policyVersionId,
        redaction: { status: "not_required", privateExampleRefs: [] },
        proposalIds: [],
        citations: [
          {
            citationId: "citation-branch-context",
            sourceKind: "bridge_unit",
            sourceRef: "bridge-unit:opening-tutorial",
            excerptHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          },
        ],
        publicSummary: "The branch needs warm tutorial guidance while preserving runtime tokens.",
      },
      {
        turnId: "turn-assistant-proposal",
        role: "assistant",
        localeBranchId,
        policyVersionId,
        redaction: { status: "not_required", privateExampleRefs: [] },
        proposalIds: [toneProposalId, protectedSpanProposalId],
        citations: [],
        publicSummary: "Two structured policy edits were proposed for reviewer approval.",
      },
      {
        turnId: "turn-reviewer-accepts",
        role: "reviewer",
        localeBranchId,
        policyVersionId,
        redaction: { status: "not_required", privateExampleRefs: [] },
        proposalIds: [],
        citations: [],
        publicSummary: "The reviewer accepted the proposed branch policy edits.",
      },
    ],
    proposals: [
      {
        proposalId: toneProposalId,
        turnId: "turn-assistant-proposal",
        localeBranchId,
        policyVersionId,
        rationale: "Tutorial text should be direct and friendly without adding slang.",
        citationIds: ["citation-branch-context"],
        examples: [
          {
            exampleId: "example-tone-public",
            privacy: "public",
            redactionStatus: "not_required",
            excerptHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            publicText: "Welcome back, {player}.",
          },
        ],
        edits: [
          {
            operation: "add_rule",
            section: "tone",
            toneRegister: "neutral",
            rule: {
              ruleId: "tone-player-address-warm-direct",
              guidance:
                "Use warm, direct player address in tutorial-adjacent dialogue; avoid slang or sarcasm.",
            },
          },
        ],
        decision: {
          status: "accepted",
          decidedByTurnId: "turn-reviewer-accepts",
          rationale: "This matches the locale branch onboarding voice.",
        },
      },
      {
        proposalId: protectedSpanProposalId,
        turnId: "turn-assistant-proposal",
        localeBranchId,
        policyVersionId,
        rationale: "The player placeholder is a protected runtime token.",
        citationIds: ["citation-branch-context"],
        examples: [],
        edits: [
          {
            operation: "add_rule",
            section: "protectedSpans",
            spanKind: "placeholder",
            preserveMode: "exact",
            rule: {
              ruleId: "protected-placeholder-exact",
              guidance:
                "Protected placeholder spans must remain byte-for-byte identical unless a span mapping policy says otherwise.",
            },
          },
        ],
        decision: {
          status: "accepted",
          decidedByTurnId: "turn-reviewer-accepts",
          rationale: "This prevents runtime placeholder breakage.",
        },
      },
    ],
  };
}

function conflictingTranscript(
  localeBranchId: string,
  policyVersionId: string,
): StyleGuideConversationTranscript {
  const firstProposalId = versionId("proposal-conflict-neutral");
  const secondProposalId = versionId("proposal-conflict-playful");
  return {
    ...acceptedTranscript(localeBranchId, policyVersionId),
    transcriptId: `style-guide-conversation:${localeBranchId}:conflicting`,
    projectedStyleGuideVersionId: versionId("proposal-conflicting"),
    turns: [
      {
        turnId: "turn-conflict-context",
        role: "human",
        localeBranchId,
        policyVersionId,
        redaction: { status: "not_required", privateExampleRefs: [] },
        proposalIds: [],
        citations: [
          {
            citationId: "citation-conflict-tone",
            sourceKind: "human_note",
            sourceRef: "note:conflicting-tone",
            excerptHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
          },
        ],
        publicSummary: "The fixture records mutually incompatible accepted tone edits.",
      },
      {
        turnId: "turn-conflict-proposals",
        role: "assistant",
        localeBranchId,
        policyVersionId,
        redaction: { status: "not_required", privateExampleRefs: [] },
        proposalIds: [firstProposalId, secondProposalId],
        citations: [],
        publicSummary: "Two accepted proposals target the same style-guide rule.",
      },
    ],
    proposals: [
      conflictProposal({
        proposalId: firstProposalId,
        localeBranchId,
        policyVersionId,
        toneRegister: "neutral",
        guidance: "Keep battle barks neutral and concise.",
      }),
      conflictProposal({
        proposalId: secondProposalId,
        localeBranchId,
        policyVersionId,
        toneRegister: "playful",
        guidance: "Make battle barks playful and expressive.",
      }),
    ],
  };
}

function conflictProposal(input: {
  proposalId: string;
  localeBranchId: string;
  policyVersionId: string;
  toneRegister: "neutral" | "playful";
  guidance: string;
}): StyleGuideProposal {
  return {
    proposalId: input.proposalId,
    turnId: "turn-conflict-proposals",
    localeBranchId: input.localeBranchId,
    policyVersionId: input.policyVersionId,
    rationale: `The proposal chooses ${input.toneRegister} battle barks.`,
    citationIds: ["citation-conflict-tone"],
    examples: [],
    edits: [
      {
        operation: "add_rule",
        section: "tone",
        toneRegister: input.toneRegister,
        rule: {
          ruleId: "tone-battle-barks",
          guidance: input.guidance,
        },
      },
    ],
    decision: {
      status: "accepted",
      decidedByTurnId: "turn-conflict-context",
      rationale: "Accepted for conflict testing.",
    },
  };
}

function localeBranchContext(localeBranchId: string): LocaleBranchStyleGuideContext {
  return {
    projectId: fixtureProjectId,
    localeBranchId,
    targetLocale: "en-US",
    sourceBundleId: "bridge-1",
    sourceRevisionReference: sourceRevisionReference(localeBranchId),
  };
}

function sourceRevisionReference(localeBranchId: string): SourceRevisionReference {
  return {
    sourceRevisionId: `source-revision:${localeBranchId}`,
    revisionKind: "bridge_bundle",
    value: "revision-1",
  };
}

function validationForState(
  state: StyleGuideBuilderFixtureState,
  diagnostics: StyleGuideBuilderDiagnostic[],
): StyleGuideValidationState {
  if (state === "approved_version") {
    return { status: "approved", diagnostics };
  }
  if (state === "stale_version") {
    return { status: "stale", diagnostics };
  }
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { status: "invalid", diagnostics }
    : { status: "valid", diagnostics };
}

function versionDiagnosticsForState(
  policyVersionId: string,
  latestVersionId: string,
  state: StyleGuideBuilderFixtureState,
): StyleGuideBuilderDiagnostic[] {
  if (state !== "stale_version") {
    return [];
  }
  return [
    {
      code: "style_guide.approval.stale_version",
      severity: "error",
      message: `policy version ${policyVersionId} is stale; latest version is ${latestVersionId}`,
      field: "$.policyVersionId",
      source: "version",
    },
  ];
}

function conversationDiagnostic(
  diagnostic: StyleGuideConversationDiagnostic,
): StyleGuideBuilderDiagnostic {
  return {
    code: diagnostic.rule,
    severity: diagnostic.severity,
    message: diagnostic.message,
    field: diagnostic.field,
    source: "conversation",
  };
}

function projectOrNull(
  transcript: StyleGuideConversationTranscript,
): StyleGuideProjectedVersionDraft | null {
  try {
    return projectStyleGuideConversationToPolicyDraft(transcript);
  } catch {
    return {
      localeBranchId: transcript.localeBranchId,
      styleGuideVersionId: transcript.projectedStyleGuideVersionId,
      expectedPreviousVersionId: transcript.basePolicyVersionId,
      sourceTranscriptId: transcript.transcriptId,
      acceptedProposalIds: [],
      policy: {
        schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
        sections: emptySections(),
      },
    };
  }
}

function permissionsForProfile(
  profile: StyleGuideBuilderPermissionProfile,
): StyleGuideBuilderPermissions {
  const grantedPermissions =
    profile === "reviewer" ? [permissionValues.draftWrite] : ([] as Permission[]);
  const missing = styleGuideMutationPermissions.filter(
    (permission) => !grantedPermissions.includes(permission),
  );
  return {
    actorId: profile === "reviewer" ? "fixture-reviewer" : "fixture-reader",
    grantedPermissions,
    requiredMutationPermissions: [...styleGuideMutationPermissions],
    canReview: true,
    canApprove: missing.length === 0,
    denialReasons: missing.map((permission) => `Missing required permission ${permission}.`),
  };
}

function consequencePreviewForState(
  localeBranchId: string,
  state: StyleGuideBuilderFixtureState,
): StyleGuideConsequencePreview {
  const validationImpact =
    state === "validation_error" || state === "conflicting_proposal"
      ? "blocked"
      : state === "approved_version"
        ? "unchanged"
        : "stale";
  return {
    affectedDrafts: [
      {
        id: `draft:${localeBranchId}:opening-001`,
        label: "Opening tutorial draft",
        impact: validationImpact,
        reason:
          validationImpact === "blocked"
            ? "Proposal must pass validation before draft reruns can be scheduled."
            : "Tone and placeholder rules affect the existing tutorial draft.",
      },
      {
        id: `draft:${localeBranchId}:choice-002`,
        label: "First choice label draft",
        impact: state === "approved_version" ? "unchanged" : "rerun",
        reason: "Choice text should be rechecked against the branch style policy.",
      },
    ],
    glossaryEntries: [
      {
        id: `glossary:${localeBranchId}:player-token`,
        label: "{player}",
        impact: state === "approved_version" ? "unchanged" : "stale",
        reason: "Protected-token guidance updates glossary QA expectations.",
      },
    ],
    exports: [
      {
        id: `export:${localeBranchId}:patch-ready`,
        label: "Patch export candidate",
        impact: state === "approved_version" ? "unchanged" : "blocked",
        reason: "Exports wait for approved policy and rerun completion.",
      },
    ],
  };
}

function emptyPolicy(): StyleGuidePolicyV0Draft {
  return {
    schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
    sections: emptySections(),
  };
}

function populatedPolicy(): StyleGuidePolicyV0Draft {
  return {
    schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
    sections: {
      ...emptySections(),
      tone: [
        {
          ruleId: "tone-player-address-warm-direct",
          guidance:
            "Use warm, direct player address in tutorial-adjacent dialogue; avoid slang or sarcasm.",
        },
      ],
      protectedSpans: [
        {
          ruleId: "protected-placeholder-exact",
          guidance:
            "Protected placeholder spans must remain byte-for-byte identical unless a span mapping policy says otherwise.",
        },
      ],
    },
  };
}

function emptySections(): Record<StyleGuidePolicySection, []> {
  return {
    tone: [],
    terminology: [],
    honorifics: [],
    formatting: [],
    protectedSpans: [],
  };
}

function versionId(suffix: keyof typeof fixtureUuidByName): string {
  return fixtureUuidByName[suffix];
}

// Standalone style-guide builder route: locale-branch id + policy-version id are
// REQUIRED explicit context. A request that omits (or malforms) either one is
// rejected with a structured missing-context diagnostic — the route MUST NOT fall
// back to an implicit/contextual default, because that would risk building a
// style guide against the wrong locale-branch/policy.
export function parseStyleGuideBuilderRouteInput(url: URL): StyleGuideBuilderRouteInput {
  const localeBranchId = url.searchParams.get("localeBranchId");
  const policyVersionId = url.searchParams.get("policyVersionId");
  const diagnostics = [
    ...requiredRouteContextDiagnostics("localeBranchId", "locale-branch id", localeBranchId),
    ...requiredRouteContextDiagnostics("policyVersionId", "policy-version id", policyVersionId),
  ];
  if (diagnostics.length > 0) {
    return { status: "missing_context", diagnostics };
  }
  return {
    status: "ready",
    input: {
      // Non-null: an absent value produces a diagnostic above and returns early.
      localeBranchId: localeBranchId as string,
      policyVersionId: policyVersionId as string,
      fixtureState: parseFixtureState(url.searchParams.get("fixtureState")),
      permissionProfile: parsePermissionProfile(url.searchParams.get("permissions")),
    },
  };
}

function requiredRouteContextDiagnostics(
  param: string,
  label: string,
  value: string | null,
): StyleGuideBuilderDiagnostic[] {
  if (value === null || value.length === 0) {
    return [
      {
        code: "style_guide.route.missing_context",
        severity: "error",
        message: `standalone style-guide builder route requires an explicit ${label}; provide the "${param}" query parameter (no contextual default is applied)`,
        field: `$.${param}`,
        source: "route",
      },
    ];
  }
  if (!isUuid7(value)) {
    return [
      {
        code: "style_guide.route.malformed_context",
        severity: "error",
        message: `standalone style-guide builder route ${label} "${value}" is malformed; expected a UUIDv7 "${param}"`,
        field: `$.${param}`,
        source: "route",
      },
    ];
  }
  return [];
}

function renderStyleGuideBuilderMissingContext(
  root: HTMLElement,
  diagnostics: StyleGuideBuilderDiagnostic[],
): void {
  const rows = diagnostics
    .map(
      (diagnostic) => `
        <li>
          <code>${escapeHtml(diagnostic.field)}</code>
          <span class="diagnostic-code">${escapeHtml(diagnostic.code)}</span>
          <span>${escapeHtml(diagnostic.message)}</span>
        </li>
      `,
    )
    .join("");
  root.innerHTML = `
    ${styleGuideBuilderStyles()}
    <main class="itotori-shell" data-state="style-guide-missing-context">
      <section
        class="state-panel state-panel-error"
        aria-label="Style guide builder missing context"
        data-missing-context="style_guide.route.missing_context"
      >
        <h1>Style-guide builder context required</h1>
        <p role="alert">
          This standalone style-guide builder route requires explicit locale-branch and
          policy-version context. It will not fall back to a default. Provide the missing context:
        </p>
        <ul class="missing-context-list">${rows}</ul>
      </section>
    </main>
  `;
}

function parseFixtureState(value: string | null): StyleGuideBuilderFixtureState {
  if (
    value !== null &&
    styleGuideBuilderFixtureStateValues.includes(value as StyleGuideBuilderFixtureState)
  ) {
    return value as StyleGuideBuilderFixtureState;
  }
  return "empty_policy";
}

function assertValidRouteId(label: string, value: string): void {
  if (!isUuid7(value)) {
    throw new Error(`invalid ${label} ${value}; expected UUIDv7`);
  }
}

function isUuid7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parsePermissionProfile(value: string | null): StyleGuideBuilderPermissionProfile {
  if (
    value !== null &&
    styleGuideBuilderPermissionProfiles.includes(value as StyleGuideBuilderPermissionProfile)
  ) {
    return value as StyleGuideBuilderPermissionProfile;
  }
  return "reviewer";
}

function currentUrl(): URL {
  const href =
    typeof window === "undefined" || window.location.href === "about:blank"
      ? "http://itotori.test/style-guide-builder"
      : window.location.href;
  return new URL(href);
}

function badge(value: string): string {
  const tone =
    value === "error" || value === "invalid" || value === "blocked" || value === "stale"
      ? "critical"
      : "neutral";
  return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function styleGuideBuilderStyles(): string {
  return `
    <style>
      .style-builder-header {
        display: grid;
        grid-template-columns: minmax(220px, 0.7fr) minmax(320px, 1.3fr);
        gap: 16px;
        align-items: start;
        margin-bottom: 16px;
      }

      .style-builder-header h3 {
        margin: 0;
        font-size: 1.05rem;
        line-height: 1.3;
      }

      .builder-context,
      .compact-metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1px;
        margin: 0;
        overflow: hidden;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        background: #d8dee2;
      }

      .builder-context div,
      .compact-metrics div {
        min-width: 0;
        padding: 10px;
        background: #ffffff;
      }

      .builder-layout {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }

      .builder-card {
        min-width: 0;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 14px;
        background: #ffffff;
      }

      .builder-card header {
        margin-bottom: 10px;
      }

      .builder-card h3 {
        margin: 14px 0 8px;
        font-size: 0.92rem;
      }

      .builder-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }

      .builder-actions button {
        min-height: 36px;
        border: 1px solid #24313a;
        border-radius: 8px;
        padding: 0 14px;
        background: #24313a;
        color: #ffffff;
        font-weight: 700;
      }

      .builder-actions button:disabled {
        border-color: #c9d0d6;
        background: #edf0f2;
        color: #64717b;
      }

      .denial-copy {
        margin: 0 0 14px;
        border: 1px solid #e4beb8;
        border-radius: 8px;
        padding: 12px;
        background: #fff8f7;
        font-weight: 700;
      }

      .style-builder-embed {
        display: block;
      }

      @media (max-width: 900px) {
        .style-builder-header,
        .builder-layout {
          grid-template-columns: 1fr;
        }

        .builder-context,
        .compact-metrics {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    </style>
  `;
}
