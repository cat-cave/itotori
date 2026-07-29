import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { applyMappedProviderClaimGrants } from "../authorization.js";
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
import { ItotoriAuthSessionService } from "./auth-session-service.js";
import {
  assertNonEmpty,
  ItotoriSamlLoginAdapterError,
  samlExternalIdentityProviderKey,
  type SamlAssertionResult,
  type SamlHttpPostLoginInput,
  type SamlLoginResult,
  type SamlProtocolClient,
} from "./saml-login-adapter-contracts.js";
import { HttpPostSamlProtocolClient } from "./saml-login-adapter-protocol.js";

type SamlProviderSettings = {
  accountId: string;
  providerId: string;
  ssoUrl: string;
  entityId: string;
  certificateFingerprint: string | null;
  sessionAbsoluteTimeoutMinutes: number;
};

type LinkedExternalIdentity = {
  externalIdentityId: string;
  userId: string;
  principalId: string;
  createdExternalIdentity: boolean;
};

type SamlTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export class ItotoriSamlLoginAdapter {
  private readonly sessions: ItotoriAuthSessionService;

  constructor(
    private readonly db: ItotoriDatabase,
    private readonly saml: SamlProtocolClient = new HttpPostSamlProtocolClient(),
  ) {
    this.sessions = new ItotoriAuthSessionService(db);
  }

  async loginWithHttpPost(input: SamlHttpPostLoginInput): Promise<SamlLoginResult> {
    const settings = await this.loadSamlProviderSettings(input.accountId, input.providerId);
    const assertion = await this.saml.validateLoginResponse({
      idpEntityId: settings.entityId,
      ssoUrl: settings.ssoUrl,
      samlResponse: input.samlResponse,
      requestId: input.requestId,
      spEntityId: input.spEntityId,
      acsUrl: input.acsUrl,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(settings.certificateFingerprint === null
        ? {}
        : { certificateFingerprint: settings.certificateFingerprint }),
      ...(input.relayState === undefined ? {} : { relayState: input.relayState }),
    });
    const provider = settings.providerId;
    const linked = await this.linkOrCreateExternalIdentity({
      accountId: settings.accountId,
      provider,
      assertion,
    });
    const appliedMappedPermissions = await applyMappedProviderClaimGrants(this.db, {
      externalIdentityId: linked.externalIdentityId,
      claims: assertion.providerClaims,
    });
    const now = input.now ?? new Date();
    const session = await this.sessions.createLoginSession({
      principalId: linked.principalId,
      expiresAt: new Date(now.getTime() + settings.sessionAbsoluteTimeoutMinutes * 60 * 1000),
      now,
      ...(input.device === undefined ? {} : { device: input.device }),
    });
    return {
      provider,
      subject: assertion.subject,
      userId: linked.userId,
      principalId: linked.principalId,
      externalIdentityId: linked.externalIdentityId,
      createdExternalIdentity: linked.createdExternalIdentity,
      session,
      appliedMappedPermissions,
    };
  }

  private async loadSamlProviderSettings(
    accountId: string,
    providerId: string,
  ): Promise<SamlProviderSettings> {
    assertNonEmpty(accountId, "accountId");
    assertNonEmpty(providerId, "providerId");
    const rows = await this.db
      .select({
        accountId: authSsoProviderConfigs.accountId,
        providerId: authSsoProviderConfigs.providerId,
        protocol: authSsoProviderConfigs.protocol,
        enabled: authSsoProviderConfigs.enabled,
        samlSsoUrl: authSsoProviderConfigs.samlSsoUrl,
        samlEntityId: authSsoProviderConfigs.samlEntityId,
        samlCertificateFingerprint: authSsoProviderConfigs.samlCertificateFingerprint,
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
      throw new ItotoriSamlLoginAdapterError(
        `SAML provider ${providerId} is not configured for account ${accountId}`,
      );
    }
    if (row.protocol !== "saml") {
      throw new ItotoriSamlLoginAdapterError(`provider ${providerId} is not a SAML provider`);
    }
    if (!row.enabled) {
      throw new ItotoriSamlLoginAdapterError(`SAML provider ${providerId} is disabled`);
    }
    if (row.accountDisabledAt !== null) {
      throw new ItotoriSamlLoginAdapterError(`account ${accountId} is disabled`);
    }
    if (row.samlSsoUrl === null || row.samlEntityId === null) {
      throw new ItotoriSamlLoginAdapterError(`SAML provider ${providerId} is incomplete`);
    }
    return {
      accountId: row.accountId,
      providerId: row.providerId,
      ssoUrl: row.samlSsoUrl,
      entityId: row.samlEntityId,
      certificateFingerprint: row.samlCertificateFingerprint,
      sessionAbsoluteTimeoutMinutes: row.sessionAbsoluteTimeoutMinutes,
    };
  }

  private async linkOrCreateExternalIdentity(input: {
    accountId: string;
    provider: string;
    assertion: SamlAssertionResult;
  }): Promise<LinkedExternalIdentity> {
    assertNonEmpty(input.assertion.subject, "subject");
    const identityProvider = samlExternalIdentityProviderKey(input.accountId, input.provider);
    const existing = await this.findExternalIdentity(identityProvider, input.assertion.subject);
    if (existing !== undefined) {
      await this.requireActiveMembership(input.accountId, existing);
      return { ...existing, createdExternalIdentity: false };
    }

    return this.db.transaction(async (tx) => {
      const user = await findOrCreateUserForSaml(tx, input.assertion);
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
          subject: input.assertion.subject,
        })
        .onConflictDoNothing();
      const linked = await findExternalIdentity(tx, identityProvider, input.assertion.subject);
      if (linked === undefined) {
        throw new ItotoriSamlLoginAdapterError("failed to link SAML external identity");
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
    throw new ItotoriSamlLoginAdapterError(
      "SAML identity is not an active account member; a new invitation is required",
    );
  }
}

async function findExternalIdentity(
  db: ItotoriDatabase | SamlTransaction,
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
  db: ItotoriDatabase | SamlTransaction,
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

async function findOrCreateUserForSaml(
  db: ItotoriDatabase | SamlTransaction,
  assertion: SamlAssertionResult,
): Promise<{ userId: string; principalId: string; createdUser: boolean }> {
  const normalizedEmail =
    assertion.emailVerified === true && assertion.email !== undefined
      ? assertion.email.trim().toLowerCase()
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
    displayName: assertion.displayName ?? normalizedEmail ?? assertion.subject,
  });
  return { userId, principalId, createdUser: true };
}

async function assertPrincipalWasNotRemovedFromAccount(
  db: ItotoriDatabase | SamlTransaction,
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
    throw new ItotoriSamlLoginAdapterError(
      "SAML login cannot restore a removed account membership; a new invitation is required",
    );
  }
}
