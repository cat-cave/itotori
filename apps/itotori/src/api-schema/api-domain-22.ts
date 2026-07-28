import { translationScopeValues } from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { ApiModelRoutingModel, ApiModelRoutingProvider } from "./api-domain-03.js";
import {
  ApiBranchPolicyPolicy,
  ApiBranchPolicyRule,
  ApiBranchPolicySections,
  ApiBranchPolicySettingsResponse,
  ApiConfigureAuthSsoSettingsResponse,
  ApiLocalizationRunConfigResponse,
  ApiModelRoutingPromptPreset,
  ApiModelRoutingSettingsResponse,
  ApiTranslationScope,
  ApiTranslationScopeSettingsResponse,
} from "./api-domain-04.js";
import { assertModelRoutingRoute } from "./api-domain-23.js";
import {
  asRecord,
  parseAccountSecuritySettings,
  parseAuthSessionPolicy,
  parseAuthSsoProviderConfig,
} from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNullableString,
  assertString,
} from "./api-domain-29.js";

export function assertConfigureAuthSsoSettingsResponse(
  value: unknown,
): asserts value is ApiConfigureAuthSsoSettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiConfigureAuthSsoSettingsResponse",
    STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.sso-settings.v0",
    "ApiConfigureAuthSsoSettingsResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiConfigureAuthSsoSettingsResponse.accountId");
  parseAuthSsoProviderConfig(response.provider, "ApiConfigureAuthSsoSettingsResponse.provider");
  parseAccountSecuritySettings(response.security, "ApiConfigureAuthSsoSettingsResponse.security");
  parseAuthSessionPolicy(
    response.sessionPolicy,
    "ApiConfigureAuthSsoSettingsResponse.sessionPolicy",
  );
  assertDateLike(response.updatedAt, "ApiConfigureAuthSsoSettingsResponse.updatedAt");
}

export function assertModelRoutingSettingsResponse(
  value: unknown,
): asserts value is ApiModelRoutingSettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiModelRoutingSettingsResponse",
    STRICT_API_BODY_KEYS.ApiModelRoutingSettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.model-routing.v0",
    "ApiModelRoutingSettingsResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiModelRoutingSettingsResponse.projectId");
  assertDateLike(response.generatedAt, "ApiModelRoutingSettingsResponse.generatedAt");
  for (const [index, provider] of asArray(
    response.providers,
    "ApiModelRoutingSettingsResponse.providers",
  ).entries()) {
    assertModelRoutingProvider(provider, `ApiModelRoutingSettingsResponse.providers[${index}]`);
  }
  for (const [index, model] of asArray(
    response.models,
    "ApiModelRoutingSettingsResponse.models",
  ).entries()) {
    assertModelRoutingModel(model, `ApiModelRoutingSettingsResponse.models[${index}]`);
  }
  for (const [index, preset] of asArray(
    response.promptPresets,
    "ApiModelRoutingSettingsResponse.promptPresets",
  ).entries()) {
    assertModelRoutingPromptPreset(
      preset,
      `ApiModelRoutingSettingsResponse.promptPresets[${index}]`,
    );
  }
  for (const [index, route] of asArray(
    response.routes,
    "ApiModelRoutingSettingsResponse.routes",
  ).entries()) {
    assertModelRoutingRoute(route, `ApiModelRoutingSettingsResponse.routes[${index}]`);
  }
}

export function assertBranchPolicySettingsResponse(
  value: unknown,
): asserts value is ApiBranchPolicySettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiBranchPolicySettingsResponse",
    STRICT_API_BODY_KEYS.ApiBranchPolicySettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.branch-policy.v0",
    "ApiBranchPolicySettingsResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiBranchPolicySettingsResponse.projectId");
  assertString(response.localeBranchId, "ApiBranchPolicySettingsResponse.localeBranchId");
  assertString(response.targetLocale, "ApiBranchPolicySettingsResponse.targetLocale");
  assertBranchPolicySourceRevision(
    response.sourceRevision,
    "ApiBranchPolicySettingsResponse.sourceRevision",
  );
  assertNullableBranchPolicyVersion(
    response.latestVersion,
    "ApiBranchPolicySettingsResponse.latestVersion",
  );
  assertNullableBranchPolicyVersion(
    response.approvedVersion,
    "ApiBranchPolicySettingsResponse.approvedVersion",
  );
  assertNullableBranchPolicyReference(
    response.branchReference,
    "ApiBranchPolicySettingsResponse.branchReference",
  );
  parseBranchPolicyPolicy(response.policy, "ApiBranchPolicySettingsResponse.policy");
}

export function assertTranslationScopeSettingsResponse(
  value: unknown,
): asserts value is ApiTranslationScopeSettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiTranslationScopeSettingsResponse",
    STRICT_API_BODY_KEYS.ApiTranslationScopeSettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.translation-scope.v0",
    "ApiTranslationScopeSettingsResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiTranslationScopeSettingsResponse.projectId");
  assertString(response.localeBranchId, "ApiTranslationScopeSettingsResponse.localeBranchId");
  assertEnum(
    response.scope,
    Object.values(translationScopeValues) as ApiTranslationScope[],
    "ApiTranslationScopeSettingsResponse.scope",
  );
  assertDateLike(response.updatedAt, "ApiTranslationScopeSettingsResponse.updatedAt");
}

