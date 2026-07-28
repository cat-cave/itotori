import {
  AssetPolicyPatchModeV02,
  AssetPolicySurfaceKindV02,
  AssetPolicyTextSourceKindV02,
  BRIDGE_SCHEMA_VERSION_V02,
  Bcp47Locale,
  PolicyActionV02,
  PolicyRecordKindV02,
  PolicyScopeV02,
  RuntimeEvidenceTierV02,
  SurfaceKindV02,
  TriageSeverityV02,
  Uuid7,
} from "./schema-domain-01.js";
import {
  BenchmarkCostKindV02,
  BenchmarkInputKindV02,
  BenchmarkProviderFamilyV02,
  BenchmarkProviderRunStatusV02,
  BenchmarkSystemKindV02,
  BenchmarkTokenCountSourceV02,
  CausalLinkKindV02,
  CausalTargetKindV02,
  EvidenceKindV02,
  FindingKindV02,
  LocalizationQualityCategoryV02,
  PatchWriteModeV02,
  TriageEventKindV02,
  TriageSubjectKindV02,
  TriageTaskKindV02,
} from "./schema-domain-02.js";
import {
  AssetPolicyPatchRefV02,
  AssetRefV02,
  BridgeAssetV02,
  BridgeSpanV02,
  LocalizationPolicyV02,
  PatchRefV02,
  RuntimeBridgeUnitRefV02,
  RuntimeExpectationV02,
  SourceLocationV02,
  SourceRevisionV02,
  SpeakerContextV02,
  SurfaceContextV02,
} from "./schema-domain-03.js";

export type LocalizationUnitV02 = {
  bridgeUnitId: Uuid7;
  surfaceId: Uuid7;
  surfaceKind: SurfaceKindV02;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceLocale: Bcp47Locale;
  sourceText: string;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  sourceAssetRef: AssetRefV02;
  sourceLocation: SourceLocationV02;
  speaker?: SpeakerContextV02;
  context: SurfaceContextV02;
  policy?: LocalizationPolicyV02;
  spans: BridgeSpanV02[];
  patchRef: PatchRefV02;
  runtimeExpectation: RuntimeExpectationV02;
};

export type PolicyRecordV02 = {
  policyRecordId: Uuid7;
  policyRecordKind: PolicyRecordKindV02;
  policyAction: PolicyActionV02;
  termKey: string;
  sourceText: string;
  targetLocale?: Bcp47Locale;
  localeBranchId?: Uuid7;
  romanizationSystem?: string;
  preserveForm?: string;
  scope?: PolicyScopeV02;
  policyReason: string;
  reviewRequired?: boolean;
};

export type LocaleBranchScopeV02 = {
  localeBranchId: Uuid7;
  targetLocale: Bcp47Locale;
  localeBranchKey?: string;
};

export type AssetPolicyDecisionV02 = {
  assetPolicyDecisionId: Uuid7;
  assetSurfaceKind: AssetPolicySurfaceKindV02;
  sourceAssetRef: AssetRefV02;
  sourceLocation?: SourceLocationV02;
  sourceText?: string;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  policyAction: PolicyActionV02;
  targetText?: string;
  romanizationSystem?: string;
  preserveForm?: string;
  policyReason: string;
  textSourceKind: AssetPolicyTextSourceKindV02;
  patchMode: AssetPolicyPatchModeV02;
  patchRef?: AssetPolicyPatchRefV02;
  runtimeExpectation: RuntimeExpectationV02;
  reviewRequired?: boolean;
  linkedBridgeUnitRefs?: RuntimeBridgeUnitRefV02[];
  notes?: string[];
};

export type AssetPolicyBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  assetPolicyBundleId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceBundleHash?: string;
  sourceLocale: Bcp47Locale;
  localeBranch: LocaleBranchScopeV02;
  assets: BridgeAssetV02[];
  decisions: AssetPolicyDecisionV02[];
  compatibilityNotes: string[];
};

