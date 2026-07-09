import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  applyMappedProviderClaimGrants,
  type ExternalIdentityProviderClaim,
  type Permission,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authAccountMemberships,
  authAccounts,
  authAccountSecuritySettings,
  authAuditEventActionValues,
  authAuditEvents,
  authExternalIdentities,
  authPrincipals,
  authSsoProviderConfigs,
  authUsers,
} from "../schema.js";
import {
  type AuthSessionRecord,
  ItotoriAuthSessionService,
  type LoginProviderTokenBundle,
} from "./auth-session-service.js";

export type OidcAuthorizationCodeLoginInput = {
  accountId: string;
  providerId: string;
  authorizationCode: string;
  redirectUri: string;
  codeVerifier?: string;
  now?: Date;
  device?: {
    userAgent?: string;
    ipAddress?: string;
    deviceLabel?: string;
  };
};

export type OidcTokenExchangeInput = {
  issuer: string;
  clientId: string;
  authorizationCode: string;
  redirectUri: string;
  codeVerifier?: string;
};

export type OidcTokenExchangeResult = LoginProviderTokenBundle & {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  expiresInSeconds?: number;
};

export type OidcUserInfoInput = {
  issuer: string;
  accessToken: string;
};

export type OidcUserInfoResult = {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  providerClaims: ExternalIdentityProviderClaim[];
};

export interface OidcProtocolClient {
  exchangeAuthorizationCode(input: OidcTokenExchangeInput): Promise<OidcTokenExchangeResult>;
  loadUserInfo(input: OidcUserInfoInput): Promise<OidcUserInfoResult>;
}

export type OidcLoginResult = {
  provider: string;
  subject: string;
  userId: string;
  principalId: string;
  externalIdentityId: string;
  createdExternalIdentity: boolean;
  session: AuthSessionRecord;
  appliedMappedPermissions: Permission[];
};

export class ItotoriOidcLoginAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriOidcLoginAdapterError";
  }
}

export function oidcExternalIdentityProviderKey(accountId: string, providerId: string): string {
  assertNonEmpty(accountId, "accountId");
  assertNonEmpty(providerId, "providerId");
  return `oidc:${encodeURIComponent(accountId)}:${encodeURIComponent(providerId)}`;
}

type OidcProviderSettings = {
  accountId: string;
  providerId: string;
  issuer: string;
  clientId: string;
  sessionAbsoluteTimeoutMinutes: number;
};

type LinkedExternalIdentity = {
  externalIdentityId: string;
  userId: string;
  principalId: string;
  createdExternalIdentity: boolean;
};

type OidcTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export class ItotoriOidcLoginAdapter {
  private readonly sessions: ItotoriAuthSessionService;

  constructor(
    private readonly db: ItotoriDatabase,
    private readonly oidc: OidcProtocolClient = new HttpOidcProtocolClient(),
  ) {
    this.sessions = new ItotoriAuthSessionService(db);
  }

  async loginWithAuthorizationCode(
    input: OidcAuthorizationCodeLoginInput,
  ): Promise<OidcLoginResult> {
    const settings = await this.loadOidcProviderSettings(input.accountId, input.providerId);
    const tokens = await this.oidc.exchangeAuthorizationCode({
      issuer: settings.issuer,
      clientId: settings.clientId,
      authorizationCode: input.authorizationCode,
      redirectUri: input.redirectUri,
      ...(input.codeVerifier === undefined ? {} : { codeVerifier: input.codeVerifier }),
    });
    const userInfo = await this.oidc.loadUserInfo({
      issuer: settings.issuer,
      accessToken: tokens.accessToken,
    });
    const provider = settings.providerId;
    const linked = await this.linkOrCreateExternalIdentity({
      accountId: settings.accountId,
      provider,
      userInfo,
    });
    const appliedMappedPermissions = await applyMappedProviderClaimGrants(this.db, {
      externalIdentityId: linked.externalIdentityId,
      claims: userInfo.providerClaims,
    });
    const now = input.now ?? new Date();
    const session = await this.sessions.createLoginSession({
      principalId: linked.principalId,
      expiresAt: new Date(now.getTime() + settings.sessionAbsoluteTimeoutMinutes * 60 * 1000),
      now,
      ...(input.device === undefined ? {} : { device: input.device }),
      providerTokens: tokens,
    });
    return {
      provider,
      subject: userInfo.subject,
      userId: linked.userId,
      principalId: linked.principalId,
      externalIdentityId: linked.externalIdentityId,
      createdExternalIdentity: linked.createdExternalIdentity,
      session,
      appliedMappedPermissions,
    };
  }

  private async loadOidcProviderSettings(
    accountId: string,
    providerId: string,
  ): Promise<OidcProviderSettings> {
    assertNonEmpty(accountId, "accountId");
    assertNonEmpty(providerId, "providerId");
    const rows = await this.db
      .select({
        accountId: authSsoProviderConfigs.accountId,
        providerId: authSsoProviderConfigs.providerId,
        protocol: authSsoProviderConfigs.protocol,
        enabled: authSsoProviderConfigs.enabled,
        oidcIssuer: authSsoProviderConfigs.oidcIssuer,
        oidcClientId: authSsoProviderConfigs.oidcClientId,
        sessionAbsoluteTimeoutMinutes: authAccountSecuritySettings.sessionAbsoluteTimeoutMinutes,
        accountDisabledAt: authAccounts.disabledAt,
      })
      .from(authSsoProviderConfigs)
      .innerJoin(authAccounts, eq(authAccounts.accountId, authSsoProviderConfigs.accountId))
      .innerJoin(
        authAccountSecuritySettings,
        eq(authAccountSecuritySettings.accountId, authSsoProviderConfigs.accountId),
      )
      .where(
        and(
          eq(authSsoProviderConfigs.accountId, accountId),
          eq(authSsoProviderConfigs.providerId, providerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ItotoriOidcLoginAdapterError(
        `OIDC provider ${providerId} is not configured for account ${accountId}`,
      );
    }
    if (row.protocol !== "oidc") {
      throw new ItotoriOidcLoginAdapterError(`provider ${providerId} is not an OIDC provider`);
    }
    if (!row.enabled) {
      throw new ItotoriOidcLoginAdapterError(`OIDC provider ${providerId} is disabled`);
    }
    if (row.accountDisabledAt !== null) {
      throw new ItotoriOidcLoginAdapterError(`account ${accountId} is disabled`);
    }
    if (row.oidcIssuer === null || row.oidcClientId === null) {
      throw new ItotoriOidcLoginAdapterError(`OIDC provider ${providerId} is incomplete`);
    }
    return {
      accountId: row.accountId,
      providerId: row.providerId,
      issuer: row.oidcIssuer,
      clientId: row.oidcClientId,
      sessionAbsoluteTimeoutMinutes: row.sessionAbsoluteTimeoutMinutes,
    };
  }

  private async linkOrCreateExternalIdentity(input: {
    accountId: string;
    provider: string;
    userInfo: OidcUserInfoResult;
  }): Promise<LinkedExternalIdentity> {
    assertNonEmpty(input.userInfo.subject, "subject");
    const identityProvider = oidcExternalIdentityProviderKey(input.accountId, input.provider);
    const existing = await this.findExternalIdentity(identityProvider, input.userInfo.subject);
    if (existing !== undefined) {
      await this.requireActiveMembership(input.accountId, existing);
      return { ...existing, createdExternalIdentity: false };
    }

    return this.db.transaction(async (tx) => {
      const user = await findOrCreateUserForOidc(tx, input.userInfo);
      if (!user.createdUser && !(await hasActiveMembership(tx, input.accountId, user.userId))) {
        await assertPrincipalWasNotRemovedFromAccount(tx, input.accountId, user.principalId);
      }
      await tx
        .insert(authAccountMemberships)
        .values({
          membershipId: `membership-${randomUUID()}`,
          accountId: input.accountId,
          userId: user.userId,
        })
        .onConflictDoNothing();
      const externalIdentityId = `external-identity-${randomUUID()}`;
      await tx
        .insert(authExternalIdentities)
        .values({
          externalIdentityId,
          userId: user.userId,
          provider: identityProvider,
          subject: input.userInfo.subject,
        })
        .onConflictDoNothing();
      const linked = await findExternalIdentity(tx, identityProvider, input.userInfo.subject);
      if (linked === undefined) {
        throw new ItotoriOidcLoginAdapterError("failed to link OIDC external identity");
      }
      return { ...linked, createdExternalIdentity: true };
    });
  }

  private async findExternalIdentity(
    provider: string,
    subject: string,
  ): Promise<Omit<LinkedExternalIdentity, "createdExternalIdentity"> | undefined> {
    return findExternalIdentity(this.db, provider, subject);
  }

  private async requireActiveMembership(
    accountId: string,
    linked: Omit<LinkedExternalIdentity, "createdExternalIdentity">,
  ): Promise<void> {
    if (await hasActiveMembership(this.db, accountId, linked.userId)) {
      return;
    }
    await assertPrincipalWasNotRemovedFromAccount(this.db, accountId, linked.principalId);
    throw new ItotoriOidcLoginAdapterError(
      "OIDC identity is not an active account member; a new invitation is required",
    );
  }
}

export class HttpOidcProtocolClient implements OidcProtocolClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async exchangeAuthorizationCode(input: OidcTokenExchangeInput): Promise<OidcTokenExchangeResult> {
    const discovery = await this.discover(input.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.authorizationCode,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
    });
    if (input.codeVerifier !== undefined) {
      body.set("code_verifier", input.codeVerifier);
    }
    const response = await this.fetchImpl(discovery.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await parseJsonResponse(response, "OIDC token exchange failed");
    const accessToken = readRequiredString(json, "access_token");
    const tokenType = readOptionalString(json, "token_type");
    const idToken = readOptionalString(json, "id_token");
    const refreshToken = readOptionalString(json, "refresh_token");
    const scope = readOptionalString(json, "scope");
    const expiresInSeconds = readOptionalNumber(json, "expires_in");
    const result: OidcTokenExchangeResult = { accessToken };
    if (tokenType !== undefined) {
      result.tokenType = tokenType;
    }
    if (idToken !== undefined) {
      result.idToken = idToken;
    }
    if (refreshToken !== undefined) {
      result.refreshToken = refreshToken;
    }
    if (scope !== undefined) {
      result.scope = scope;
    }
    if (expiresInSeconds !== undefined) {
      result.expiresInSeconds = expiresInSeconds;
    }
    return result;
  }

  async loadUserInfo(input: OidcUserInfoInput): Promise<OidcUserInfoResult> {
    const discovery = await this.discover(input.issuer);
    const response = await this.fetchImpl(discovery.userInfoEndpoint, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
    const json = await parseJsonResponse(response, "OIDC userinfo request failed");
    const subject = readRequiredString(json, "sub");
    const email = readOptionalString(json, "email");
    const emailVerified = readOptionalBoolean(json, "email_verified");
    const result: OidcUserInfoResult = {
      subject,
      displayName: displayNameFromUserInfo(json, subject),
      providerClaims: providerClaimsFromUserInfo(json),
    };
    if (email !== undefined) {
      result.email = email;
    }
    if (emailVerified !== undefined) {
      result.emailVerified = emailVerified;
    }
    return result;
  }

  private async discover(issuer: string): Promise<{
    tokenEndpoint: string;
    userInfoEndpoint: string;
  }> {
    const discoveryUrl = new URL(`${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`);
    const response = await this.fetchImpl(discoveryUrl);
    const json = await parseJsonResponse(response, "OIDC discovery failed");
    const discoveredIssuer = readRequiredString(json, "issuer");
    if (discoveredIssuer !== issuer) {
      throw new ItotoriOidcLoginAdapterError(
        `OIDC discovery issuer mismatch: expected ${issuer}, got ${discoveredIssuer}`,
      );
    }
    return {
      tokenEndpoint: readRequiredString(json, "token_endpoint"),
      userInfoEndpoint: readRequiredString(json, "userinfo_endpoint"),
    };
  }
}

async function findExternalIdentity(
  db: ItotoriDatabase,
  provider: string,
  subject: string,
): Promise<Omit<LinkedExternalIdentity, "createdExternalIdentity"> | undefined> {
  const rows = await db
    .select({
      externalIdentityId: authExternalIdentities.externalIdentityId,
      userId: authExternalIdentities.userId,
      principalId: authUsers.principalId,
    })
    .from(authExternalIdentities)
    .innerJoin(authUsers, eq(authUsers.userId, authExternalIdentities.userId))
    .where(
      and(
        eq(authExternalIdentities.provider, provider),
        eq(authExternalIdentities.subject, subject),
      ),
    )
    .limit(1);
  return rows[0];
}

async function hasActiveMembership(
  db: ItotoriDatabase | OidcTransaction,
  accountId: string,
  userId: string,
): Promise<boolean> {
  const memberships = await db
    .select({ membershipId: authAccountMemberships.membershipId })
    .from(authAccountMemberships)
    .where(
      and(
        eq(authAccountMemberships.accountId, accountId),
        eq(authAccountMemberships.userId, userId),
      ),
    )
    .limit(1);
  return memberships[0] !== undefined;
}

async function findOrCreateUserForOidc(
  db: ItotoriDatabase | OidcTransaction,
  userInfo: OidcUserInfoResult,
): Promise<{ userId: string; principalId: string; createdUser: boolean }> {
  const normalizedEmail =
    userInfo.emailVerified === true && userInfo.email !== undefined
      ? userInfo.email.trim().toLowerCase()
      : null;
  if (normalizedEmail !== null && normalizedEmail.length > 0) {
    const existing = await db
      .select({ userId: authUsers.userId, principalId: authUsers.principalId })
      .from(authUsers)
      .where(eq(authUsers.email, normalizedEmail))
      .limit(1);
    if (existing[0] !== undefined) {
      return { ...existing[0], createdUser: false };
    }
  }

  const principalId = `principal-${randomUUID()}`;
  const userId = `user-${randomUUID()}`;
  await db.insert(authPrincipals).values({ principalId, principalKind: "human_user" });
  await db.insert(authUsers).values({
    userId,
    principalId,
    email: normalizedEmail === "" ? null : normalizedEmail,
    displayName: userInfo.displayName ?? normalizedEmail ?? userInfo.subject,
  });
  return { userId, principalId, createdUser: true };
}

async function assertPrincipalWasNotRemovedFromAccount(
  db: ItotoriDatabase | OidcTransaction,
  accountId: string,
  principalId: string,
): Promise<void> {
  const rows = await db
    .select({ authAuditEventId: authAuditEvents.authAuditEventId })
    .from(authAuditEvents)
    .where(
      and(
        eq(authAuditEvents.accountId, accountId),
        eq(authAuditEvents.targetPrincipalId, principalId),
        eq(authAuditEvents.action, authAuditEventActionValues.removed),
      ),
    )
    .limit(1);
  if (rows[0] !== undefined) {
    throw new ItotoriOidcLoginAdapterError(
      "OIDC login cannot restore a removed account membership; a new invitation is required",
    );
  }
}

async function parseJsonResponse(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ItotoriOidcLoginAdapterError(`${label}: HTTP ${response.status}`);
  }
  if (!isRecord(body)) {
    throw new ItotoriOidcLoginAdapterError(`${label}: response body is not a JSON object`);
  }
  return body;
}

function providerClaimsFromUserInfo(
  userInfo: Record<string, unknown>,
): ExternalIdentityProviderClaim[] {
  const claims: ExternalIdentityProviderClaim[] = [];
  appendClaimValues(claims, "group", userInfo.groups);
  appendClaimValues(claims, "role", userInfo.roles);
  const scope = readOptionalString(userInfo, "scope");
  if (scope !== undefined) {
    for (const value of scope.split(/\s+/u).filter((part) => part.length > 0)) {
      claims.push({ kind: "scope", value });
    }
  }
  return claims;
}

function appendClaimValues(
  claims: ExternalIdentityProviderClaim[],
  kind: ExternalIdentityProviderClaim["kind"],
  value: unknown,
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    claims.push({ kind, value: value.trim() });
    return;
  }
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      claims.push({ kind, value: item.trim() });
    }
  }
}

function displayNameFromUserInfo(userInfo: Record<string, unknown>, subject: string): string {
  return (
    readOptionalString(userInfo, "name") ??
    readOptionalString(userInfo, "preferred_username") ??
    readOptionalString(userInfo, "email") ??
    subject
  );
}

function readRequiredString(json: Record<string, unknown>, key: string): string {
  const value = readOptionalString(json, key);
  if (value === undefined) {
    throw new ItotoriOidcLoginAdapterError(`OIDC response missing string field ${key}`);
  }
  return value;
}

function readOptionalString(json: Record<string, unknown>, key: string): string | undefined {
  const value = json[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalBoolean(json: Record<string, unknown>, key: string): boolean | undefined {
  const value = json[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(json: Record<string, unknown>, key: string): number | undefined {
  const value = json[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ItotoriOidcLoginAdapterError(`${label} must be non-empty`);
  }
}
