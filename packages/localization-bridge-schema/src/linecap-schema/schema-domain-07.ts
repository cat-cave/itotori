import {
  BRIDGE_SCHEMA_VERSION_V02,
  Bcp47Locale,
  OBSERVATION_HOOK_SCHEMA_VERSION,
  ObservationHookEventKind,
  ObservationRedactionStatus,
  RuntimeCapabilityClassV02,
  RuntimeEvidenceTierV02,
  RuntimeFeatureStatusV02,
  RuntimeFidelityTierV02,
  RuntimePlaybackFeatureV02,
  RuntimeRequestedOperationV02,
  Uuid7,
} from "./schema-domain-01.js";
import {
  AlphaVerticalProofArtifactKindV02,
  AlphaVerticalProofHashScopeV02,
  ContractFixtureKindV02,
  ItotoriPermissionV02,
  PatchCompatibilityStatusV02,
  PatchFailureCategoryV02,
  PatchIncompatibilityReasonV02,
  PatchPartialWriteDispositionV02,
  PatchResultStatusV02,
} from "./schema-domain-02.js";
import {
  HashStrategyV02,
  RuntimeApproximationV02,
  RuntimeBranchPointEventV02,
  RuntimeCaptureV02,
  RuntimeRecordingV02,
  RuntimeReferenceComparisonV02,
  RuntimeTraceEventV02,
  RuntimeValidationFindingV02,
  SourceGameRevisionV02,
  SourceLocationV02,
  SourceRevisionV02,
} from "./schema-domain-03.js";
import { FindingRecordV02 } from "./schema-domain-04.js";

export type PatchExportEntryV02 = {
  entryId: Uuid7;
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  targetText: string;
  protectedSpanMappings: Array<{
    raw: string;
    sourceSpanId?: Uuid7;
    sourceStartByte?: number;
    sourceEndByte?: number;
    targetStart: number;
    targetEnd: number;
  }>;
};

export type PatchExportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchExportId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceGame: SourceGameRevisionV02;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  hashStrategy: HashStrategyV02;
  patchExportHash?: string;
  generatedAt?: string;
  entries: PatchExportEntryV02[];
};

export type UnitSourceCompatibilityV02 = {
  entryId: Uuid7;
  bridgeUnitId: Uuid7;
  actualBridgeUnitId?: Uuid7;
  sourceUnitKey: string;
  status: PatchCompatibilityStatusV02;
  expectedSourceHash: string;
  actualSourceHash?: string;
  reason?: PatchIncompatibilityReasonV02;
};

export type PatchSourceCompatibilityReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchExportId: Uuid7;
  sourceBridgeId: Uuid7;
  status: PatchCompatibilityStatusV02;
  expectedSourceBundleHash: string;
  actualSourceBundleHash: string;
  sourceBundleHashMatches: boolean;
  compatibleUnits: UnitSourceCompatibilityV02[];
  incompatibleUnits: UnitSourceCompatibilityV02[];
};

export type PatchFailureV02 = {
  failureId: Uuid7;
  category: PatchFailureCategoryV02;
  diagnosticCode: string;
  cause: string;
  assetId: Uuid7;
  bridgeUnitId: Uuid7;
  adapterId: string;
  command: string;
  patchExportEntryId?: Uuid7;
  sourceLocation?: SourceLocationV02;
};

export type PatchPartialWriteAccountingV02 = {
  attemptedAssetIds: Uuid7[];
  writtenAssetIds: Uuid7[];
  skippedAssetIds: Uuid7[];
  disposition: PatchPartialWriteDispositionV02;
  rollbackDiagnosticCode?: string;
};

export type PatchTouchedAssetV02 = {
  assetId: Uuid7;
  outputHash: string;
  byteSize: number;
};

export type PatchResultV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchResultId: Uuid7;
  patchExportId: Uuid7;
  adapterId: string;
  status: PatchResultStatusV02;
  outputHash?: string;
  touchedAssets?: PatchTouchedAssetV02[];
  failures: PatchFailureV02[];
  failureCategories?: PatchFailureCategoryV02[];
  partialWrite?: PatchPartialWriteAccountingV02;
  sourceCompatibility?: PatchSourceCompatibilityReportV02;
};

