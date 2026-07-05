export const STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION =
  "itotori.style-guide-conversation.v0" as const;
export const STYLE_GUIDE_POLICY_SCHEMA_VERSION = "style-guide-policy.v0" as const;

export const STYLE_GUIDE_CONVERSATION_ROLES = ["system", "human", "assistant", "reviewer"] as const;
export type StyleGuideConversationRole = (typeof STYLE_GUIDE_CONVERSATION_ROLES)[number];

export const STYLE_GUIDE_REDACTION_STATUSES = ["not_required", "redacted"] as const;
export type StyleGuideRedactionStatus = (typeof STYLE_GUIDE_REDACTION_STATUSES)[number];

export const STYLE_GUIDE_POLICY_SECTIONS = [
  "tone",
  "terminology",
  "honorifics",
  "formatting",
  "protectedSpans",
] as const;
export type StyleGuidePolicySection = (typeof STYLE_GUIDE_POLICY_SECTIONS)[number];

export const STYLE_GUIDE_PROPOSAL_OPERATIONS = ["add_rule", "replace_rule", "remove_rule"] as const;
export type StyleGuideProposalOperation = (typeof STYLE_GUIDE_PROPOSAL_OPERATIONS)[number];

export const STYLE_GUIDE_PROPOSAL_DECISIONS = ["accepted", "rejected", "deferred"] as const;
export type StyleGuideProposalDecision = (typeof STYLE_GUIDE_PROPOSAL_DECISIONS)[number];

export const STYLE_GUIDE_CITATION_SOURCE_KINDS = [
  "bridge_unit",
  "asset_policy",
  "style_guide_version",
  "human_note",
  "runtime_evidence",
] as const;
export type StyleGuideCitationSourceKind = (typeof STYLE_GUIDE_CITATION_SOURCE_KINDS)[number];

export const STYLE_GUIDE_EXAMPLE_PRIVACY = ["public", "private"] as const;
export type StyleGuideExamplePrivacy = (typeof STYLE_GUIDE_EXAMPLE_PRIVACY)[number];

export type StyleGuideConversationDiagnostic = {
  severity: "error";
  turnId: string;
  field: string;
  rule: string;
  message: string;
  proposalId?: string;
};

export type StyleGuideConversationCitation = {
  citationId: string;
  sourceKind: StyleGuideCitationSourceKind;
  sourceRef: string;
  excerptHash: string;
};

export type StyleGuideConversationRedaction = {
  status: StyleGuideRedactionStatus;
  privateExampleRefs: string[];
  redactedBy?: string;
};

export type StyleGuideConversationTurn = {
  turnId: string;
  role: StyleGuideConversationRole;
  localeBranchId: string;
  policyVersionId: string;
  redaction: StyleGuideConversationRedaction;
  proposalIds: string[];
  citations: StyleGuideConversationCitation[];
  publicSummary: string;
};

export type StyleGuideProposalExample = {
  exampleId: string;
  privacy: StyleGuideExamplePrivacy;
  redactionStatus: StyleGuideRedactionStatus;
  excerptHash: string;
  publicText?: string;
};

export type StyleGuideProposalRule = {
  ruleId: string;
  guidance: string;
};

export type StyleGuideProposalBaseEdit = {
  operation: StyleGuideProposalOperation;
  section: StyleGuidePolicySection;
  rule: StyleGuideProposalRule;
};

export type StyleGuideToneProposalEdit = StyleGuideProposalBaseEdit & {
  section: "tone";
  toneRegister: "formal" | "neutral" | "casual" | "playful";
};

export type StyleGuideTerminologyProposalEdit = StyleGuideProposalBaseEdit & {
  section: "terminology";
  sourceTerm: string;
  targetTerm: string;
  preserveMode: "translate" | "preserve" | "romanize";
};

export type StyleGuideHonorificsProposalEdit = StyleGuideProposalBaseEdit & {
  section: "honorifics";
  addressStrategy: "preserve" | "localize" | "omit_when_contextual";
};

export type StyleGuideFormattingProposalEdit = StyleGuideProposalBaseEdit & {
  section: "formatting";
  formattingKind: "line_length" | "punctuation" | "markup" | "choice_label";
};

export type StyleGuideProtectedSpanProposalEdit = StyleGuideProposalBaseEdit & {
  section: "protectedSpans";
  spanKind: "placeholder" | "control_markup" | "variable_placeholder" | "ruby_annotation";
  preserveMode: "exact" | "map" | "transform" | "locale_policy";
};

export type StyleGuideProposalEdit =
  | StyleGuideToneProposalEdit
  | StyleGuideTerminologyProposalEdit
  | StyleGuideHonorificsProposalEdit
  | StyleGuideFormattingProposalEdit
  | StyleGuideProtectedSpanProposalEdit;

export type StyleGuideProposal = {
  proposalId: string;
  turnId: string;
  localeBranchId: string;
  policyVersionId: string;
  rationale: string;
  citationIds: string[];
  examples: StyleGuideProposalExample[];
  edits: StyleGuideProposalEdit[];
  decision: {
    status: StyleGuideProposalDecision;
    decidedByTurnId: string;
    rationale: string;
  };
};

