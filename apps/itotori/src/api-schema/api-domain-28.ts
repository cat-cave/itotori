import {
  BRIDGE_SCHEMA_VERSION_V02,
  BridgeBundle,
  BridgeBundleV02,
  FindingRecordV02,
  PatchExport,
  PatchExportV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertFindingRecordFixtureV02,
  assertPatchExport,
  assertPatchExportV02,
} from "./dependencies.js";
import {
  ApiAccountSecuritySettings,
  ApiAuthSessionPolicy,
  ApiAuthSsoProviderConfig,
} from "./api-domain-03.js";
import { ApiExternalIdentityLinkRequest } from "./api-domain-04.js";
import { ApiValidationError } from "./api-domain-07.js";
import { apiPatchIterationFeedbackEventKinds } from "./api-domain-24.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertNullableString,
  assertPositiveInteger,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export function assertPatchIterationFeedbackBatch(
  value: unknown,
  label: string,
  withEvents: boolean,
): void {
  const fields = [
    "feedbackBatchId",
    "observedPatchVersionId",
    "actorUserId",
    "selectionKind",
    "label",
    "createdAt",
    "updatedAt",
    ...(withEvents ? ["events"] : []),
  ];
  const batch = asStrictRecord(value, label, fields);
  assertString(batch.feedbackBatchId, `${label}.feedbackBatchId`);
  assertString(batch.observedPatchVersionId, `${label}.observedPatchVersionId`);
  assertString(batch.actorUserId, `${label}.actorUserId`);
  assertEnum(batch.selectionKind, ["individual", "batch"] as const, `${label}.selectionKind`);
  assertNullableString(batch.label, `${label}.label`);
  assertDateLike(batch.createdAt, `${label}.createdAt`);
  assertDateLike(batch.updatedAt, `${label}.updatedAt`);
  if (withEvents) {
    const events = asArray(batch.events, `${label}.events`);
    for (const [index, event] of events.entries()) {
      assertPatchIterationFeedbackEvent(event, `${label}.events[${index}]`);
    }
  }
}

export function assertPatchIterationFeedbackEvent(value: unknown, label: string): void {
  const event = asStrictRecord(value, label, [
    "feedbackEventId",
    "feedbackBatchId",
    "observedPatchVersionId",
    "playSessionId",
    "actorUserId",
    "eventKind",
    "body",
    "metadata",
    "resultRevisionId",
    "contextArtifactId",
    "contextEntryVersionId",
    "affectedBridgeUnitIds",
    "createdAt",
  ]);
  assertString(event.feedbackEventId, `${label}.feedbackEventId`);
  assertString(event.feedbackBatchId, `${label}.feedbackBatchId`);
  assertString(event.observedPatchVersionId, `${label}.observedPatchVersionId`);
  assertNullableString(event.playSessionId, `${label}.playSessionId`);
  assertString(event.actorUserId, `${label}.actorUserId`);
  assertEnum(event.eventKind, apiPatchIterationFeedbackEventKinds, `${label}.eventKind`);
  assertNullableString(event.body, `${label}.body`);
  asRecord(event.metadata, `${label}.metadata`);
  assertNullableString(event.resultRevisionId, `${label}.resultRevisionId`);
  assertNullableString(event.contextArtifactId, `${label}.contextArtifactId`);
  assertNullableString(event.contextEntryVersionId, `${label}.contextEntryVersionId`);
  assertStringArray(event.affectedBridgeUnitIds, `${label}.affectedBridgeUnitIds`);
  assertDateLike(event.createdAt, `${label}.createdAt`);
}

export function assertPatchIterationRefinement(value: unknown, label: string): void {
  const refinement = asStrictRecord(value, label, [
    "runId",
    "basePatchVersionId",
    "feedbackBatchIds",
    "wikiHeads",
    "members",
  ]);
  assertString(refinement.runId, `${label}.runId`);
  assertString(refinement.basePatchVersionId, `${label}.basePatchVersionId`);
  assertStringArray(refinement.feedbackBatchIds, `${label}.feedbackBatchIds`);
  const wikiHeads = asArray(refinement.wikiHeads, `${label}.wikiHeads`);
  for (const [index, headValue] of wikiHeads.entries()) {
    const head = asStrictRecord(headValue, `${label}.wikiHeads[${index}]`, [
      "contextArtifactId",
      "contextEntryVersionId",
    ]);
    assertString(head.contextArtifactId, `${label}.wikiHeads[${index}].contextArtifactId`);
    assertString(head.contextEntryVersionId, `${label}.wikiHeads[${index}].contextEntryVersionId`);
  }
  const members = asArray(refinement.members, `${label}.members`);
  for (const [index, memberValue] of members.entries()) {
    const member = asStrictRecord(memberValue, `${label}.members[${index}]`, [
      "bridgeUnitId",
      "strategy",
      "basePatchVersionId",
      "baseSourceRunId",
      "baseJournalOutcomeId",
      "baseResultRevisionId",
    ]);
    assertString(member.bridgeUnitId, `${label}.members[${index}].bridgeUnitId`);
    assertEnum(
      member.strategy,
      ["reuse", "redraft", "new_scope"] as const,
      `${label}.members[${index}].strategy`,
    );
    assertNullableString(
      member.basePatchVersionId,
      `${label}.members[${index}].basePatchVersionId`,
    );
    assertNullableString(member.baseSourceRunId, `${label}.members[${index}].baseSourceRunId`);
    assertNullableString(
      member.baseJournalOutcomeId,
      `${label}.members[${index}].baseJournalOutcomeId`,
    );
    assertNullableString(
      member.baseResultRevisionId,
      `${label}.members[${index}].baseResultRevisionId`,
    );
  }
}

