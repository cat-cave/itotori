import { eq } from "drizzle-orm";
import {
  type AuthorizationActor,
  type Permission,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  type AuthSsoProviderProtocol,
  authAccountSecuritySettings,
  authSsoProviderConfigs,
} from "../schema.js";

export type AuthSsoProviderConfigInput =
  | {
      protocol: "oidc";
      providerId: string;
      displayName: string;
      enabled: boolean;
      issuer: string;
      clientId: string;
      scopes: readonly string[];
    }
  | {
      protocol: "saml";
      providerId: string;
      displayName: string;
      enabled: boolean;
      ssoUrl: string;
      entityId: string;
      certificateFingerprint?: string;
    };

export type AuthAccountSecuritySettingsInput = {
  requireSso: boolean;
  requireMfa: boolean;
  allowPasswordLogin: boolean;
};

export type AuthSessionPolicyInput = {
  idleTimeoutMinutes: number;
  absoluteTimeoutMinutes: number;
};

export type ConfigureAuthSsoSettingsInput = {
  accountId: string;
  provider: AuthSsoProviderConfigInput;
  security: AuthAccountSecuritySettingsInput;
  sessionPolicy: AuthSessionPolicyInput;
};

export type AuthSsoSettingsRecord = ConfigureAuthSsoSettingsInput & {
  updatedAt: Date;
};

export interface ItotoriAuthSsoSettingsRepositoryPort {
  configureSettings(
    actor: AuthorizationActor,
    input: ConfigureAuthSsoSettingsInput,
  ): Promise<AuthSsoSettingsRecord>;
}

export class ItotoriAuthSsoSettingsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriAuthSsoSettingsRepositoryError";
  }
}

export class ItotoriAuthSsoSettingsRepository implements ItotoriAuthSsoSettingsRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async configureSettings(
    actor: AuthorizationActor,
    input: ConfigureAuthSsoSettingsInput,
  ): Promise<AuthSsoSettingsRecord> {
    await requirePermission(this.db, actor, permissionValues.authSsoManage);
    validateInput(input);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(authSsoProviderConfigs)
        .values(providerInsertValues(input, now))
        .onConflictDoUpdate({
          target: [authSsoProviderConfigs.accountId, authSsoProviderConfigs.providerId],
          set: providerUpdateValues(input, now),
        });
      await tx
        .insert(authAccountSecuritySettings)
        .values({
          accountId: input.accountId,
          requireSso: input.security.requireSso,
          requireMfa: input.security.requireMfa,
          allowPasswordLogin: input.security.allowPasswordLogin,
          sessionIdleTimeoutMinutes: input.sessionPolicy.idleTimeoutMinutes,
          sessionAbsoluteTimeoutMinutes: input.sessionPolicy.absoluteTimeoutMinutes,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: authAccountSecuritySettings.accountId,
          set: {
            requireSso: input.security.requireSso,
            requireMfa: input.security.requireMfa,
            allowPasswordLogin: input.security.allowPasswordLogin,
            sessionIdleTimeoutMinutes: input.sessionPolicy.idleTimeoutMinutes,
            sessionAbsoluteTimeoutMinutes: input.sessionPolicy.absoluteTimeoutMinutes,
            updatedAt: now,
          },
        });
    });
    return this.loadConfiguredSettings(input.accountId, input.provider.providerId);
  }

  private async loadConfiguredSettings(
    accountId: string,
    providerId: string,
  ): Promise<AuthSsoSettingsRecord> {
    const provider = (
      await this.db
        .select()
        .from(authSsoProviderConfigs)
        .where(eq(authSsoProviderConfigs.accountId, accountId))
    ).find((row) => row.providerId === providerId);
    const security = (
      await this.db
        .select()
        .from(authAccountSecuritySettings)
        .where(eq(authAccountSecuritySettings.accountId, accountId))
        .limit(1)
    )[0];
    if (provider === undefined || security === undefined) {
      throw new ItotoriAuthSsoSettingsRepositoryError("configured SSO settings were not found");
    }
    return {
      accountId,
      provider: providerRecord(provider),
      security: {
        requireSso: security.requireSso,
        requireMfa: security.requireMfa,
        allowPasswordLogin: security.allowPasswordLogin,
      },
      sessionPolicy: {
        idleTimeoutMinutes: security.sessionIdleTimeoutMinutes,
        absoluteTimeoutMinutes: security.sessionAbsoluteTimeoutMinutes,
      },
      updatedAt: security.updatedAt,
    };
  }
}