export type StyleGuideConversationTranscript = {
  schemaVersion: typeof STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION;
  transcriptId: string;
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  basePolicyVersionId: string;
  projectedStyleGuideVersionId: string;
  recordingMode: "public_fixture" | "human_entered";
  turns: StyleGuideConversationTurn[];
  proposals: StyleGuideProposal[];
};

export type StyleGuidePolicyRuleDraft = {
  ruleId: string;
  guidance: string;
};

export type StyleGuidePolicyV0Draft = {
  schemaVersion: typeof STYLE_GUIDE_POLICY_SCHEMA_VERSION;
  sections: Record<StyleGuidePolicySection, StyleGuidePolicyRuleDraft[]>;
};

export type StyleGuideProjectedVersionDraft = {
  localeBranchId: string;
  styleGuideVersionId: string;
  expectedPreviousVersionId: string;
  sourceTranscriptId: string;
  acceptedProposalIds: string[];
  policy: StyleGuidePolicyV0Draft;
};

type TurnProposalIds = {
  proposalIds: Set<string>;
  field: string;
};

type MutableStyleGuideSections = Record<StyleGuidePolicySection, Map<string, string>>;

export function assertStyleGuideConversationTranscript(
  value: unknown,
): asserts value is StyleGuideConversationTranscript {
  const diagnostics = validateStyleGuideConversationTranscript(value);
  if (diagnostics.length > 0) {
    const first = diagnostics[0] ?? fallbackDiagnostic();
    throw new Error(
      `StyleGuideConversationTranscript turn ${first.turnId} field ${first.field} failed ${first.rule}: ${first.message}`,
    );
  }
}

export function validateStyleGuideConversationTranscript(
  value: unknown,
): StyleGuideConversationDiagnostic[] {
  const diagnostics: StyleGuideConversationDiagnostic[] = [];
  if (!isRecord(value)) {
    return [
      diagnostic(
        "transcript",
        "$",
        "style_guide_conversation.transcript.object",
        "transcript must be an object",
      ),
    ];
  }

  checkNoRawPrivateFields(value, "transcript", "$", diagnostics);
  checkStringLiteral(
    value.schemaVersion,
    STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION,
    "transcript",
    "$.schemaVersion",
    "style_guide_conversation.schema_version",
    diagnostics,
  );
  checkNonBlankString(
    value.transcriptId,
    "transcript",
    "$.transcriptId",
    "style_guide_conversation.transcript_id",
    diagnostics,
  );
  checkUuid7(
    value.projectId,
    "transcript",
    "$.projectId",
    "style_guide_conversation.project_id",
    diagnostics,
  );
  checkUuid7(
    value.localeBranchId,
    "transcript",
    "$.localeBranchId",
    "style_guide_conversation.locale_branch_id",
    diagnostics,
  );
  checkNonBlankString(
    value.targetLocale,
    "transcript",
    "$.targetLocale",
    "style_guide_conversation.target_locale",
    diagnostics,
  );
  checkUuid7(
    value.basePolicyVersionId,
    "transcript",
    "$.basePolicyVersionId",
    "style_guide_conversation.base_policy_version_id",
    diagnostics,
  );
  checkUuid7(
    value.projectedStyleGuideVersionId,
    "transcript",
    "$.projectedStyleGuideVersionId",
    "style_guide_conversation.projected_style_guide_version_id",
    diagnostics,
  );
  checkEnum(
    value.recordingMode,
    ["public_fixture", "human_entered"] as const,
    "transcript",
    "$.recordingMode",
    "style_guide_conversation.recording_mode",
    diagnostics,
  );

  const turns = Array.isArray(value.turns) ? value.turns : [];
  if (!Array.isArray(value.turns)) {
    diagnostics.push(
      diagnostic(
        "transcript",
        "$.turns",
        "style_guide_conversation.turns.array",
        "turns must be an array",
      ),
    );
  }
  const proposals = Array.isArray(value.proposals) ? value.proposals : [];
  if (!Array.isArray(value.proposals)) {
    diagnostics.push(
      diagnostic(
        "transcript",
        "$.proposals",
        "style_guide_conversation.proposals.array",
        "proposals must be an array",
      ),
    );
  }

  const turnIds = new Set<string>();
  const citationIds = new Set<string>();
  const proposalIdsFromTurns = new Set<string>();
  const proposalIdsByTurnId = new Map<string, TurnProposalIds>();
  for (const [index, turnValue] of turns.entries()) {
    validateTurn(
      turnValue,
      index,
      value.localeBranchId,
      value.basePolicyVersionId,
      turnIds,
      citationIds,
      proposalIdsFromTurns,
      proposalIdsByTurnId,
      diagnostics,
    );
  }

  const proposalIds = new Set<string>();
  for (const [index, proposalValue] of proposals.entries()) {
    validateProposal(
      proposalValue,
      index,
      value.localeBranchId,
      value.basePolicyVersionId,
      turnIds,
      citationIds,
      proposalIdsByTurnId,
      proposalIds,
      diagnostics,
    );
  }

  for (const proposalId of proposalIdsFromTurns) {
    if (!proposalIds.has(proposalId)) {
      diagnostics.push(
        diagnostic(
          turnIdForMissingProposal(turns, proposalId),
          "$.turns[].proposalIds",
          "style_guide_conversation.turn.proposal_id_known",
          `proposal id ${proposalId} must reference a proposal in the transcript`,
          proposalId,
        ),
      );
    }
  }

  diagnostics.push(...projectionConflictDiagnostics(value, proposalIds));

  return diagnostics;
}