export type TriageActorV02 = {
  actorKind: "human" | "agent" | "tool" | "system";
  actorId?: Uuid7;
  displayName?: string;
};

export type TriageSubjectRefV02 = {
  subjectKind: TriageSubjectKindV02;
  subjectId: Uuid7;
  label?: string;
};

export type TriageArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: string;
  uri?: string;
  hash?: string;
};

export type SourceAnnotationProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "source_annotation";
  bridgeUnitId: Uuid7;
  spanId?: Uuid7;
  sourceAssetRef?: AssetRefV02;
  sourceLocation?: SourceLocationV02;
  annotationText?: string;
  observedAt?: string;
};

export type StyleGuideProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "style_guide";
  styleGuideId: Uuid7;
  styleGuideVersionId: Uuid7;
  ruleId: string;
  rulePath?: string;
  excerptHash?: string;
};

export type ModelOutputProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "model_output";
  modelOutputId: Uuid7;
  taskId?: Uuid7;
  provider: string;
  model: string;
  outputHash: string;
  promptHash?: string;
  artifactRef?: TriageArtifactRefV02;
};

export type PatchingCauseProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "patching_cause";
  patchResultId?: Uuid7;
  patchExportId?: Uuid7;
  bridgeUnitId?: Uuid7;
  assetRef?: AssetRefV02;
  writeMode?: PatchWriteModeV02;
  failureCode?: string;
  failureDetail?: string;
};

export type RuntimeEvidenceProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "runtime_evidence";
  runtimeReportId: Uuid7;
  bridgeUnitId?: Uuid7;
  artifactRef?: TriageArtifactRefV02;
  evidenceTier?: RuntimeEvidenceTierV02;
};

export type HumanReviewProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "human_review";
  reviewerId?: Uuid7;
  reviewSessionId?: Uuid7;
  noteHash: string;
};

export type DeterministicCheckProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "deterministic_check";
  checkId: Uuid7;
  checkName: string;
  checkVersion: string;
  artifactRef?: TriageArtifactRefV02;
};

export type ProvenanceRecordV02 =
  | SourceAnnotationProvenanceV02
  | StyleGuideProvenanceV02
  | ModelOutputProvenanceV02
  | PatchingCauseProvenanceV02
  | RuntimeEvidenceProvenanceV02
  | HumanReviewProvenanceV02
  | DeterministicCheckProvenanceV02;

export type EvidenceRecordV02 = {
  evidenceId: Uuid7;
  evidenceKind: EvidenceKindV02;
  summary: string;
  subjectRef?: TriageSubjectRefV02;
  artifactRef?: TriageArtifactRefV02;
  sourceLocation?: SourceLocationV02;
  expectedValue?: string;
  observedValue?: string;
  provenanceIds: Uuid7[];
};

export type CausalLinkV02 = {
  causalLinkId: Uuid7;
  linkKind: CausalLinkKindV02;
  targetKind: CausalTargetKindV02;
  targetId: Uuid7;
  rationale?: string;
};

export type TriageEventV02 = {
  eventId: Uuid7;
  eventKind: TriageEventKindV02;
  occurredAt: string;
  actor: TriageActorV02;
  taskId?: Uuid7;
  findingId?: Uuid7;
  subjectRefs: TriageSubjectRefV02[];
  provenance: ProvenanceRecordV02[];
  causalLinks: CausalLinkV02[];
  payload?: Record<string, unknown>;
};

export type TriageTaskV02 = {
  taskId: Uuid7;
  taskKind: TriageTaskKindV02;
  createdAt: string;
  summary: string;
  createdByEventId?: Uuid7;
  inputRefs: TriageSubjectRefV02[];
  provenance: ProvenanceRecordV02[];
  causalLinks: CausalLinkV02[];
};

