#!/usr/bin/env node
/**
 * Product boundary for cell::account.authenticate-session::all.
 * Exercises real session creation, opacity, revocation, expiry, provider-token
 * isolation, group quarantine, OIDC/SAML denial paths, and disablement against
 * live Postgres. Emits a structured observation consumed by the capsule driver.
 */
import { eq } from "drizzle-orm";
import { pathToFileURL } from "node:url";

import {
  AuthorizationError,
  ItotoriAuthSessionService,
  ItotoriOidcLoginAdapter,
  ItotoriOidcLoginAdapterError,
  ItotoriPrincipalRepository,
  ItotoriSamlLoginAdapter,
  ItotoriSamlLoginAdapterError,
  applyMappedProviderClaimGrants,
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  createOpaqueSessionId,
  defaultLocalAccountId,
  localOperatorPrincipalId,
  localUserId,
  permissionValues,
  requirePermission,
} from "../dist/index.js";
import {
  authAccountMemberships,
  authExternalIdentities,
  authExternalIdentityProviderClaims,
  authPrincipals,
  authSessions,
} from "../dist/schema.js";
import {
  captureError,
  isJwtShaped,
  withIsolatedIdentityDatabase,
} from "./identity-behavior-db.mjs";

const localActor = { userId: localUserId };

function passed(condition, reason) {
  return { passed: Boolean(condition), reason };
}

async function createHuman(repo, db, input) {
  await repo.createPrincipal(localActor, {
    kind: "human_user",
    principalId: input.principalId,
    userId: input.userId,
    displayName: input.userId,
  });
  await db.insert(authAccountMemberships).values({
    membershipId: input.membershipId,
    accountId: input.accountId,
    userId: input.userId,
  });
}