export function projectStyleGuideConversationToPolicyDraft(
  value: unknown,
): StyleGuideProjectedVersionDraft {
  const diagnostics = validateStyleGuideConversationTranscript(value);
  if (diagnostics.length > 0) {
    const first = diagnostics[0] ?? fallbackDiagnostic();
    throw new Error(
      `StyleGuideConversationTranscript turn ${first.turnId} field ${first.field} failed ${first.rule}: ${first.message}`,
    );
  }
  const transcript = value as StyleGuideConversationTranscript;
  const sections = emptyMutableSections();
  const acceptedProposalIds: string[] = [];

  for (const proposal of transcript.proposals) {
    if (proposal.decision.status !== "accepted") {
      continue;
    }
    acceptedProposalIds.push(proposal.proposalId);
    for (const edit of proposal.edits) {
      if (edit.operation === "remove_rule") {
        sections[edit.section].delete(edit.rule.ruleId);
        continue;
      }
      sections[edit.section].set(edit.rule.ruleId, edit.rule.guidance);
    }
  }

  return {
    localeBranchId: transcript.localeBranchId,
    styleGuideVersionId: transcript.projectedStyleGuideVersionId,
    expectedPreviousVersionId: transcript.basePolicyVersionId,
    sourceTranscriptId: transcript.transcriptId,
    acceptedProposalIds,
    policy: {
      schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
      sections: freezeSections(sections),
    },
  };
}

