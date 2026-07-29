import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  defaultLocalAccountId,
  localOperatorPrincipalId,
  localUserId,
  permissionValues,
  requirePermission,
} from "../src/authorization.js";
import {
  ItotoriSamlLoginAdapter,
  samlExternalIdentityProviderKey,
} from "../src/repositories/saml-login-adapter.js";
import { ItotoriAuthSsoSettingsRepository } from "../src/repositories/auth-sso-settings-repository.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authExternalIdentities,
  authExternalIdentityProviderClaims,
  authSessions,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

import {
  configureMockSamlProvider,
  mockSamlResponse,
  testSamlCertificateFingerprint,
} from "./saml-login-adapter.test.shared-01.js";

describe("ItotoriSamlLoginAdapter", () => {
  it("authenticates through a mock SAML IdP, links an external identity, and opens a session", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const ssoSettings = new ItotoriAuthSsoSettingsRepository(context.db);
      await ssoSettings.configureSettings(
        { userId: localUserId },
        {
          accountId: defaultLocalAccountId,
          provider: {
            protocol: "saml",
            providerId: "saml-mock",
            displayName: "Mock SAML",
            enabled: true,
            ssoUrl: "https://idp.example.test/saml/sso",
            entityId: "https://idp.example.test/saml/metadata",
            certificateFingerprint: testSamlCertificateFingerprint(),
          },
          security: {
            requireSso: true,
            requireMfa: false,
            allowPasswordLogin: false,
          },
          sessionPolicy: {
            idleTimeoutMinutes: 30,
            absoluteTimeoutMinutes: 120,
          },
        },
      );
      const principals = new ItotoriPrincipalRepository(context.db);
      await principals.mapProviderClaimToDirectPermission(
        { userId: localUserId },
        {
          actorPrincipalId: localOperatorPrincipalId,
          provider: samlExternalIdentityProviderKey(defaultLocalAccountId, "saml-mock"),
          claimKind: "group",
          claimValue: "itotori-reviewers",
          permission: permissionValues.draftWrite,
          reason: "SAML mock group maps to reviewer draft write",
          requestId: "req-map-saml-group",
        },
      );

      const adapter = new ItotoriSamlLoginAdapter(context.db);
      const result = await adapter.loginWithHttpPost({
        accountId: defaultLocalAccountId,
        providerId: "saml-mock",
        samlResponse: mockSamlResponse({
          issuer: "https://idp.example.test/saml/metadata",
          subject: "saml-subject-123",
          email: "saml.member@example.test",
          displayName: "SAML Member",
          groups: ["itotori-reviewers"],
          requestId: "saml-request-123",
          spEntityId: "https://itotori.example.test/saml/sp",
          acsUrl: "https://itotori.example.test/api/auth/saml/acs",
          notBefore: "2099-01-01T09:55:00.000Z",
          notOnOrAfter: "2099-01-01T10:05:00.000Z",
        }),
        requestId: "saml-request-123",
        spEntityId: "https://itotori.example.test/saml/sp",
        acsUrl: "https://itotori.example.test/api/auth/saml/acs",
        relayState: "account=default",
        now: new Date("2099-01-01T10:00:00.000Z"),
        device: {
          userAgent: "vitest saml adapter",
          ipAddress: "203.0.113.43",
          deviceLabel: "Mock SAML browser",
        },
      });

      expect(result).toMatchObject({
        provider: "saml-mock",
        subject: "saml-subject-123",
        createdExternalIdentity: true,
        appliedMappedPermissions: [permissionValues.draftWrite],
      });
      expect(result.session.sessionId.length).toBeGreaterThanOrEqual(32);
      expect(result.session.expiresAt).toEqual(new Date("2099-01-01T12:00:00.000Z"));

      const identities = await context.db
        .select()
        .from(authExternalIdentities)
        .where(
          and(
            eq(
              authExternalIdentities.provider,
              samlExternalIdentityProviderKey(defaultLocalAccountId, "saml-mock"),
            ),
            eq(authExternalIdentities.subject, "saml-subject-123"),
          ),
        );
      expect(identities).toEqual([
        expect.objectContaining({
          externalIdentityId: result.externalIdentityId,
          userId: result.userId,
        }),
      ]);
      const memberships = await context.db
        .select()
        .from(authAccountMemberships)
        .where(eq(authAccountMemberships.userId, result.userId));
      expect(memberships).toEqual([
        expect.objectContaining({
          accountId: defaultLocalAccountId,
          userId: result.userId,
        }),
      ]);
      const claims = await context.db
        .select()
        .from(authExternalIdentityProviderClaims)
        .where(
          eq(authExternalIdentityProviderClaims.externalIdentityId, result.externalIdentityId),
        );
      expect(claims).toEqual([
        expect.objectContaining({
          claimKind: "group",
          claimValue: "itotori-reviewers",
        }),
      ]);
      const storedSessions = await context.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.sessionId, result.session.sessionId));
      expect(storedSessions).toEqual([
        expect.objectContaining({
          principalId: result.principalId,
          deviceLabel: "Mock SAML browser",
          userAgent: "vitest saml adapter",
          ipAddress: "203.0.113.43",
        }),
      ]);
      expect(JSON.stringify(storedSessions)).not.toContain("saml-subject-123");

      await expect(
        requirePermission(
          context.db,
          { userId: result.userId, sessionId: result.session.sessionId },
          permissionValues.draftWrite,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("rejects expired SAML assertions before linking identities or sessions", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const ssoSettings = new ItotoriAuthSsoSettingsRepository(context.db);
      await ssoSettings.configureSettings(
        { userId: localUserId },
        {
          accountId: defaultLocalAccountId,
          provider: {
            protocol: "saml",
            providerId: "saml-expired",
            displayName: "Expired SAML",
            enabled: true,
            ssoUrl: "https://idp.example.test/saml/sso",
            entityId: "https://idp.example.test/saml/metadata",
            certificateFingerprint: testSamlCertificateFingerprint(),
          },
          security: {
            requireSso: true,
            requireMfa: false,
            allowPasswordLogin: false,
          },
          sessionPolicy: {
            idleTimeoutMinutes: 30,
            absoluteTimeoutMinutes: 120,
          },
        },
      );
      const adapter = new ItotoriSamlLoginAdapter(context.db);

      await expect(
        adapter.loginWithHttpPost({
          accountId: defaultLocalAccountId,
          providerId: "saml-expired",
          samlResponse: mockSamlResponse({
            issuer: "https://idp.example.test/saml/metadata",
            subject: "expired-saml-subject",
            email: "expired.saml@example.test",
            displayName: "Expired SAML Member",
            groups: ["itotori-reviewers"],
            requestId: "saml-request-expired",
            spEntityId: "https://itotori.example.test/saml/sp",
            acsUrl: "https://itotori.example.test/api/auth/saml/acs",
            notBefore: "2099-01-01T09:00:00.000Z",
            notOnOrAfter: "2099-01-01T09:30:00.000Z",
          }),
          requestId: "saml-request-expired",
          spEntityId: "https://itotori.example.test/saml/sp",
          acsUrl: "https://itotori.example.test/api/auth/saml/acs",
          now: new Date("2099-01-01T10:00:00.000Z"),
        }),
      ).rejects.toThrow(/SAML assertion has expired/u);
      expect(
        await context.db
          .select()
          .from(authExternalIdentities)
          .where(eq(authExternalIdentities.subject, "expired-saml-subject")),
      ).toHaveLength(0);
      expect(await context.db.select().from(authExternalIdentityProviderClaims)).toHaveLength(0);
      expect(await context.db.select().from(authSessions)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("rejects unsigned SAML assertions before linking identities or sessions", async () => {
    const context = await isolatedMigratedContext();
    try {
      await configureMockSamlProvider(context.db, "saml-unsigned");
      const adapter = new ItotoriSamlLoginAdapter(context.db);

      await expect(
        adapter.loginWithHttpPost({
          accountId: defaultLocalAccountId,
          providerId: "saml-unsigned",
          samlResponse: mockSamlResponse({
            issuer: "https://idp.example.test/saml/metadata",
            subject: "unsigned-saml-subject",
            email: "unsigned.saml@example.test",
            displayName: "Unsigned SAML Member",
            groups: ["itotori-reviewers"],
            requestId: "saml-request-unsigned",
            spEntityId: "https://itotori.example.test/saml/sp",
            acsUrl: "https://itotori.example.test/api/auth/saml/acs",
            notBefore: "2099-01-01T09:55:00.000Z",
            notOnOrAfter: "2099-01-01T10:05:00.000Z",
            signed: false,
          }),
          requestId: "saml-request-unsigned",
          spEntityId: "https://itotori.example.test/saml/sp",
          acsUrl: "https://itotori.example.test/api/auth/saml/acs",
          now: new Date("2099-01-01T10:00:00.000Z"),
        }),
      ).rejects.toThrow(/signed assertion/u);
      expect(
        await context.db
          .select()
          .from(authExternalIdentities)
          .where(eq(authExternalIdentities.subject, "unsigned-saml-subject")),
      ).toHaveLength(0);
      expect(await context.db.select().from(authSessions)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("rejects SAML assertions for the wrong SP audience before linking identities or sessions", async () => {
    const context = await isolatedMigratedContext();
    try {
      await configureMockSamlProvider(context.db, "saml-wrong-audience");
      const adapter = new ItotoriSamlLoginAdapter(context.db);

      await expect(
        adapter.loginWithHttpPost({
          accountId: defaultLocalAccountId,
          providerId: "saml-wrong-audience",
          samlResponse: mockSamlResponse({
            issuer: "https://idp.example.test/saml/metadata",
            subject: "wrong-audience-saml-subject",
            email: "wrong.audience.saml@example.test",
            displayName: "Wrong Audience SAML Member",
            groups: ["itotori-reviewers"],
            requestId: "saml-request-wrong-audience",
            spEntityId: "https://evil.example.test/saml/sp",
            acsUrl: "https://itotori.example.test/api/auth/saml/acs",
            notBefore: "2099-01-01T09:55:00.000Z",
            notOnOrAfter: "2099-01-01T10:05:00.000Z",
          }),
          requestId: "saml-request-wrong-audience",
          spEntityId: "https://itotori.example.test/saml/sp",
          acsUrl: "https://itotori.example.test/api/auth/saml/acs",
          now: new Date("2099-01-01T10:00:00.000Z"),
        }),
      ).rejects.toThrow(/audience mismatch/u);
      expect(
        await context.db
          .select()
          .from(authExternalIdentities)
          .where(eq(authExternalIdentities.subject, "wrong-audience-saml-subject")),
      ).toHaveLength(0);
      expect(await context.db.select().from(authSessions)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
