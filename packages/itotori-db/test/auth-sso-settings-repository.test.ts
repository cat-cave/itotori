import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  localUserId,
  permissionValues,
} from "../src/authorization.js";
import { ItotoriAuthSsoSettingsRepository } from "../src/repositories/auth-sso-settings-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

describe("ItotoriAuthSsoSettingsRepository", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "configures account SSO settings when the actor has auth.sso.manage",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        await bootstrapLocalUser(context.db);
        await bootstrapDefaultAccountPrincipal(context.db);
        const repository = new ItotoriAuthSsoSettingsRepository(context.db);

        const result = await repository.configureSettings(
          { userId: localUserId },
          {
            accountId: "account-local",
            provider: {
              protocol: "saml",
              providerId: "saml-main",
              displayName: "Corporate SAML",
              enabled: true,
              ssoUrl: "https://idp.example.test/saml/sso",
              entityId: "https://idp.example.test/saml/entity",
              certificateFingerprint: "SHA256:0123456789abcdef",
            },
            security: {
              requireSso: true,
              requireMfa: true,
              allowPasswordLogin: false,
            },
            sessionPolicy: {
              idleTimeoutMinutes: 30,
              absoluteTimeoutMinutes: 480,
            },
          },
        );

        expect(result).toMatchObject({
          accountId: "account-local",
          provider: { protocol: "saml", providerId: "saml-main" },
          security: { requireSso: true, requireMfa: true, allowPasswordLogin: false },
          sessionPolicy: { idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480 },
        });
      } finally {
        await context.close();
      }
    },
  );

  it.skipIf(!process.env.DATABASE_URL)(
    "denies account SSO settings without auth.sso.manage",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        await bootstrapLocalUser(context.db);
        await bootstrapDefaultAccountPrincipal(context.db);
        const repository = new ItotoriAuthSsoSettingsRepository(context.db);

        await expect(
          repository.configureSettings(
            { userId: "user-without-required-permission" },
            {
              accountId: "account-local",
              provider: {
                protocol: "oidc",
                providerId: "oidc-main",
                displayName: "Corporate OIDC",
                enabled: true,
                issuer: "https://idp.example.test/oauth2/default",
                clientId: "itotori",
                scopes: ["openid", "email"],
              },
              security: {
                requireSso: true,
                requireMfa: true,
                allowPasswordLogin: false,
              },
              sessionPolicy: {
                idleTimeoutMinutes: 30,
                absoluteTimeoutMinutes: 480,
              },
            },
          ),
        ).rejects.toMatchObject(
          new AuthorizationError(
            { userId: "user-without-required-permission" },
            permissionValues.authSsoManage,
          ),
        );
      } finally {
        await context.close();
      }
    },
  );
});