function validateTurn(
  value: unknown,
  index: number,
  transcriptLocaleBranchId: unknown,
  transcriptPolicyVersionId: unknown,
  turnIds: Set<string>,
  citationIds: Set<string>,
  proposalIdsFromTurns: Set<string>,
  proposalIdsByTurnId: Map<string, TurnProposalIds>,
  diagnostics: StyleGuideConversationDiagnostic[],
): void {
  const fallbackTurnId = `turns[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        fallbackTurnId,
        `$.turns[${index}]`,
        "style_guide_conversation.turn.object",
        "turn must be an object",
      ),
    );
    return;
  }
  const turnId = typeof value.turnId === "string" ? value.turnId : fallbackTurnId;
  checkNonBlankString(
    value.turnId,
    turnId,
    `$.turns[${index}].turnId`,
    "style_guide_conversation.turn.turn_id",
    diagnostics,
  );
  if (typeof value.turnId === "string") {
    if (turnIds.has(value.turnId)) {
      diagnostics.push(
        diagnostic(
          turnId,
          `$.turns[${index}].turnId`,
          "style_guide_conversation.turn.turn_id_unique",
          `turn id ${value.turnId} must be unique`,
        ),
      );
    }
    turnIds.add(value.turnId);
  }
  checkEnum(
    value.role,
    STYLE_GUIDE_CONVERSATION_ROLES,
    turnId,
    `$.turns[${index}].role`,
    "style_guide_conversation.turn.role",
    diagnostics,
  );
  checkUuid7(
    value.localeBranchId,
    turnId,
    `$.turns[${index}].localeBranchId`,
    "style_guide_conversation.turn.locale_branch_id",
    diagnostics,
  );
  checkEquals(
    value.localeBranchId,
    transcriptLocaleBranchId,
    turnId,
    `$.turns[${index}].localeBranchId`,
    "style_guide_conversation.turn.locale_branch_scope",
    "turn localeBranchId must match transcript localeBranchId",
    diagnostics,
  );
  checkUuid7(
    value.policyVersionId,
    turnId,
    `$.turns[${index}].policyVersionId`,
    "style_guide_conversation.turn.policy_version_id",
    diagnostics,
  );
  checkEquals(
    value.policyVersionId,
    transcriptPolicyVersionId,
    turnId,
    `$.turns[${index}].policyVersionId`,
    "style_guide_conversation.turn.policy_version_scope",
    "turn policyVersionId must match transcript basePolicyVersionId",
    diagnostics,
  );
  validateRedaction(value.redaction, turnId, `$.turns[${index}].redaction`, diagnostics);
  const proposalIds = validateStringArray(
    value.proposalIds,
    turnId,
    `$.turns[${index}].proposalIds`,
    "style_guide_conversation.turn.proposal_ids",
    diagnostics,
    proposalIdsFromTurns,
  );
  if (Array.isArray(value.proposalIds)) {
    for (const [entryIndex, entry] of value.proposalIds.entries()) {
      if (typeof entry === "string" && entry.trim().length > 0 && !isUuid7(entry)) {
        diagnostics.push(
          diagnostic(
            turnId,
            `$.turns[${index}].proposalIds[${entryIndex}]`,
            "style_guide_conversation.turn.proposal_id_uuid7",
            `$.turns[${index}].proposalIds[${entryIndex}] must be a UUID7 proposal id`,
            entry,
          ),
        );
      }
    }
  }
  if (typeof value.turnId === "string" && Array.isArray(value.proposalIds)) {
    proposalIdsByTurnId.set(value.turnId, {
      proposalIds: new Set(proposalIds),
      field: `$.turns[${index}].proposalIds`,
    });
  }
  validateCitations(
    value.citations,
    turnId,
    `$.turns[${index}].citations`,
    citationIds,
    diagnostics,
  );
  checkNonBlankString(
    value.publicSummary,
    turnId,
    `$.turns[${index}].publicSummary`,
    "style_guide_conversation.turn.public_summary",
    diagnostics,
  );
}

function validateProposal(
  value: unknown,
  index: number,
  transcriptLocaleBranchId: unknown,
  transcriptPolicyVersionId: unknown,
  turnIds: Set<string>,
  citationIds: Set<string>,
  proposalIdsByTurnId: Map<string, TurnProposalIds>,
  proposalIds: Set<string>,
  diagnostics: StyleGuideConversationDiagnostic[],
): void {
  const fallbackTurnId = `proposals[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        fallbackTurnId,
        `$.proposals[${index}]`,
        "style_guide_conversation.proposal.object",
        "proposal must be an object",
      ),
    );
    return;
  }
  const turnId = typeof value.turnId === "string" ? value.turnId : fallbackTurnId;
  const proposalId = typeof value.proposalId === "string" ? value.proposalId : undefined;

  checkNonBlankString(
    value.proposalId,
    turnId,
    `$.proposals[${index}].proposalId`,
    "style_guide_conversation.proposal.proposal_id",
    diagnostics,
  );
  if (proposalId !== undefined && proposalId.trim().length > 0 && !isUuid7(proposalId)) {
    diagnostics.push(
      diagnostic(
        turnId,
        `$.proposals[${index}].proposalId`,
        "style_guide_conversation.proposal.proposal_id_uuid7",
        `$.proposals[${index}].proposalId must be a UUID7 proposal id`,
        proposalId,
      ),
    );
  }
  if (proposalId !== undefined) {
    if (proposalIds.has(proposalId)) {
      diagnostics.push(
        diagnostic(
          turnId,
          `$.proposals[${index}].proposalId`,
          "style_guide_conversation.proposal.proposal_id_unique",
          `proposal id ${proposalId} must be unique`,
          proposalId,
        ),
      );
    }
    proposalIds.add(proposalId);
  }
  checkNonBlankString(
    value.turnId,
    turnId,
    `$.proposals[${index}].turnId`,
    "style_guide_conversation.proposal.turn_id",
    diagnostics,
    proposalId,
  );
  if (typeof value.turnId === "string" && !turnIds.has(value.turnId)) {
    diagnostics.push(
      diagnostic(
        turnId,
        `$.proposals[${index}].turnId`,
        "style_guide_conversation.proposal.turn_id_known",
        `proposal turnId ${value.turnId} must reference a known turn`,
        proposalId,
      ),
    );
  }
  const turnProposalIds =
    typeof value.turnId === "string" ? proposalIdsByTurnId.get(value.turnId) : undefined;
  if (
    proposalId !== undefined &&
    turnProposalIds !== undefined &&
    !turnProposalIds.proposalIds.has(proposalId)
  ) {
    diagnostics.push(
      diagnostic(
        turnId,
        turnProposalIds.field,
        "style_guide_conversation.proposal.turn_proposal_id_membership",
        `proposal id ${proposalId} must be listed in turn ${turnId} proposalIds`,
        proposalId,
      ),
    );
  }
  checkUuid7(
    value.localeBranchId,
    turnId,
    `$.proposals[${index}].localeBranchId`,
    "style_guide_conversation.proposal.locale_branch_id",
    diagnostics,
    proposalId,
  );
  checkEquals(
    value.localeBranchId,
    transcriptLocaleBranchId,
    turnId,
    `$.proposals[${index}].localeBranchId`,
    "style_guide_conversation.proposal.locale_branch_scope",
    "proposal localeBranchId must match transcript localeBranchId",
    diagnostics,
    proposalId,
  );
  checkUuid7(
    value.policyVersionId,
    turnId,
    `$.proposals[${index}].policyVersionId`,
    "style_guide_conversation.proposal.policy_version_id",
    diagnostics,
    proposalId,
  );
  checkEquals(
    value.policyVersionId,
    transcriptPolicyVersionId,
    turnId,
    `$.proposals[${index}].policyVersionId`,
    "style_guide_conversation.proposal.policy_version_scope",
    "proposal policyVersionId must match transcript basePolicyVersionId",
    diagnostics,
    proposalId,
  );
  checkNonBlankString(
    value.rationale,
    turnId,
    `$.proposals[${index}].rationale`,
    "style_guide_conversation.proposal.rationale_required",
    diagnostics,
    proposalId,
  );
  validateCitationIds(
    value.citationIds,
    turnId,
    `$.proposals[${index}].citationIds`,
    citationIds,
    diagnostics,
    proposalId,
  );
  validateExamples(
    value.examples,
    turnId,
    `$.proposals[${index}].examples`,
    diagnostics,
    proposalId,
  );
  validateEdits(value.edits, turnId, `$.proposals[${index}].edits`, diagnostics, proposalId);
  validateDecision(
    value.decision,
    turnId,
    `$.proposals[${index}].decision`,
    turnIds,
    diagnostics,
    proposalId,
  );
}