export type RuntimeFeatureSupportV02 = {
  feature: RuntimePlaybackFeatureV02;
  status: RuntimeFeatureStatusV02;
  evidenceTierCeiling?: RuntimeEvidenceTierV02;
  description: string;
  limitations: string[];
};

export type RuntimeCapabilityContractV02 = {
  contractVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  capabilityClass: RuntimeCapabilityClassV02;
  fidelityTierCeiling: RuntimeFidelityTierV02;
  evidenceTierCeiling: RuntimeEvidenceTierV02;
  features: RuntimeFeatureSupportV02[];
  limitations: string[];
};

export type ControlledPlaybackSessionV02 = {
  sessionId: Uuid7;
  adapterName: string;
  adapterVersion: string;
  capabilityClass: RuntimeCapabilityClassV02;
  requestedOperation: RuntimeRequestedOperationV02;
  status: "passed" | "failed";
  fidelityTier: RuntimeFidelityTierV02;
  evidenceTier: RuntimeEvidenceTierV02;
  featuresUsed: RuntimePlaybackFeatureV02[];
  limitations: string[];
};

export type ObservationAdapterId = {
  name: string;
  version: string;
};

export type ObservationEnvironment = {
  runtime: string;
  engine?: string;
  platform?: string;
  display?: string;
  locale?: string;
};

export type ObservationSourceRevision = {
  sourceId: string;
  revisionId?: string;
  contentHash?: string;
};

export type ObservationBridgeRef = {
  bridgeUnitId?: string;
  sourceUnitKey?: string;
  runtimeObjectId?: string;
};

export type ObservationRedactionMetadata = {
  status: ObservationRedactionStatus;
  rules?: string[];
  redactedFields?: string[];
};

export type ObservationArtifactRef = {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
};

export type ObservationChoiceOption = {
  optionId: string;
  label: string;
  bridgeRef?: ObservationBridgeRef;
};

export type ObservationTextPayload = {
  payloadKind: "text";
  text: string;
  speaker?: string;
  textSurface?: string;
};

export type ObservationChoicePayload = {
  payloadKind: "choice";
  prompt?: string;
  options: ObservationChoiceOption[];
};

export type ObservationBranchPayload = {
  payloadKind: "branch";
  branchId: string;
  label?: string;
  destination?: string;
  taken?: boolean;
};

export type ObservationScenePayload = {
  payloadKind: "scene";
  sceneId: string;
  sceneName?: string;
};

export type ObservationFramePayload = {
  payloadKind: "frame";
  frame: number;
  width?: number;
  height?: number;
  artifactRef?: ObservationArtifactRef;
};

export type ObservationErrorPayload = {
  payloadKind: "error";
  errorType: string;
  message: string;
  fatal: boolean;
  stack?: string;
};

export type ObservationHookPayload =
  | ObservationTextPayload
  | ObservationChoicePayload
  | ObservationBranchPayload
  | ObservationScenePayload
  | ObservationFramePayload
  | ObservationErrorPayload;

export type ObservationHookEvent = {
  schemaVersion: typeof OBSERVATION_HOOK_SCHEMA_VERSION;
  eventId: string;
  observedAt: string;
  eventKind: ObservationHookEventKind;
  runtimeTargetId: string;
  adapterId: ObservationAdapterId;
  evidenceTier: RuntimeEvidenceTierV02;
  environment: ObservationEnvironment;
  sourceRevision?: ObservationSourceRevision;
  bridgeRefs?: ObservationBridgeRef[];
  redaction: ObservationRedactionMetadata;
  payload: ObservationHookPayload;
};

export type RuntimeEvidenceReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  runtimeReportId: Uuid7;
  sourceBridgeId?: Uuid7;
  sourceBundleHash?: string;
  sourceLocale?: Bcp47Locale;
  targetLocale?: Bcp47Locale;
  adapterName: string;
  adapterVersion: string;
  fidelityTier: RuntimeFidelityTierV02;
  evidenceTier: RuntimeEvidenceTierV02;
  runtimeCapabilities?: RuntimeCapabilityContractV02;
  controlledPlaybackSession?: ControlledPlaybackSessionV02;
  status: "passed" | "failed";
  createdAt: string;
  traceEvents: RuntimeTraceEventV02[];
  branchEvents: RuntimeBranchPointEventV02[];
  observationHookEvents?: ObservationHookEvent[];
  captures: RuntimeCaptureV02[];
  recordings: RuntimeRecordingV02[];
  approximations: RuntimeApproximationV02[];
  validationFindings: RuntimeValidationFindingV02[];
  referenceComparisons?: RuntimeReferenceComparisonV02[];
  limitations: string[];
};

