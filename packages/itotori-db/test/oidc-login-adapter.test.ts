import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  defaultLocalAccountId,
  localOperatorPrincipalId,
  localUserId,
  permissionValues,
  requirePermission,
  type AuthorizationActor,
} from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriOidcLoginAdapter,
  oidcExternalIdentityProviderKey,
  type OidcProtocolClient,
  type OidcUserInfoResult,
} from "../src/repositories/oidc-login-adapter.js";
import { ItotoriAuthMemberManagementRepository } from "../src/repositories/auth-member-management-repository.js";
import { ItotoriAuthSsoSettingsRepository } from "../src/repositories/auth-sso-settings-repository.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authAccounts,
  authExternalIdentities,
  authExternalIdentityProviderClaims,
  authSessions,
  authUsers,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const servers: MockOidcServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ItotoriOidcLoginAdapter", () => {
  it("authenticates through a mock OIDC IdP, links an external identity, and opens a session", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const mockIdp = await startMockOidcServer({
        authorizationCode: "mock-auth-code",
        accessToken: "mock-access-token",
        subject: "oidc-subject-123",
        email: "oidc.member@example.test",
        name: "OIDC Member",
        groups: ["itotori-reviewers"],
      });
      servers.push(mockIdp);
      const ssoSettings = new ItotoriAuthSsoSettingsRepository(context.db);
      await ssoSettings.configureSettings(
        { userId: localUserId },
        {
          accountId: defaultLocalAccountId,
          provider: {
            protocol: "oidc",
            providerId: "oidc-mock",
            displayName: "Mock OIDC",
            enabled: true,
            issuer: mockIdp.issuer,
            clientId: "itotori-test-client",
            scopes: ["openid", "email", "profile"],
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
          provider: oidcExternalIdentityProviderKey(defaultLocalAccountId, "oidc-mock"),
          claimKind: "group",
          claimValue: "itotori-reviewers",
          permission: permissionValues.draftWrite,
          reason: "OIDC mock group maps to reviewer draft write",
          requestId: "req-map-oidc-group",
        },
      );

      const adapter = new ItotoriOidcLoginAdapter(context.db);
      const result = await adapter.loginWithAuthorizationCode({
        accountId: defaultLocalAccountId,
        providerId: "oidc-mock",
        authorizationCode: "mock-auth-code",
        redirectUri: "https://itotori.example.test/auth/callback",
        codeVerifier: "mock-pkce-verifier",
        now: new Date("2099-01-01T10:00:00.000Z"),
        device: {
          userAgent: "vitest oidc adapter",
          ipAddress: "203.0.113.42",
          deviceLabel: "Mock browser",
        },
      });

      expect(mockIdp.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            path: "/.well-known/openid-configuration",
          }),
          expect.objectContaining({
            method: "POST",
            path: "/token",
            body: expect.stringContaining("grant_type=authorization_code"),
          }),
          expect.objectContaining({
            method: "GET",
            path: "/userinfo",
            authorization: "Bearer mock-access-token",
          }),
        ]),
      );
      expect(result).toMatchObject({
        provider: "oidc-mock",
        subject: "oidc-subject-123",
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
              oidcExternalIdentityProviderKey(defaultLocalAccountId, "oidc-mock"),
            ),
            eq(authExternalIdentities.subject, "oidc-subject-123"),
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
          deviceLabel: "Mock browser",
          userAgent: "vitest oidc adapter",
          ipAddress: "203.0.113.42",
        }),
      ]);
      expect(JSON.stringify(storedSessions)).not.toContain("mock-access-token");

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

  it("namespaces external identity lookup by account-qualified OIDC provider", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const principals = new ItotoriPrincipalRepository(context.db);
      await principals.createAccount(
        { userId: localUserId },
        {
          accountId: "account-a",
          slug: "tenant-a",
          name: "Tenant A",
        },
      );
      await principals.createAccount(
        { userId: localUserId },
        {
          accountId: "account-b",
          slug: "tenant-b",
          name: "Tenant B",
        },
      );
      await configureOidcProvider(context.db, { userId: localUserId }, "account-a", {
        providerId: "shared-oidc",
        issuer: "https://idp-a.example.test",
      });
      await configureOidcProvider(context.db, { userId: localUserId }, "account-b", {
        providerId: "shared-oidc",
        issuer: "https://idp-b.example.test",
      });
      const adapter = new ItotoriOidcLoginAdapter(
        context.db,
        new StaticOidcClient({
          subject: "same-upstream-subject",
          email: "unverified-collision@example.test",
          emailVerified: false,
          displayName: "Unverified Subject",
          providerClaims: [],
        }),
      );

      const first = await adapter.loginWithAuthorizationCode({
        accountId: "account-a",
        providerId: "shared-oidc",
        authorizationCode: "code-a",
        redirectUri: "https://itotori.example.test/auth/a",
      });
      const second = await adapter.loginWithAuthorizationCode({
        accountId: "account-b",
        providerId: "shared-oidc",
        authorizationCode: "code-b",
        redirectUri: "https://itotori.example.test/auth/b",
      });

      expect(first.createdExternalIdentity).toBe(true);
      expect(second.createdExternalIdentity).toBe(true);
      expect(second.userId).not.toBe(first.userId);
      expect(second.externalIdentityId).not.toBe(first.externalIdentityId);
      const identities = await context.db
        .select({
          provider: authExternalIdentities.provider,
          subject: authExternalIdentities.subject,
          userId: authExternalIdentities.userId,
        })
        .from(authExternalIdentities)
        .where(eq(authExternalIdentities.subject, "same-upstream-subject"));
      expect(identities).toEqual(
        expect.arrayContaining([
          {
            provider: oidcExternalIdentityProviderKey("account-a", "shared-oidc"),
            subject: "same-upstream-subject",
            userId: first.userId,
          },
          {
            provider: oidcExternalIdentityProviderKey("account-b", "shared-oidc"),
            subject: "same-upstream-subject",
            userId: second.userId,
          },
        ]),
      );
      expect(identities).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("does not link an OIDC login to an existing user by unverified email", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const principals = new ItotoriPrincipalRepository(context.db);
      await principals.createPrincipal(
        { userId: localUserId },
        {
          kind: "human_user",
          principalId: "principal-existing-email",
          userId: "user-existing-email",
          displayName: "Existing Email Owner",
          email: "owner@example.test",
        },
      );
      await configureOidcProvider(context.db, { userId: localUserId }, defaultLocalAccountId, {
        providerId: "oidc-unverified-email",
        issuer: "https://idp-unverified.example.test",
      });
      const adapter = new ItotoriOidcLoginAdapter(
        context.db,
        new StaticOidcClient({
          subject: "subject-with-unverified-email",
          email: "owner@example.test",
          emailVerified: false,
          displayName: "Unverified Email Presenter",
          providerClaims: [],
        }),
      );

      const result = await adapter.loginWithAuthorizationCode({
        accountId: defaultLocalAccountId,
        providerId: "oidc-unverified-email",
        authorizationCode: "code",
        redirectUri: "https://itotori.example.test/auth/callback",
      });

      expect(result.createdExternalIdentity).toBe(true);
      expect(result.userId).not.toBe("user-existing-email");
      const oidcUser = (
        await context.db.select().from(authUsers).where(eq(authUsers.userId, result.userId))
      )[0];
      expect(oidcUser).toEqual(
        expect.objectContaining({
          userId: result.userId,
          email: null,
        }),
      );
    } finally {
      await context.close();
    }
  });

  it("does not recreate membership for an existing OIDC identity after member removal", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      await configureOidcProvider(context.db, { userId: localUserId }, defaultLocalAccountId, {
        providerId: "oidc-removed-member",
        issuer: "https://idp-removed.example.test",
      });
      const provider = oidcExternalIdentityProviderKey(
        defaultLocalAccountId,
        "oidc-removed-member",
      );
      const members = new ItotoriAuthMemberManagementRepository(context.db);
      const invitation = await members.inviteMember(
        { userId: localUserId },
        {
          actorPrincipalId: localOperatorPrincipalId,
          accountId: defaultLocalAccountId,
          email: "removed.oidc@example.test",
          initialPermissionSetIds: [],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          reason: "oidc removal regression setup",
          requestId: "req-oidc-removed-invite",
        },
      );
      const accepted = await members.acceptInvitation(
        { userId: localUserId },
        {
          actorPrincipalId: localOperatorPrincipalId,
          invitationId: invitation.invitationId,
          userId: "user-removed-oidc",
          principalId: "principal-removed-oidc",
          displayName: "Removed OIDC Member",
          externalIdentity: {
            provider,
            subject: "removed-oidc-subject",
          },
          reason: "oidc removal regression setup",
          requestId: "req-oidc-removed-accept",
        },
      );
      await members.removeMember(
        { userId: localUserId },
        {
          actorPrincipalId: localOperatorPrincipalId,
          membershipId: accepted.membershipId,
          reason: "offboarding",
          requestId: "req-oidc-removed-remove",
        },
      );

      const adapter = new ItotoriOidcLoginAdapter(
        context.db,
        new StaticOidcClient({
          subject: "removed-oidc-subject",
          email: "removed.oidc@example.test",
          emailVerified: true,
          displayName: "Removed OIDC Member",
          providerClaims: [],
        }),
      );

      await expect(
        adapter.loginWithAuthorizationCode({
          accountId: defaultLocalAccountId,
          providerId: "oidc-removed-member",
          authorizationCode: "removed-code",
          redirectUri: "https://itotori.example.test/auth/callback",
        }),
      ).rejects.toThrow(/cannot restore a removed account membership/u);
      expect(
        await context.db
          .select()
          .from(authAccountMemberships)
          .where(eq(authAccountMemberships.userId, accepted.userId)),
      ).toHaveLength(0);
      expect(
        await context.db
          .select()
          .from(authSessions)
          .where(eq(authSessions.principalId, accepted.principalId)),
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("rejects OIDC login for disabled accounts before grants or sessions are issued", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      await configureOidcProvider(context.db, { userId: localUserId }, defaultLocalAccountId, {
        providerId: "oidc-disabled-account",
        issuer: "https://idp-disabled-account.example.test",
      });
      const principals = new ItotoriPrincipalRepository(context.db);
      await principals.mapProviderClaimToDirectPermission(
        { userId: localUserId },
        {
          actorPrincipalId: localOperatorPrincipalId,
          provider: oidcExternalIdentityProviderKey(defaultLocalAccountId, "oidc-disabled-account"),
          claimKind: "group",
          claimValue: "itotori-reviewers",
          permission: permissionValues.draftWrite,
          reason: "disabled account regression setup",
          requestId: "req-oidc-disabled-account-map",
        },
      );
      await context.db
        .update(authAccounts)
        .set({ disabledAt: new Date("2099-01-01T10:00:00.000Z") })
        .where(eq(authAccounts.accountId, defaultLocalAccountId));
      const adapter = new ItotoriOidcLoginAdapter(
        context.db,
        new StaticOidcClient({
          subject: "disabled-account-subject",
          email: "disabled-account@example.test",
          emailVerified: true,
          displayName: "Disabled Account Member",
          providerClaims: [{ kind: "group", value: "itotori-reviewers" }],
        }),
      );

      await expect(
        adapter.loginWithAuthorizationCode({
          accountId: defaultLocalAccountId,
          providerId: "oidc-disabled-account",
          authorizationCode: "disabled-code",
          redirectUri: "https://itotori.example.test/auth/callback",
        }),
      ).rejects.toThrow(`account ${defaultLocalAccountId} is disabled`);
      expect(
        await context.db
          .select()
          .from(authExternalIdentities)
          .where(eq(authExternalIdentities.subject, "disabled-account-subject")),
      ).toHaveLength(0);
      expect(await context.db.select().from(authExternalIdentityProviderClaims)).toHaveLength(0);
      expect(await context.db.select().from(authSessions)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});

async function configureOidcProvider(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  accountId: string,
  provider: { providerId: string; issuer: string },
): Promise<void> {
  const ssoSettings = new ItotoriAuthSsoSettingsRepository(db);
  await ssoSettings.configureSettings(actor, {
    accountId,
    provider: {
      protocol: "oidc",
      providerId: provider.providerId,
      displayName: provider.providerId,
      enabled: true,
      issuer: provider.issuer,
      clientId: "itotori-test-client",
      scopes: ["openid", "email", "profile"],
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
  });
}

class StaticOidcClient implements OidcProtocolClient {
  constructor(private readonly userInfo: OidcUserInfoResult) {}

  async exchangeAuthorizationCode() {
    return { accessToken: "static-access-token" };
  }

  async loadUserInfo() {
    return this.userInfo;
  }
}

type MockOidcServer = {
  issuer: string;
  requests: MockOidcRequest[];
  close(): Promise<void>;
};

type MockOidcRequest = {
  method: string;
  path: string;
  body: string;
  authorization: string | undefined;
};

async function startMockOidcServer(options: {
  authorizationCode: string;
  accessToken: string;
  subject: string;
  email: string;
  name: string;
  groups: string[];
}): Promise<MockOidcServer> {
  const requests: MockOidcRequest[] = [];
  let issuer = "";
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "GET",
      path,
      body,
      authorization: request.headers.authorization,
    });
    if (path === "/.well-known/openid-configuration") {
      writeJson(response, 200, {
        issuer,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      });
      return;
    }
    if (path === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      if (
        form.get("grant_type") !== "authorization_code" ||
        form.get("code") !== options.authorizationCode ||
        form.get("client_id") !== "itotori-test-client" ||
        form.get("redirect_uri") !== "https://itotori.example.test/auth/callback" ||
        form.get("code_verifier") !== "mock-pkce-verifier"
      ) {
        writeJson(response, 400, { error: "invalid_request" });
        return;
      }
      writeJson(response, 200, {
        access_token: options.accessToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    if (path === "/userinfo" && request.headers.authorization === `Bearer ${options.accessToken}`) {
      writeJson(response, 200, {
        sub: options.subject,
        email: options.email,
        email_verified: true,
        name: options.name,
        groups: options.groups,
      });
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