function validateRedaction(
  value: unknown,
  turnId: string,
  field: string,
  diagnostics: StyleGuideConversationDiagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        "style_guide_conversation.redaction.object",
        "redaction must be an object",
      ),
    );
    return;
  }
  checkEnum(
    value.status,
    STYLE_GUIDE_REDACTION_STATUSES,
    turnId,
    `${field}.status`,
    "style_guide_conversation.redaction.status",
    diagnostics,
  );
  const privateRefs = validateStringArray(
    value.privateExampleRefs,
    turnId,
    `${field}.privateExampleRefs`,
    "style_guide_conversation.redaction.private_example_refs",
    diagnostics,
  );
  if (privateRefs.length > 0 && value.status !== "redacted") {
    diagnostics.push(
      diagnostic(
        turnId,
        `${field}.status`,
        "style_guide_conversation.redaction.private_examples_redacted",
        "turns with private example refs must have redaction status redacted",
      ),
    );
  }
  if (value.redactedBy !== undefined) {
    checkNonBlankString(
      value.redactedBy,
      turnId,
      `${field}.redactedBy`,
      "style_guide_conversation.redaction.redacted_by",
      diagnostics,
    );
  }
}

function validateCitations(
  value: unknown,
  turnId: string,
  field: string,
  citationIds: Set<string>,
  diagnostics: StyleGuideConversationDiagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        "style_guide_conversation.citations.array",
        "citations must be an array",
      ),
    );
    return;
  }
  for (const [index, citationValue] of value.entries()) {
    const citationField = `${field}[${index}]`;
    if (!isRecord(citationValue)) {
      diagnostics.push(
        diagnostic(
          turnId,
          citationField,
          "style_guide_conversation.citation.object",
          "citation must be an object",
        ),
      );
      continue;
    }
    checkNonBlankString(
      citationValue.citationId,
      turnId,
      `${citationField}.citationId`,
      "style_guide_conversation.citation.citation_id",
      diagnostics,
    );
    if (typeof citationValue.citationId === "string") {
      if (citationIds.has(citationValue.citationId)) {
        diagnostics.push(
          diagnostic(
            turnId,
            `${citationField}.citationId`,
            "style_guide_conversation.citation.citation_id_unique",
            `citation id ${citationValue.citationId} must be unique`,
          ),
        );
      }
      citationIds.add(citationValue.citationId);
    }
    checkEnum(
      citationValue.sourceKind,
      STYLE_GUIDE_CITATION_SOURCE_KINDS,
      turnId,
      `${citationField}.sourceKind`,
      "style_guide_conversation.citation.source_kind",
      diagnostics,
    );
    checkNonBlankString(
      citationValue.sourceRef,
      turnId,
      `${citationField}.sourceRef`,
      "style_guide_conversation.citation.source_ref",
      diagnostics,
    );
    checkHash(
      citationValue.excerptHash,
      turnId,
      `${citationField}.excerptHash`,
      "style_guide_conversation.citation.excerpt_hash",
      diagnostics,
    );
  }
}

function validateCitationIds(
  value: unknown,
  turnId: string,
  field: string,
  citationIds: Set<string>,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId: string | undefined,
): void {
  const ids = validateStringArray(
    value,
    turnId,
    field,
    "style_guide_conversation.proposal.citation_ids",
    diagnostics,
    undefined,
    proposalId,
  );
  for (const [index, id] of ids.entries()) {
    if (!citationIds.has(id)) {
      diagnostics.push(
        diagnostic(
          turnId,
          `${field}[${index}]`,
          "style_guide_conversation.proposal.citation_id_known",
          `citation id ${id} must reference a citation in the transcript`,
          proposalId,
        ),
      );
    }
  }
}

