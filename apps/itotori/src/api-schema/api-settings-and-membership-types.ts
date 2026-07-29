import {
  ActorIdentityAccountRecord,
  ActorIdentityRecord,
  AuthBillingPeriod,
  AuthSessionAdminRecord,
  MemberInvitationRecord,
  MemberRecord,
  translationScopeValues,
} from "./dependencies.js";
import {
  ApiConfigureAuthSsoSettingsRequest,
  ApiModelRoutingModel,
  ApiModelRoutingProvider,
} from "./api-response-types.js";

export type ApiModelRoutingPromptPreset = {
  promptPresetId: string;
  promptTemplateVersion: string;
  presetSchemaVersion: string;
  promptHash: string;
  configSnapshot: Record<string, unknown>;
};

export type ApiModelRoutingRoute = {
  projectId: string;
  taskKind: string;
  providerId: string;
  modelId: string;
  modelRegistryId: string;
  fallbackModelIds: string[];
  promptPresetId: string;
  promptTemplateVersion: string;
  updatedAt: string;
};

export type ApiModelRoutingSettingsResponse = {
  schemaVersion: "itotori.settings.model-routing.v0";
  projectId: string;
  generatedAt: string;
  providers: ApiModelRoutingProvider[];
  models: ApiModelRoutingModel[];
  promptPresets: ApiModelRoutingPromptPreset[];
  routes: ApiModelRoutingRoute[];
};

export type ApiSaveModelRoutingSettingsRequest = {
  projectId: string;
  taskKind: string;
  providerId: string;
  modelId: string;
  fallbackModelIds: readonly string[];
  promptPresetId: string;
  promptTemplateVersion: string;
};

export type ApiBranchPolicyRule = {
  ruleId: string;
  guidance: string;
};

export type ApiBranchPolicySections = {
  tone: ApiBranchPolicyRule[];
  terminology: ApiBranchPolicyRule[];
  honorifics: ApiBranchPolicyRule[];
  formatting: ApiBranchPolicyRule[];
  protectedSpans: ApiBranchPolicyRule[];
};

export type ApiBranchPolicyPolicy = {
  schemaVersion: "style-guide-policy.v0";
  sections: ApiBranchPolicySections;
};

export type ApiBranchPolicySourceRevisionReference = {
  sourceRevisionId: string;
  revisionKind: string;
  value: string;
};

export type ApiBranchPolicyVersion = {
  styleGuideVersionId: string;
  status: string;
  versionSequence: number;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  policy: ApiBranchPolicyPolicy;
};

export type ApiBranchPolicyGlossaryReference = {
  referenceId: string;
  versionSequence: number;
  styleGuideVersionId: string | null;
  glossaryContentHash: string;
  glossaryTermCount: number;
  updateReason: string;
  createdAt: string;
};

export type ApiBranchPolicySettingsResponse = {
  schemaVersion: "itotori.settings.branch-policy.v0";
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceRevision: ApiBranchPolicySourceRevisionReference;
  latestVersion: ApiBranchPolicyVersion | null;
  approvedVersion: ApiBranchPolicyVersion | null;
  branchReference: ApiBranchPolicyGlossaryReference | null;
  policy: ApiBranchPolicyPolicy;
};

export type ApiSaveBranchPolicySettingsRequest = {
  projectId: string;
  localeBranchId: string;
  expectedPreviousVersionId: string | null;
  updateReason: string;
  policy: ApiBranchPolicyPolicy;
};

// itotori-translation-scope-settings — config-driven translation scope
// (dialogue / +choices / +UI-text / +images) the whole-project localize
// command reads. See `apps/itotori/src/cli/localize-command.ts`
// (`parseLocalizeRunRequest` -> `outputScope`) and
// `crates/kaifuu-reallive/src/scope.rs` for the tiers this mirrors.
export type ApiTranslationScope =
  (typeof translationScopeValues)[keyof typeof translationScopeValues];

export type ApiTranslationScopeSettingsResponse = {
  schemaVersion: "itotori.settings.translation-scope.v0";
  projectId: string;
  localeBranchId: string;
  scope: ApiTranslationScope;
  updatedAt: string;
};