function providerInsertValues(input: ConfigureAuthSsoSettingsInput, now: Date) {
  const base = {
    accountId: input.accountId,
    providerId: input.provider.providerId,
    protocol: input.provider.protocol,
    displayName: input.provider.displayName,
    enabled: input.provider.enabled,
    oidcIssuer: null,
    oidcClientId: null,
    oidcScopes: [],
    samlSsoUrl: null,
    samlEntityId: null,
    samlCertificateFingerprint: null,
    updatedAt: now,
  };
  if (input.provider.protocol === "oidc") {
    return {
      ...base,
      oidcIssuer: input.provider.issuer,
      oidcClientId: input.provider.clientId,
      oidcScopes: [...input.provider.scopes],
    };
  }
  return {
    ...base,
    samlSsoUrl: input.provider.ssoUrl,
    samlEntityId: input.provider.entityId,
    samlCertificateFingerprint: input.provider.certificateFingerprint ?? null,
  };
}

function providerUpdateValues(input: ConfigureAuthSsoSettingsInput, now: Date) {
  const values = providerInsertValues(input, now);
  return {
    protocol: values.protocol,
    displayName: values.displayName,
    enabled: values.enabled,
    oidcIssuer: values.oidcIssuer,
    oidcClientId: values.oidcClientId,
    oidcScopes: values.oidcScopes,
    samlSsoUrl: values.samlSsoUrl,
    samlEntityId: values.samlEntityId,
    samlCertificateFingerprint: values.samlCertificateFingerprint,
    updatedAt: now,
  };
}

function providerRecord(row: {
  protocol: AuthSsoProviderProtocol;
  providerId: string;
  displayName: string;
  enabled: boolean;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcScopes: string[];
  samlSsoUrl: string | null;
  samlEntityId: string | null;
  samlCertificateFingerprint: string | null;
}): AuthSsoProviderConfigInput {
  if (row.protocol === "oidc") {
    return {
      protocol: "oidc",
      providerId: row.providerId,
      displayName: row.displayName,
      enabled: row.enabled,
      issuer: row.oidcIssuer ?? "",
      clientId: row.oidcClientId ?? "",
      scopes: row.oidcScopes,
    };
  }
  return {
    protocol: "saml",
    providerId: row.providerId,
    displayName: row.displayName,
    enabled: row.enabled,
    ssoUrl: row.samlSsoUrl ?? "",
    entityId: row.samlEntityId ?? "",
    ...(row.samlCertificateFingerprint === null
      ? {}
      : { certificateFingerprint: row.samlCertificateFingerprint }),
  };
}

function validateInput(input: ConfigureAuthSsoSettingsInput): void {
  assertNonEmpty(input.accountId, "accountId");
  assertNonEmpty(input.provider.providerId, "provider.providerId");
  assertNonEmpty(input.provider.displayName, "provider.displayName");
  if (input.provider.protocol === "oidc") {
    assertNonEmpty(input.provider.issuer, "provider.issuer");
    assertNonEmpty(input.provider.clientId, "provider.clientId");
    for (const [index, scope] of input.provider.scopes.entries()) {
      assertNonEmpty(scope, `provider.scopes[${index}]`);
    }
  } else {
    assertNonEmpty(input.provider.ssoUrl, "provider.ssoUrl");
    assertNonEmpty(input.provider.entityId, "provider.entityId");
    if (input.provider.certificateFingerprint !== undefined) {
      assertNonEmpty(input.provider.certificateFingerprint, "provider.certificateFingerprint");
    }
  }
  assertPositiveInteger(input.sessionPolicy.idleTimeoutMinutes, "sessionPolicy.idleTimeoutMinutes");
  assertPositiveInteger(
    input.sessionPolicy.absoluteTimeoutMinutes,
    "sessionPolicy.absoluteTimeoutMinutes",
  );
  if (input.sessionPolicy.absoluteTimeoutMinutes < input.sessionPolicy.idleTimeoutMinutes) {
    throw new ItotoriAuthSsoSettingsRepositoryError(
      "sessionPolicy.absoluteTimeoutMinutes must be greater than or equal to idleTimeoutMinutes",
    );
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ItotoriAuthSsoSettingsRepositoryError(`${label} must be non-empty`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ItotoriAuthSsoSettingsRepositoryError(`${label} must be a positive integer`);
  }
}

export const authSsoManagePermission = permissionValues.authSsoManage satisfies Permission;