export type DeltaPackageMetadataV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  deltaPackageId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceGame: SourceGameRevisionV02;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  generatedPatchExportId: Uuid7;
  generatedPatchExportHash: string;
  targetLocale: Bcp47Locale;
  hashStrategy: HashStrategyV02;
  createdAt?: string;
};

export type FindingRecordFixtureV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  findingFixtureId: Uuid7;
  sourceTriageBundleId?: Uuid7;
  finding: FindingRecordV02;
  compatibilityNotes: string[];
};

export type PermissionLocalUserFixtureV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  permissionFixtureId: Uuid7;
  user: {
    userId: "local-user";
    displayName: "Local user";
  };
  grants: ItotoriPermissionV02[];
  compatibilityNotes: string[];
};

export type AlphaVerticalProofFixtureRefV02 = {
  fixtureId: string;
  publicManifestUri: string;
  publicManifestHash: string;
  publicRedistribution: "allowed";
};

export type AlphaVerticalProofEngineProfileV02 = {
  engineProfileId: string;
  engineKind: string;
  kaifuuProfileId: string;
  itotoriWorkflowId: string;
  utsushiRuntimeProfileId: string;
};

export type AlphaVerticalProofBridgeUnitRefV02 = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
};

export type AlphaVerticalProofArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: AlphaVerticalProofArtifactKindV02;
  uri: string;
  hash: string;
  mediaType?: string;
  byteSize?: number;
};

export type AlphaVerticalProofArtifactRefsV02 = {
  publicFixtureManifest: AlphaVerticalProofArtifactRefV02 & {
    artifactKind: "public_fixture_manifest";
  };
  bridgeBundle: AlphaVerticalProofArtifactRefV02 & { artifactKind: "bridge_bundle" };
  patchExport: AlphaVerticalProofArtifactRefV02 & { artifactKind: "patch_export" };
  patchResult: AlphaVerticalProofArtifactRefV02 & { artifactKind: "patch_result" };
  deltaPackage: AlphaVerticalProofArtifactRefV02 & { artifactKind: "delta_package" };
  runtimeReport: AlphaVerticalProofArtifactRefV02 & { artifactKind: "runtime_report" };
  findingReport?: AlphaVerticalProofArtifactRefV02 & { artifactKind: "finding_report" };
  benchmarkReport: AlphaVerticalProofArtifactRefV02 & { artifactKind: "benchmark_report" };
};

export type AlphaVerticalProofBenchmarkOutputRefV02 = {
  benchmarkRunId: Uuid7;
  artifactRef: AlphaVerticalProofArtifactRefV02 & { artifactKind: "benchmark_report" };
};

export type AlphaVerticalProofContentHashV02 = {
  scope: AlphaVerticalProofHashScopeV02;
  contentId: string;
  hash: string;
};

export type AlphaVerticalProofManifestV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  proofManifestId: Uuid7;
  createdAt: string;
  fixture: AlphaVerticalProofFixtureRefV02;
  engineProfile: AlphaVerticalProofEngineProfileV02;
  sourceRevision: SourceRevisionV02;
  sourceBridgeId: Uuid7;
  sourceBundleHash: string;
  bridgeUnitRefs: AlphaVerticalProofBridgeUnitRefV02[];
  runtimeTargetIds: string[];
  artifactRefs: AlphaVerticalProofArtifactRefsV02;
  providerProofIds: Uuid7[];
  benchmarkOutputRefs: AlphaVerticalProofBenchmarkOutputRefV02[];
  contentHashes: AlphaVerticalProofContentHashV02[];
  compatibilityNotes: string[];
};

export type ContractFixtureManifestEntryV02 = {
  kind: ContractFixtureKindV02;
  path: string;
  description: string;
};

export type InvalidContractFixtureManifestEntryV02 = ContractFixtureManifestEntryV02 & {
  expectedSemanticError: string;
};

export type ContractFixtureManifestV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  suiteId: Uuid7;
  generatedAt: string;
  validFixtures: ContractFixtureManifestEntryV02[];
  invalidFixtures: InvalidContractFixtureManifestEntryV02[];
};