export function assertPatchIterationOrigin(value: unknown, label: string): void {
  assertEnum(value, ["run_finalizer", "play_tester_edit", "refinement_run"] as const, label);
}

export function assertStringRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, string> {
  const record = asRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    assertString(entry, `${label}.${key}`);
  }
}

export function parseAuthSsoProviderConfig(
  value: unknown,
  label: string,
): ApiAuthSsoProviderConfig {
  const base = asRecord(value, label);
  assertEnum(base.protocol, ["oidc", "saml"] as const, `${label}.protocol`);
  const allowedKeys =
    base.protocol === "oidc"
      ? ["protocol", "providerId", "displayName", "enabled", "issuer", "clientId", "scopes"]
      : [
          "protocol",
          "providerId",
          "displayName",
          "enabled",
          "ssoUrl",
          "entityId",
          "certificateFingerprint",
        ];
  const provider = asStrictRecord(value, label, allowedKeys);
  assertString(provider.providerId, `${label}.providerId`);
  assertString(provider.displayName, `${label}.displayName`);
  assertBoolean(provider.enabled, `${label}.enabled`);
  if (provider.protocol === "oidc") {
    assertString(provider.issuer, `${label}.issuer`);
    assertString(provider.clientId, `${label}.clientId`);
    assertStringArray(provider.scopes, `${label}.scopes`);
    return {
      protocol: "oidc",
      providerId: provider.providerId,
      displayName: provider.displayName,
      enabled: provider.enabled,
      issuer: provider.issuer,
      clientId: provider.clientId,
      scopes: provider.scopes as string[],
    };
  }
  assertString(provider.ssoUrl, `${label}.ssoUrl`);
  assertString(provider.entityId, `${label}.entityId`);
  const samlProvider: ApiAuthSsoProviderConfig = {
    protocol: "saml",
    providerId: provider.providerId,
    displayName: provider.displayName,
    enabled: provider.enabled,
    ssoUrl: provider.ssoUrl,
    entityId: provider.entityId,
  };
  if (provider.certificateFingerprint !== undefined) {
    assertString(provider.certificateFingerprint, `${label}.certificateFingerprint`);
    samlProvider.certificateFingerprint = provider.certificateFingerprint;
  }
  return samlProvider;
}

export function parseNullableExternalIdentityLink(
  value: unknown,
  label: string,
): ApiExternalIdentityLinkRequest | null {
  if (value === null) {
    return null;
  }
  const link = asStrictRecord(value, label, ["provider", "subject"]);
  assertString(link.provider, `${label}.provider`);
  assertString(link.subject, `${label}.subject`);
  return { provider: link.provider, subject: link.subject };
}

export function parseAccountSecuritySettings(
  value: unknown,
  label: string,
): ApiAccountSecuritySettings {
  const settings = asStrictRecord(value, label, ["requireSso", "requireMfa", "allowPasswordLogin"]);
  assertBoolean(settings.requireSso, `${label}.requireSso`);
  assertBoolean(settings.requireMfa, `${label}.requireMfa`);
  assertBoolean(settings.allowPasswordLogin, `${label}.allowPasswordLogin`);
  return {
    requireSso: settings.requireSso,
    requireMfa: settings.requireMfa,
    allowPasswordLogin: settings.allowPasswordLogin,
  };
}

export function parseAuthSessionPolicy(value: unknown, label: string): ApiAuthSessionPolicy {
  const policy = asStrictRecord(value, label, ["idleTimeoutMinutes", "absoluteTimeoutMinutes"]);
  assertPositiveInteger(policy.idleTimeoutMinutes, `${label}.idleTimeoutMinutes`);
  assertPositiveInteger(policy.absoluteTimeoutMinutes, `${label}.absoluteTimeoutMinutes`);
  if (policy.absoluteTimeoutMinutes < policy.idleTimeoutMinutes) {
    throw new ApiValidationError(
      `${label}.absoluteTimeoutMinutes must be greater than or equal to idleTimeoutMinutes`,
    );
  }
  return {
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
  };
}

export function assertBridgeInput(value: unknown): asserts value is BridgeBundle | BridgeBundleV02 {
  const bridge = asRecord(value, "BridgeInput");
  if (bridge.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertBridgeBundleV02(value);
    return;
  }
  assertBridgeBundle(value);
}

export function assertPatchExportInput(
  value: unknown,
  label: string,
): asserts value is PatchExport | PatchExportV02 {
  const patch = asRecord(value, label);
  if (patch.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertPatchExportV02(value);
    return;
  }
  assertPatchExport(value);
}

export function assertFindingRecordInput(
  value: unknown,
  label: string,
): asserts value is FindingRecordV02 {
  assertFindingRecordFixtureV02({
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    findingFixtureId: "019ed004-0000-7000-8000-000000000004",
    finding: value,
    compatibilityNotes: [],
  });
  const finding = asRecord(value, label);
  if (finding.findingId === undefined) {
    throw new Error(`${label}.findingId is required`);
  }
}

export function parseRequest<T>(label: string, parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiValidationError(`${label}: ${message}`);
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