export function assertLocalizationRunConfigResponse(
  value: unknown,
): asserts value is ApiLocalizationRunConfigResponse {
  const response = asStrictRecord(
    value,
    "ApiLocalizationRunConfigResponse",
    STRICT_API_BODY_KEYS.ApiLocalizationRunConfigResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.localization-run-config.v0",
    "ApiLocalizationRunConfigResponse.schemaVersion",
  );
  for (const field of [
    "projectId",
    "localeBranchId",
    "configPath",
    "dataRoot",
    "pairPolicyPath",
    "modelId",
    "providerId",
    "runDir",
  ] as const) {
    assertString(response[field], `ApiLocalizationRunConfigResponse.${field}`);
  }
  assertDateLike(response.updatedAt, "ApiLocalizationRunConfigResponse.updatedAt");
}

export function assertBranchPolicySourceRevision(value: unknown, label: string): void {
  const sourceRevision = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiBranchPolicySourceRevisionReference,
  );
  assertString(sourceRevision.sourceRevisionId, `${label}.sourceRevisionId`);
  assertString(sourceRevision.revisionKind, `${label}.revisionKind`);
  assertString(sourceRevision.value, `${label}.value`);
}

export function assertNullableBranchPolicyVersion(value: unknown, label: string): void {
  if (value === null) {
    return;
  }
  const version = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiBranchPolicyVersion);
  assertString(version.styleGuideVersionId, `${label}.styleGuideVersionId`);
  assertString(version.status, `${label}.status`);
  assertNonNegativeInteger(version.versionSequence, `${label}.versionSequence`);
  assertDateLike(version.createdAt, `${label}.createdAt`);
  assertDateLike(version.updatedAt, `${label}.updatedAt`);
  assertNullableString(version.approvedAt, `${label}.approvedAt`);
  if (version.approvedAt !== null) {
    assertDateLike(version.approvedAt, `${label}.approvedAt`);
  }
  parseBranchPolicyPolicy(version.policy, `${label}.policy`);
}

export function assertNullableBranchPolicyReference(value: unknown, label: string): void {
  if (value === null) {
    return;
  }
  const reference = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiBranchPolicyGlossaryReference,
  );
  assertString(reference.referenceId, `${label}.referenceId`);
  assertNonNegativeInteger(reference.versionSequence, `${label}.versionSequence`);
  assertNullableString(reference.styleGuideVersionId, `${label}.styleGuideVersionId`);
  assertString(reference.glossaryContentHash, `${label}.glossaryContentHash`);
  assertNonNegativeInteger(reference.glossaryTermCount, `${label}.glossaryTermCount`);
  assertString(reference.updateReason, `${label}.updateReason`);
  assertDateLike(reference.createdAt, `${label}.createdAt`);
}

export function parseBranchPolicyPolicy(value: unknown, label: string): ApiBranchPolicyPolicy {
  const policy = asStrictRecord(value, label, ["schemaVersion", "sections"]);
  assertLiteral(policy.schemaVersion, "style-guide-policy.v0", `${label}.schemaVersion`);
  return {
    schemaVersion: "style-guide-policy.v0",
    sections: parseBranchPolicySections(policy.sections, `${label}.sections`),
  };
}

export function parseBranchPolicySections(value: unknown, label: string): ApiBranchPolicySections {
  const sections = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiBranchPolicySections,
  );
  return {
    tone: parseBranchPolicyRules(sections.tone, `${label}.tone`),
    terminology: parseBranchPolicyRules(sections.terminology, `${label}.terminology`),
    honorifics: parseBranchPolicyRules(sections.honorifics, `${label}.honorifics`),
    formatting: parseBranchPolicyRules(sections.formatting, `${label}.formatting`),
    protectedSpans: parseBranchPolicyRules(sections.protectedSpans, `${label}.protectedSpans`),
  };
}

export function parseBranchPolicyRules(value: unknown, label: string): ApiBranchPolicyRule[] {
  return asArray(value, label).map((entry, index) => {
    const ruleLabel = `${label}[${index}]`;
    const rule = asStrictRecord(entry, ruleLabel, STRICT_API_BODY_KEYS.ApiBranchPolicyRule);
    assertString(rule.ruleId, `${ruleLabel}.ruleId`);
    assertString(rule.guidance, `${ruleLabel}.guidance`);
    return { ruleId: rule.ruleId, guidance: rule.guidance };
  });
}

export function assertModelRoutingProvider(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingProvider {
  const provider = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiModelRoutingProvider,
  );
  assertString(provider.providerId, `${label}.providerId`);
  assertString(provider.providerFamily, `${label}.providerFamily`);
  assertString(provider.endpointFamily, `${label}.endpointFamily`);
  assertString(provider.providerName, `${label}.providerName`);
  asRecord(provider.metadata, `${label}.metadata`);
}

export function assertModelRoutingModel(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingModel {
  const model = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiModelRoutingModel);
  assertString(model.modelRegistryId, `${label}.modelRegistryId`);
  assertString(model.providerId, `${label}.providerId`);
  assertString(model.modelId, `${label}.modelId`);
  asRecord(model.capabilities, `${label}.capabilities`);
  asRecord(model.pricing, `${label}.pricing`);
}

export function assertModelRoutingPromptPreset(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingPromptPreset {
  const preset = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiModelRoutingPromptPreset,
  );
  assertString(preset.promptPresetId, `${label}.promptPresetId`);
  assertString(preset.promptTemplateVersion, `${label}.promptTemplateVersion`);
  assertString(preset.presetSchemaVersion, `${label}.presetSchemaVersion`);
  assertString(preset.promptHash, `${label}.promptHash`);
  asRecord(preset.configSnapshot, `${label}.configSnapshot`);
}