function validateExamples(
  value: unknown,
  turnId: string,
  field: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId: string | undefined,
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        "style_guide_conversation.proposal.examples_array",
        "examples must be an array",
        proposalId,
      ),
    );
    return;
  }
  for (const [index, exampleValue] of value.entries()) {
    const exampleField = `${field}[${index}]`;
    if (!isRecord(exampleValue)) {
      diagnostics.push(
        diagnostic(
          turnId,
          exampleField,
          "style_guide_conversation.proposal.example_object",
          "example must be an object",
          proposalId,
        ),
      );
      continue;
    }
    checkNonBlankString(
      exampleValue.exampleId,
      turnId,
      `${exampleField}.exampleId`,
      "style_guide_conversation.proposal.example_id",
      diagnostics,
      proposalId,
    );
    checkEnum(
      exampleValue.privacy,
      STYLE_GUIDE_EXAMPLE_PRIVACY,
      turnId,
      `${exampleField}.privacy`,
      "style_guide_conversation.proposal.example_privacy",
      diagnostics,
      proposalId,
    );
    checkEnum(
      exampleValue.redactionStatus,
      STYLE_GUIDE_REDACTION_STATUSES,
      turnId,
      `${exampleField}.redactionStatus`,
      "style_guide_conversation.proposal.example_redaction_status",
      diagnostics,
      proposalId,
    );
    checkHash(
      exampleValue.excerptHash,
      turnId,
      `${exampleField}.excerptHash`,
      "style_guide_conversation.proposal.example_excerpt_hash",
      diagnostics,
      proposalId,
    );
    if (exampleValue.publicText !== undefined) {
      checkNonBlankString(
        exampleValue.publicText,
        turnId,
        `${exampleField}.publicText`,
        "style_guide_conversation.proposal.example_public_text",
        diagnostics,
        proposalId,
      );
    }
    if (exampleValue.privacy === "private") {
      if (exampleValue.redactionStatus !== "redacted") {
        diagnostics.push(
          diagnostic(
            turnId,
            `${exampleField}.redactionStatus`,
            "style_guide_conversation.proposal.private_example_redacted",
            "private examples must be redacted before entering public transcripts",
            proposalId,
          ),
        );
      }
      if (
        typeof exampleValue.publicText === "string" &&
        !exampleValue.publicText.includes("[redacted]")
      ) {
        diagnostics.push(
          diagnostic(
            turnId,
            `${exampleField}.publicText`,
            "style_guide_conversation.proposal.private_example_public_text",
            "private examples may only expose redacted placeholder text",
            proposalId,
          ),
        );
      }
    }
  }
}

function validateEdits(
  value: unknown,
  turnId: string,
  field: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId: string | undefined,
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        "style_guide_conversation.proposal.edits_array",
        "edits must be an array",
        proposalId,
      ),
    );
    return;
  }
  if (value.length === 0) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        "style_guide_conversation.proposal.edits_non_empty",
        "proposals must include at least one structured edit",
        proposalId,
      ),
    );
  }
  const editKeys = new Map<string, string>();
  for (const [index, editValue] of value.entries()) {
    const editField = `${field}[${index}]`;
    if (!isRecord(editValue)) {
      diagnostics.push(
        diagnostic(
          turnId,
          editField,
          "style_guide_conversation.proposal.edit_object",
          "edit must be an object",
          proposalId,
        ),
      );
      continue;
    }
    checkEnum(
      editValue.operation,
      STYLE_GUIDE_PROPOSAL_OPERATIONS,
      turnId,
      `${editField}.operation`,
      "style_guide_conversation.proposal.edit_operation",
      diagnostics,
      proposalId,
    );
    checkEnum(
      editValue.section,
      STYLE_GUIDE_POLICY_SECTIONS,
      turnId,
      `${editField}.section`,
      "style_guide_conversation.proposal.unsupported_policy_section",
      diagnostics,
      proposalId,
    );
    const rule = isRecord(editValue.rule) ? editValue.rule : undefined;
    if (rule === undefined) {
      diagnostics.push(
        diagnostic(
          turnId,
          `${editField}.rule`,
          "style_guide_conversation.proposal.rule_object",
          "edit rule must be an object",
          proposalId,
        ),
      );
    } else {
      checkNonBlankString(
        rule.ruleId,
        turnId,
        `${editField}.rule.ruleId`,
        "style_guide_conversation.proposal.rule_id",
        diagnostics,
        proposalId,
      );
      checkNonBlankString(
        rule.guidance,
        turnId,
        `${editField}.rule.guidance`,
        "style_guide_conversation.proposal.rule_guidance",
        diagnostics,
        proposalId,
      );
      if (typeof editValue.section === "string" && typeof rule.ruleId === "string") {
        const key = `${editValue.section}:${rule.ruleId}`;
        const signature = `${String(editValue.operation)}:${String(rule.guidance)}`;
        const previous = editKeys.get(key);
        if (previous !== undefined && previous !== signature) {
          diagnostics.push(
            diagnostic(
              turnId,
              editField,
              "style_guide_conversation.proposal.conflicting_edits",
              `proposal ${proposalId ?? "(unknown)"} has conflicting edits for ${key}`,
              proposalId,
            ),
          );
        }
        editKeys.set(key, signature);
      }
    }
    validateSectionSpecificEdit(editValue, turnId, editField, diagnostics, proposalId);
  }
}

