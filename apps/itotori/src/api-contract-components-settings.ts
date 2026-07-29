import { STRICT_API_BODY_KEYS } from "./api-schema.js";
import { arr, bool, nullableStr, num, obj, object, str } from "./api-contract-schema.js";
import type { ComponentBuilders } from "./api-contract-components.js";

export const settingsComponentBuilders: ComponentBuilders = {
  ApiModelRoutingProvider: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiModelRoutingProvider,
      properties: {
        providerId: str,
        providerFamily: str,
        endpointFamily: str,
        providerName: str,
        metadata: obj,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingModel: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiModelRoutingModel,
      properties: {
        modelRegistryId: str,
        providerId: str,
        modelId: str,
        capabilities: obj,
        pricing: obj,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingPromptPreset: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiModelRoutingPromptPreset,
      properties: {
        promptPresetId: str,
        promptTemplateVersion: str,
        presetSchemaVersion: str,
        promptHash: str,
        configSnapshot: obj,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingRoute: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiModelRoutingRoute,
      properties: {
        projectId: str,
        taskKind: str,
        providerId: str,
        modelId: str,
        modelRegistryId: str,
        fallbackModelIds: { type: "array", items: str },
        promptPresetId: str,
        promptTemplateVersion: str,
        updatedAt: str,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingSettingsResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiModelRoutingSettingsResponse,
      properties: {
        projectId: str,
        generatedAt: str,
        providers: { type: "array", items: ref("ApiModelRoutingProvider") },
        models: { type: "array", items: ref("ApiModelRoutingModel") },
        promptPresets: { type: "array", items: ref("ApiModelRoutingPromptPreset") },
        routes: { type: "array", items: ref("ApiModelRoutingRoute") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.model-routing.v0",
    }),
  ApiSaveModelRoutingSettingsRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiSaveModelRoutingSettingsRequest,
      properties: {
        projectId: str,
        taskKind: str,
        providerId: str,
        modelId: str,
        fallbackModelIds: { type: "array", items: str },
        promptPresetId: str,
        promptTemplateVersion: str,
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyRule: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBranchPolicyRule,
      properties: { ruleId: str, guidance: str },
      additionalProperties: false,
    }),
  ApiBranchPolicySections: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBranchPolicySections,
      properties: {
        tone: { type: "array", items: ref("ApiBranchPolicyRule") },
        terminology: { type: "array", items: ref("ApiBranchPolicyRule") },
        honorifics: { type: "array", items: ref("ApiBranchPolicyRule") },
        formatting: { type: "array", items: ref("ApiBranchPolicyRule") },
        protectedSpans: { type: "array", items: ref("ApiBranchPolicyRule") },
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyPolicy: (ref) =>
    object({
      required: ["schemaVersion", "sections"],
      properties: {
        sections: ref("ApiBranchPolicySections"),
      },
      additionalProperties: false,
      schemaVersion: "style-guide-policy.v0",
    }),
  ApiBranchPolicySourceRevisionReference: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBranchPolicySourceRevisionReference,
      properties: {
        sourceRevisionId: str,
        revisionKind: str,
        value: str,
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyVersion: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBranchPolicyVersion,
      properties: {
        styleGuideVersionId: str,
        status: str,
        versionSequence: num,
        createdAt: str,
        updatedAt: str,
        approvedAt: nullableStr,
        policy: ref("ApiBranchPolicyPolicy"),
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyGlossaryReference: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBranchPolicyGlossaryReference,
      properties: {
        referenceId: str,
        versionSequence: num,
        styleGuideVersionId: nullableStr,
        glossaryContentHash: str,
        glossaryTermCount: num,
        updateReason: str,
        createdAt: str,
      },
      additionalProperties: false,
    }),
  ApiBranchPolicySettingsResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBranchPolicySettingsResponse,
      properties: {
        projectId: str,
        localeBranchId: str,
        targetLocale: str,
        sourceRevision: ref("ApiBranchPolicySourceRevisionReference"),
        latestVersion: { oneOf: [ref("ApiBranchPolicyVersion"), { type: "null" }] },
        approvedVersion: { oneOf: [ref("ApiBranchPolicyVersion"), { type: "null" }] },
        branchReference: {
          oneOf: [ref("ApiBranchPolicyGlossaryReference"), { type: "null" }],
        },
        policy: ref("ApiBranchPolicyPolicy"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.branch-policy.v0",
    }),
  ApiSaveBranchPolicySettingsRequest: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiSaveBranchPolicySettingsRequest,
      properties: {
        projectId: str,
        localeBranchId: str,
        expectedPreviousVersionId: nullableStr,
        updateReason: str,
        policy: ref("ApiBranchPolicyPolicy"),
      },
      additionalProperties: false,
    }),
  ApiTranslationScopeSettingsResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiTranslationScopeSettingsResponse,
      properties: {
        projectId: str,
        localeBranchId: str,
        scope: {
          enum: ["dialogue-only", "dialogue-and-choices", "dialogue-choices-ui", "all"],
        },
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.translation-scope.v0",
    }),
  ApiSaveTranslationScopeSettingsRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiSaveTranslationScopeSettingsRequest,
      properties: {
        projectId: str,
        localeBranchId: str,
        scope: {
          enum: ["dialogue-only", "dialogue-and-choices", "dialogue-choices-ui", "all"],
        },
      },
      additionalProperties: false,
    }),
  ApiLocalizationRunConfigResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiLocalizationRunConfigResponse,
      properties: {
        projectId: str,
        localeBranchId: str,
        configPath: str,
        dataRoot: str,
        pairPolicyPath: str,
        modelId: str,
        providerId: str,
        runDir: str,
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.localization-run-config.v0",
    }),
  ApiSaveLocalizationRunConfigRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiSaveLocalizationRunConfigRequest,
      properties: {
        projectId: str,
        localeBranchId: str,
        configPath: str,
        dataRoot: str,
        pairPolicyPath: str,
        modelId: str,
        providerId: str,
        runDir: str,
      },
      additionalProperties: false,
    }),
};