export type ApiSaveTranslationScopeSettingsRequest = {
  projectId: string;
  localeBranchId: string;
  scope: ApiTranslationScope;
};

/** Operator-local whole-project inputs used by the Studio launch-pass driver. */
export type ApiLocalizationRunConfigResponse = {
  schemaVersion: "itotori.settings.localization-run-config.v0";
  projectId: string;
  localeBranchId: string;
  configPath: string;
  dataRoot: string;
  pairPolicyPath: string;
  modelId: string;
  providerId: string;
  runDir: string;
  updatedAt: string;
};

export type ApiSaveLocalizationRunConfigRequest = {
  projectId: string;
  localeBranchId: string;
  configPath: string;
  dataRoot: string;
  pairPolicyPath: string;
  modelId: string;
  providerId: string;
  runDir: string;
};

export type ApiConfigureAuthSsoSettingsResponse = ApiConfigureAuthSsoSettingsRequest & {
  schemaVersion: "itotori.auth.sso-settings.v0";
  updatedAt: string;
};

export type ApiInviteMemberRequest = {
  accountId: string;
  email: string;
  initialPermissionSetIds: readonly string[];
  expiresAt: string;
  reason: string | null;
  requestId: string | null;
};

export type ApiMemberInvitationResponse = Omit<
  MemberInvitationRecord,
  "expiresAt" | "acceptedAt" | "revokedAt" | "createdAt"
> & {
  schemaVersion: "itotori.auth.member-invitation.v0";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ApiExternalIdentityLinkRequest = {
  provider: string;
  subject: string;
};

export type ApiAcceptMemberInvitationRequest = {
  userId: string;
  principalId: string;
  displayName: string;
  email: string;
  externalIdentity: ApiExternalIdentityLinkRequest | null;
  reason: string | null;
  requestId: string | null;
};

export type ApiMemberRecord = Omit<MemberRecord, "createdAt"> & {
  createdAt: string;
};

export type ApiMemberResponse = {
  schemaVersion: "itotori.auth.member.v0";
  member: ApiMemberRecord;
};

export type ApiMembersListResponse = {
  schemaVersion: "itotori.auth.members.v0";
  accountId: string;
  members: ApiMemberRecord[];
};

export type ApiAuthBillingSeatUsageResponse = {
  schemaVersion: "itotori.auth.billing-seat-usage.v0";
  accountId: string;
  planId: string;
  planName: string;
  billingPeriod: AuthBillingPeriod;
  seatLimit: number;
  includedSeats: number;
  usedSeats: number;
  pendingInvitations: number;
  availableSeats: number;
  overSeatLimit: boolean;
  updatedAt: string;
};

export type ApiAuthSessionRecord = Omit<
  AuthSessionAdminRecord,
  "createdAt" | "expiresAt" | "revokedAt"
> & {
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type ApiAuthSessionsListResponse = {
  schemaVersion: "itotori.auth.sessions.v0";
  principalId: string;
  sessions: ApiAuthSessionRecord[];
};

export type ApiRevokeAuthSessionRequest = {
  reason: string | null;
  requestId: string | null;
};

export type ApiRevokeAuthSessionResponse = {
  schemaVersion: "itotori.auth.session-revoked.v0";
  revokedSession: ApiAuthSessionRecord;
};

export type ApiAuthIdentityAccount = Omit<ActorIdentityAccountRecord, "createdAt"> & {
  createdAt: string;
};

export type ApiAuthIdentityResponse = Omit<ActorIdentityRecord, "accounts"> & {
  schemaVersion: "itotori.auth.identity.v0";
  accounts: ApiAuthIdentityAccount[];
};

/**
 * fnd-caps-context — the actor's Studio capability permission VIEW on the
 * wire. Sourced server-side from exact permission grants (capabilities, NOT
 * roles) via `resolveStudioCapabilityPermissionView`. The SPA CapsProvider
 * consumes this shape to gate flag / steer / reveal actions.
 */
export type ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0";
  actorUserId: string;
  canFlag: boolean;
  canSteer: boolean;
  canReveal: boolean;
  denials: {
    flag: string | null;
    steer: string | null;
    reveal: string | null;
  };
  denialReasons: string[];
};

export type ApiRemoveMemberRequest = {
  reason: string | null;
  requestId: string | null;
};