function validateSectionSpecificEdit(
  edit: Record<string, unknown>,
  turnId: string,
  field: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId: string | undefined,
): void {
  switch (edit.section) {
    case "tone":
      checkEnum(
        edit.toneRegister,
        ["formal", "neutral", "casual", "playful"] as const,
        turnId,
        `${field}.toneRegister`,
        "style_guide_conversation.proposal.tone_register",
        diagnostics,
        proposalId,
      );
      return;
    case "terminology":
      checkNonBlankString(
        edit.sourceTerm,
        turnId,
        `${field}.sourceTerm`,
        "style_guide_conversation.proposal.source_term",
        diagnostics,
        proposalId,
      );
      checkNonBlankString(
        edit.targetTerm,
        turnId,
        `${field}.targetTerm`,
        "style_guide_conversation.proposal.target_term",
        diagnostics,
        proposalId,
      );
      checkEnum(
        edit.preserveMode,
        ["translate", "preserve", "romanize"] as const,
        turnId,
        `${field}.preserveMode`,
        "style_guide_conversation.proposal.term_preserve_mode",
        diagnostics,
        proposalId,
      );
      return;
    case "honorifics":
      checkEnum(
        edit.addressStrategy,
        ["preserve", "localize", "omit_when_contextual"] as const,
        turnId,
        `${field}.addressStrategy`,
        "style_guide_conversation.proposal.address_strategy",
        diagnostics,
        proposalId,
      );
      return;
    case "formatting":
      checkEnum(
        edit.formattingKind,
        ["line_length", "punctuation", "markup", "choice_label"] as const,
        turnId,
        `${field}.formattingKind`,
        "style_guide_conversation.proposal.formatting_kind",
        diagnostics,
        proposalId,
      );
      return;
    case "protectedSpans":
      checkEnum(
        edit.spanKind,
        ["placeholder", "control_markup", "variable_placeholder", "ruby_annotation"] as const,
        turnId,
        `${field}.spanKind`,
        "style_guide_conversation.proposal.span_kind",
        diagnostics,
        proposalId,
      );
      checkEnum(
        edit.preserveMode,
        ["exact", "map", "transform", "locale_policy"] as const,
        turnId,
        `${field}.preserveMode`,
        "style_guide_conversation.proposal.span_preserve_mode",
        diagnostics,
        proposalId,
      );
      return;
    default:
      return;
  }
}

function validateDecision(
  value: unknown,
  turnId: string,
  field: string,
  turnIds: Set<string>,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId: string | undefined,
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        "style_guide_conversation.proposal.decision_object",
        "decision must be an object",
        proposalId,
      ),
    );
    return;
  }
  checkEnum(
    value.status,
    STYLE_GUIDE_PROPOSAL_DECISIONS,
    turnId,
    `${field}.status`,
    "style_guide_conversation.proposal.decision_status",
    diagnostics,
    proposalId,
  );
  checkNonBlankString(
    value.decidedByTurnId,
    turnId,
    `${field}.decidedByTurnId`,
    "style_guide_conversation.proposal.decided_by_turn_id",
    diagnostics,
    proposalId,
  );
  if (typeof value.decidedByTurnId === "string" && !turnIds.has(value.decidedByTurnId)) {
    diagnostics.push(
      diagnostic(
        turnId,
        `${field}.decidedByTurnId`,
        "style_guide_conversation.proposal.decision_turn_known",
        `decision turn ${value.decidedByTurnId} must reference a known turn`,
        proposalId,
      ),
    );
  }
  checkNonBlankString(
    value.rationale,
    turnId,
    `${field}.rationale`,
    "style_guide_conversation.proposal.decision_rationale",
    diagnostics,
    proposalId,
  );
}

function projectionConflictDiagnostics(
  value: Record<string, unknown>,
  proposalIds: Set<string>,
): StyleGuideConversationDiagnostic[] {
  if (!Array.isArray(value.proposals)) {
    return [];
  }
  const diagnostics: StyleGuideConversationDiagnostic[] = [];
  const acceptedEdits = new Map<
    string,
    { signature: string; proposalId: string; turnId: string }
  >();
  for (const proposalValue of value.proposals) {
    if (!isRecord(proposalValue) || !isRecord(proposalValue.decision)) {
      continue;
    }
    if (proposalValue.decision.status !== "accepted") {
      continue;
    }
    if (
      typeof proposalValue.proposalId !== "string" ||
      !proposalIds.has(proposalValue.proposalId)
    ) {
      continue;
    }
    const turnId = typeof proposalValue.turnId === "string" ? proposalValue.turnId : "unknown";
    if (!Array.isArray(proposalValue.edits)) {
      continue;
    }
    for (const editValue of proposalValue.edits) {
      if (!isRecord(editValue) || !isRecord(editValue.rule)) {
        continue;
      }
      if (typeof editValue.section !== "string" || typeof editValue.rule.ruleId !== "string") {
        continue;
      }
      const signature = `${String(editValue.operation)}:${String(editValue.rule.guidance)}`;
      const key = `${editValue.section}:${editValue.rule.ruleId}`;
      const previous = acceptedEdits.get(key);
      if (previous !== undefined && previous.signature !== signature) {
        diagnostics.push(
          diagnostic(
            turnId,
            "$.proposals[].edits",
            "style_guide_conversation.projection.conflicting_accepted_edit",
            `accepted proposals ${previous.proposalId} and ${proposalValue.proposalId} conflict on ${key}`,
            proposalValue.proposalId,
          ),
        );
      }
      acceptedEdits.set(key, { signature, proposalId: proposalValue.proposalId, turnId });
    }
  }
  return diagnostics;
}

function emptyMutableSections(): MutableStyleGuideSections {
  return {
    tone: new Map<string, string>(),
    terminology: new Map<string, string>(),
    honorifics: new Map<string, string>(),
    formatting: new Map<string, string>(),
    protectedSpans: new Map<string, string>(),
  };
}