export type FindingRecordV02 = {
  findingId: Uuid7;
  findingKind: FindingKindV02;
  severity: TriageSeverityV02;
  qualityCategory?: LocalizationQualityCategoryV02;
  title: string;
  description: string;
  impact: string;
  createdAt: string;
  reportedByTaskId?: Uuid7;
  firstSeenEventId?: Uuid7;
  affectedRefs: TriageSubjectRefV02[];
  evidence: EvidenceRecordV02[];
  provenance: ProvenanceRecordV02[];
  causalLinks: CausalLinkV02[];
};

export type TriageBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  triageBundleId: Uuid7;
  projectId?: Uuid7;
  sourceBridgeId?: Uuid7;
  localeBranchId?: Uuid7;
  events: TriageEventV02[];
  tasks: TriageTaskV02[];
  findings: FindingRecordV02[];
};

export type TriageBundleReferenceIndexV02 = {
  eventIds: ReadonlySet<Uuid7>;
  taskIds: ReadonlySet<Uuid7>;
  findingIds: ReadonlySet<Uuid7>;
  provenanceIds: ReadonlySet<Uuid7>;
};

export type BenchmarkArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: string;
  uri: string;
  hash?: string;
  mediaType?: string;
};

export type BenchmarkInputRefV02 = {
  corpusRefId: string;
  corpusKind: BenchmarkInputKindV02;
  label: string;
  manifestUri?: string;
  manifestHash?: string;
  sourceBundleHash?: string;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  engineProfile: string;
  benchmarkSplit: string;
  sourceUnitCount: number;
  sourceCharacterCount: number;
  publicContent: boolean;
};

export type BenchmarkToolVersionV02 = {
  name: string;
  version: string;
  gitCommit?: string;
};

export type BenchmarkCommandLineV02 = {
  commandId: string;
  argv: string[];
};

export type BenchmarkComparedSystemV02 = {
  systemId: string;
  systemKind: BenchmarkSystemKindV02;
  displayName: string;
  generatedAt: string;
  providerRunIds: Uuid7[];
  promptPresetId?: string;
  promptPresetVersion?: string;
  outputArtifactRef?: BenchmarkArtifactRefV02;
};

export type BenchmarkProviderIdentityV02 = {
  providerFamily: BenchmarkProviderFamilyV02;
  endpointFamily: string;
  providerName: string;
  requestedModelId: string;
  actualModelId: string;
  upstreamProvider?: string;
  routeSettingsHash?: string;
};

export type BenchmarkPromptIdentityV02 = {
  promptPresetId: string;
  promptTemplateVersion: string;
  promptHash?: string;
  remotePresetSlug?: string;
  remotePresetVersion?: string;
  remotePresetConfigHash?: string;
};

export type BenchmarkTokenUsageV02 = {
  tokenCountSource: BenchmarkTokenCountSourceV02;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type BenchmarkCostAmountV02 = {
  costKind: BenchmarkCostKindV02;
  currency: "USD";
  amountMicrosUsd?: number;
  pricingSnapshotId?: string;
};

export type BenchmarkProviderRunV02 = {
  providerRunId: Uuid7;
  systemId: string;
  taskKind: TriageTaskKindV02;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  status: BenchmarkProviderRunStatusV02;
  provider: BenchmarkProviderIdentityV02;
  prompt: BenchmarkPromptIdentityV02;
  structuredOutputMode: string;
  retryCount: number;
  errorClasses: string[];
  fallbackUsed: boolean;
  fallbackPlan?: string[];
  tokenUsage: BenchmarkTokenUsageV02;
  cost: BenchmarkCostAmountV02;
};

export type BenchmarkCostLedgerTotalV02 = {
  systemId: string;
  totalMicrosUsd: number;
};

export type BenchmarkCostLedgerV02 = {
  currency: "USD";
  reportTotalMicrosUsd: number;
  totalsBySystem: BenchmarkCostLedgerTotalV02[];
  includesUnknownCost: boolean;
  // the cost ledger names the SAME locale branch as its report.
  // The asserter rejects a ledger whose localeBranchId disagrees with the
  // report's so cost can never be merged across target locale branches.
  localeBranchId?: Uuid7;
};
