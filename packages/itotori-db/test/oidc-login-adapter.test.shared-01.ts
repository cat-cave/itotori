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

export async function configureOidcProvider(
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

export class StaticOidcClient implements OidcProtocolClient {
  constructor(private readonly userInfo: OidcUserInfoResult) {}

  async exchangeAuthorizationCode() {
    return { accessToken: "static-access-token" };
  }

  async loadUserInfo() {
    return this.userInfo;
  }
}

export type MockOidcServer = {
  issuer: string;
  requests: MockOidcRequest[];
  close(): Promise<void>;
};

export type MockOidcRequest = {
  method: string;
  path: string;
  body: string;
  authorization: string | undefined;
};

export async function startMockOidcServer(options: {
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

export async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

export function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
