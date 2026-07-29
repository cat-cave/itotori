import type { ExternalIdentityProviderClaim } from "../authorization.js";
import {
  ItotoriOidcLoginAdapterError,
  type OidcProtocolClient,
  type OidcTokenExchangeInput,
  type OidcTokenExchangeResult,
  type OidcUserInfoInput,
  type OidcUserInfoResult,
} from "./oidc-login-adapter.js";

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