function freezeSections(
  sections: MutableStyleGuideSections,
): Record<StyleGuidePolicySection, StyleGuidePolicyRuleDraft[]> {
  return {
    tone: sortedRules(sections.tone),
    terminology: sortedRules(sections.terminology),
    honorifics: sortedRules(sections.honorifics),
    formatting: sortedRules(sections.formatting),
    protectedSpans: sortedRules(sections.protectedSpans),
  };
}

function sortedRules(section: Map<string, string>): StyleGuidePolicyRuleDraft[] {
  return [...section.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleId, guidance]) => ({ ruleId, guidance }));
}

function validateStringArray(
  value: unknown,
  turnId: string,
  field: string,
  rule: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  collectInto?: Set<string>,
  proposalId?: string,
): string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic(turnId, field, rule, `${field} must be an array`, proposalId));
    return [];
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const entryField = `${field}[${index}]`;
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.push(
        diagnostic(
          turnId,
          entryField,
          rule,
          `${entryField} must be a non-empty string`,
          proposalId,
        ),
      );
      continue;
    }
    if (seen.has(entry)) {
      diagnostics.push(
        diagnostic(
          turnId,
          entryField,
          rule,
          `${entryField} must not duplicate ${entry}`,
          proposalId,
        ),
      );
      continue;
    }
    seen.add(entry);
    entries.push(entry);
    collectInto?.add(entry);
  }
  return entries;
}

function checkNonBlankString(
  value: unknown,
  turnId: string,
  field: string,
  rule: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId?: string,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(
      diagnostic(turnId, field, rule, `${field} must be a non-empty string`, proposalId),
    );
  }
}

function checkUuid7(
  value: unknown,
  turnId: string,
  field: string,
  rule: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId?: string,
): void {
  if (typeof value !== "string" || !isUuid7(value)) {
    diagnostics.push(
      diagnostic(turnId, field, rule, `${field} must be a UUID7 string`, proposalId),
    );
  }
}

function checkHash(
  value: unknown,
  turnId: string,
  field: string,
  rule: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId?: string,
): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        rule,
        `${field} must be a canonical sha256 hash string`,
        proposalId,
      ),
    );
  }
}

function checkStringLiteral(
  value: unknown,
  expected: string,
  turnId: string,
  field: string,
  rule: string,
  diagnostics: StyleGuideConversationDiagnostic[],
): void {
  if (value !== expected) {
    diagnostics.push(diagnostic(turnId, field, rule, `${field} must be ${expected}`));
  }
}

function checkEquals(
  value: unknown,
  expected: unknown,
  turnId: string,
  field: string,
  rule: string,
  message: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId?: string,
): void {
  if (value !== expected) {
    diagnostics.push(diagnostic(turnId, field, rule, message, proposalId));
  }
}

function checkEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  turnId: string,
  field: string,
  rule: string,
  diagnostics: StyleGuideConversationDiagnostic[],
  proposalId?: string,
): void {
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    diagnostics.push(
      diagnostic(
        turnId,
        field,
        rule,
        `${field} must be one of: ${allowedValues.join(", ")}`,
        proposalId,
      ),
    );
  }
}

function checkNoRawPrivateFields(
  value: unknown,
  turnId: string,
  field: string,
  diagnostics: StyleGuideConversationDiagnostic[],
): void {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "string" && value.includes("fixtures/private-local/")) {
      diagnostics.push(
        diagnostic(
          turnId,
          field,
          "style_guide_conversation.privacy.no_private_fixture_paths",
          "public transcripts must not reference fixtures/private-local",
        ),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkNoRawPrivateFields(entry, turnId, `${field}[${index}]`, diagnostics);
    }
    return;
  }
  const forbiddenKeys = new Set([
    "completionText",
    "completion_text",
    "privateText",
    "private_text",
    "promptText",
    "prompt_text",
    "rawContent",
    "raw_content",
    "rawPrivateData",
    "raw_private_data",
    "rawText",
    "raw_text",
    "requestBody",
    "request_body",
    "responseBody",
    "response_body",
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) {
      diagnostics.push(
        diagnostic(
          turnId,
          `${field}.${key}`,
          "style_guide_conversation.privacy.no_raw_private_fields",
          `${field}.${key} is not allowed; record ids, hashes, or redacted public text`,
        ),
      );
      continue;
    }
    checkNoRawPrivateFields(child, turnId, `${field}.${key}`, diagnostics);
  }
}

function turnIdForMissingProposal(turns: unknown[], proposalId: string): string {
  for (const turnValue of turns) {
    if (!isRecord(turnValue) || !Array.isArray(turnValue.proposalIds)) {
      continue;
    }
    if (turnValue.proposalIds.includes(proposalId) && typeof turnValue.turnId === "string") {
      return turnValue.turnId;
    }
  }
  return "transcript";
}

function diagnostic(
  turnId: string,
  field: string,
  rule: string,
  message: string,
  proposalId?: string,
): StyleGuideConversationDiagnostic {
  return {
    severity: "error",
    turnId,
    field,
    rule,
    message,
    ...(proposalId === undefined ? {} : { proposalId }),
  };
}

function fallbackDiagnostic(): StyleGuideConversationDiagnostic {
  return diagnostic(
    "transcript",
    "$",
    "style_guide_conversation.unknown",
    "style-guide conversation validation failed",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
