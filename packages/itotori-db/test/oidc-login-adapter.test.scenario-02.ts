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

import {
  configureOidcProvider,
  StaticOidcClient,
  type MockOidcServer,
  type MockOidcRequest,
  startMockOidcServer,
  readBody,
  writeJson,
} from "./oidc-login-adapter.test.shared-01.js";

describe("ItotoriOidcLoginAdapter", () => {
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
