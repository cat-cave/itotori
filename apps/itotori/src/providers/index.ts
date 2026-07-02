export { AccountZdrAssertionError, assertOpenRouterZdrAccount } from "./account-zdr.js";
export { LocalProviderRunArtifactRecorder } from "./artifacts.js";
export {
  assertProviderInvocationSupported,
  CapabilityGuard,
  CapabilityGuardMissError,
  globalCapabilityGuard,
  modelProviderPairKey,
  type ModelProviderPairKey,
  type ProviderInvocationGuardInput,
  type ProviderRoutingCapabilityRequirement,
} from "./capability-guard.js";
export {
  DEV_PAIR,
  DevPairUnknownError,
  getCapabilities,
  getModelCapabilities,
  knownPairs,
  type DevPairCapabilities,
  type ModelProviderPair,
} from "./dev-pair.js";
// itotori-purge-fakemodelprovider-from-production — FakeModelProvider is a
// zero-cost canned-output test double and MUST NOT be reachable from the
// providers public barrel (that made it reachable from production wiring).
// Test code imports it directly from "./fake.js"; production code never does.
export {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  RecordedBundleMissingError,
  RecordedBundleSchemaMismatchError,
  RecordedCostMismatchError,
  RecordedModelProvider,
  mergeRecordedBundles,
  recordedModelCapabilities,
  type RecordedModelProviderOptions,
  type RecordedProviderBundle,
  type RecordedProviderResponse,
} from "./recorded.js";
export {
  LocalOpenAICompatibleProvider,
  localOpenAICompatibleDefaultCapabilities,
} from "./local-openai-compatible.js";
export {
  OpenRouterCostCapError,
  OpenRouterMissingArtifactRecorderError,
  OpenRouterMissingApiKeyError,
  OpenRouterModelProvider,
  OpenRouterProvider,
  extractCacheDiscountMicros,
  openRouterApiKeyFromEnv,
  openRouterDefaultCapabilities,
  type OpenRouterHttpClient,
  type OpenRouterModelProviderOptions,
} from "./openrouter.js";
export {
  assertStructuredOutputModeSupported,
  selectStructuredOutputMode,
  selectStructuredOutputRequest,
  supportForStructuredOutputMode,
  type StructuredOutputSchemaSpec,
} from "./structured-output.js";
export type {
  CapabilitySupport,
  EndpointFamily,
  ImageInputCapabilities,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModelCapabilities,
  ModelGenerationOptions,
  ModelImageContentPart,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelMessageRole,
  ModelProvider,
  ModelTextContentPart,
  ModelTool,
  ModelToolCall,
  ModelToolChoice,
  OpenRouterRoutingPosture,
  ProviderCost,
  ProviderDescriptor,
  ProviderFamily,
  ProviderInputClassification,
  ProviderLiveRunOptions,
  ProviderPresetReference,
  PromptPresetReference,
  ProviderRawCaptureMode,
  ProviderRunArtifact,
  ProviderRunArtifactRecorder,
  ProviderRunIdentity,
  ProviderRunRecord,
  RoutingCapabilities,
  StructuredOutputCapabilities,
  StructuredOutputMode,
  StructuredOutputRequest,
  TokenUsage,
  ToolCallCapabilities,
} from "./types.js";
export { localOnlyRoutingPosture, ModelProviderError } from "./types.js";
export {
  assertBilledCost,
  decimalUsdStringCanonical,
  decimalUsdStringToMicros,
  usageCostToDecimalString,
  usageCostToMicros,
  ZERO_COST,
} from "./cost.js";