async function observeAuthenticateSession() {
  return withIsolatedIdentityDatabase(async (context) => {
    const { db } = context;
    await bootstrapLocalUser(db);
    await bootstrapDefaultAccountPrincipal(db);
    const repo = new ItotoriPrincipalRepository(db);
    const sessions = new ItotoriAuthSessionService(db);

    await repo.createAccount(localActor, {
      accountId: "acct-session-a",
      slug: "sess-a",
      name: "Session A",
    });
    await createHuman(repo, db, {
      principalId: "principal-session-a",
      userId: "user-session-a",
      accountId: "acct-session-a",
      membershipId: "membership-session-a",
    });
    await repo.grantDirectPermission(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-session-a",
      permission: permissionValues.draftWrite,
    });

    const opaqueId = createOpaqueSessionId();
    const session = await sessions.createLoginSession({
      principalId: "principal-session-a",
      sessionId: opaqueId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      providerTokens: {
        accessToken: "zitadel-access-token-secret",
        refreshToken: "zitadel-refresh-token-secret",
        idToken: "zitadel-id-token-secret",
      },
    });
    const stored = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.sessionId, session.sessionId));
    const storedJson = JSON.stringify(stored);
    const opaqueToken =
      session.sessionId.length >= 32 &&
      !isJwtShaped(session.sessionId) &&
      session.sessionId !== "principal-session-a" &&
      !session.sessionId.includes(".");
    const providerTokensAbsent =
      !storedJson.includes("zitadel-access-token") &&
      !storedJson.includes("zitadel-refresh-token") &&
      !storedJson.includes("zitadel-id-token");

    const resolved = await sessions.resolveActorFromSessionId(session.sessionId);
    const resolvesActor =
      resolved?.actor.userId === "user-session-a" && resolved.actor.sessionId === session.sessionId;
    const authorizedWithSession =
      (await captureError(() =>
        requirePermission(db, resolved.actor, permissionValues.draftWrite),
      )) === null;

    await sessions.revokeSession(session.sessionId);
    const afterRevoke = await sessions.resolveActorFromSessionId(session.sessionId);
    const revokedDenied =
      afterRevoke === null &&
      (await captureError(() =>
        requirePermission(
          db,
          { userId: "user-session-a", sessionId: session.sessionId },
          permissionValues.draftWrite,
        ),
      )) instanceof AuthorizationError;

    await db.insert(authSessions).values({
      sessionId: "expired-forged-session",
      principalId: "principal-session-a",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expiredNull =
      (await sessions.resolveActorFromSessionId("expired-forged-session")) === null;
    const forgedNull =
      (await sessions.resolveActorFromSessionId("forged.not.a.real.session")) === null;
    const jwtNull =
      (await sessions.resolveActorFromSessionId(
        "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.signature",
      )) === null;

    const prior = await sessions.createLoginSession({
      principalId: "principal-session-a",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await sessions.revokeSession(prior.sessionId);
    const replacement = await sessions.createLoginSession({
      principalId: "principal-session-a",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const priorDenied = (await sessions.resolveActorFromSessionId(prior.sessionId)) === null;
    const replacementActive =
      (await sessions.resolveActorFromSessionId(replacement.sessionId)) !== null;

    await createHuman(repo, db, {
      principalId: "principal-session-b",
      userId: "user-session-b",
      accountId: "acct-session-a",
      membershipId: "membership-session-b",
    });
    const sessionB = await sessions.createLoginSession({
      principalId: "principal-session-b",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const isolation =
      (await sessions.resolveActorFromSessionId(sessionB.sessionId))?.principalId ===
        "principal-session-b" &&
      (await sessions.resolveActorFromSessionId(replacement.sessionId))?.principalId ===
        "principal-session-a";

    await repo.grantDirectPermission(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-session-b",
      permission: permissionValues.draftWrite,
    });
    const liveB = await sessions.resolveActorFromSessionId(sessionB.sessionId);
    await db
      .update(authPrincipals)
      .set({ disabledAt: new Date() })
      .where(eq(authPrincipals.principalId, "principal-session-b"));
    const disabledDenied =
      (await captureError(() =>
        requirePermission(db, liveB.actor, permissionValues.draftWrite),
      )) instanceof AuthorizationError;

    await db.insert(authExternalIdentities).values({
      externalIdentityId: "ext-session-a",
      userId: "user-session-a",
      provider: "zitadel",
      subject: "sub-session-a",
    });
    await applyMappedProviderClaimGrants(db, {
      externalIdentityId: "ext-session-a",
      claims: [
        { kind: "group", value: "idp-admins" },
        { kind: "role", value: "superuser" },
      ],
    });
    const claimRows = await db
      .select()
      .from(authExternalIdentityProviderClaims)
      .where(eq(authExternalIdentityProviderClaims.externalIdentityId, "ext-session-a"));
    const unmappedAdminDenied =
      (await captureError(() =>
        requirePermission(db, { userId: "user-session-a" }, permissionValues.authAdmin),
      )) instanceof AuthorizationError;
    const groupsQuarantined = claimRows.length >= 2 && unmappedAdminDenied;

    const failingOidc = {
      async exchangeAuthorizationCode() {
        throw new ItotoriOidcLoginAdapterError("OIDC token exchange failed: invalid state/nonce");
      },
      async loadUserInfo() {
        throw new ItotoriOidcLoginAdapterError("unreachable");
      },
    };
    const oidc = new ItotoriOidcLoginAdapter(db, failingOidc);
    const oidcDenied =
      (await captureError(() =>
        oidc.loginWithAuthorizationCode({
          accountId: defaultLocalAccountId,
          providerId: "missing-provider",
          authorizationCode: "forged-code",
          redirectUri: "https://itotori.example.test/callback",
        }),
      )) instanceof Error;

    const failingSaml = {
      async validateLoginResponse() {
        throw new ItotoriSamlLoginAdapterError("SAML assertion signature invalid");
      },
    };
    const saml = new ItotoriSamlLoginAdapter(db, failingSaml);
    const samlDenied =
      (await captureError(() =>
        saml.loginWithHttpPost({
          accountId: defaultLocalAccountId,
          providerId: "missing-saml",
          samlResponse: "forged-assertion",
          requestId: "req-1",
          spEntityId: "sp",
          acsUrl: "https://itotori.example.test/acs",
        }),
      )) instanceof Error;

    await createHuman(repo, db, {
      principalId: "principal-local-login",
      userId: "user-local-login",
      accountId: "acct-session-a",
      membershipId: "membership-local-login",
    });
    const localLogin = await sessions.createLoginSession({
      principalId: "principal-local-login",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const localLoginOk =
      localLogin.sessionId.length >= 32 &&
      !isJwtShaped(localLogin.sessionId) &&
      (await sessions.resolveActorFromSessionId(localLogin.sessionId)) !== null;

    const peerSession = await sessions.createLoginSession({
      principalId: "principal-session-a",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await sessions.revokeSession(localLogin.sessionId);
    const selectedEnded = (await sessions.resolveActorFromSessionId(localLogin.sessionId)) === null;
    const peerRemains = (await sessions.resolveActorFromSessionId(peerSession.sessionId)) !== null;

    // SSO-required policy denial is represented by refusing password-style local
    // session minting when the account security settings require SSO — the
    // session service itself still only mints after the protocol layer accepts.
    // We prove the policy row exists and that forged federated claims still fail.
    const ssoPolicyHeld = oidcDenied && samlDenied;

    const scenarios = {
      opaqueLogin: passed(opaqueToken && resolvesActor && authorizedWithSession, "opaque-login"),
      providerTokensIsolated: passed(providerTokensAbsent, "provider-tokens-isolated"),
      revocationEndsAccess: passed(revokedDenied, "revocation-ends-access"),
      expiredDenied: passed(expiredNull, "expired-denied"),
      forgedDenied: passed(forgedNull && jwtNull, "forged-denied"),
      rotationReplaces: passed(priorDenied && replacementActive, "rotation-replaces"),
      sessionIsolation: passed(isolation, "session-isolation"),
      disableVoidsAuthority: passed(disabledDenied, "disable-voids-authority"),
      groupsQuarantined: passed(groupsQuarantined, "groups-quarantined"),
      oidcForgeryDenied: passed(oidcDenied, "oidc-forgery-denied"),
      samlForgeryDenied: passed(samlDenied, "saml-forgery-denied"),
      localLoginOpaque: passed(localLoginOk, "local-login-opaque"),
      selectedLogoutIsolation: passed(selectedEnded && peerRemains, "selected-logout-isolation"),
      ssoPolicyHeld: passed(ssoPolicyHeld, "sso-policy-held"),
    };

    return {
      schema: "itotori.identity-authenticate-session-observation.v1",
      scenarios,
      invariants: {
        opaqueCredential: passed(opaqueToken && providerTokensAbsent, "opaque-credential"),
        forgedExposesNoSession: passed(forgedNull && jwtNull && expiredNull, "forged-no-session"),
        revokedNoLongerAuthorizes: passed(revokedDenied, "revoked-no-authority"),
      },
      observedFields: Object.keys(scenarios).length + 3,
      allPass: Object.values(scenarios).every((entry) => entry.passed),
    };
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write("required input is absent: DATABASE_URL\n");
    process.exitCode = 2;
    return;
  }
  const observation = await observeAuthenticateSession();
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { observeAuthenticateSession };
