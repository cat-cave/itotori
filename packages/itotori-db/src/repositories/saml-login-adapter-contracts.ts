import type {
  ExternalIdentityProviderClaim,
  Permission,
} from "../authorization.js";
import type { AuthSessionRecord } from "./auth-session-service.js";

export type SamlHttpPostLoginInput = {
  accountId: string;
  providerId: string;
  samlResponse: string;
  requestId: string;
  spEntityId: string;
  acsUrl: string;
  relayState?: string;
  now?: Date;
  device?: {
    userAgent?: string;
    ipAddress?: string;
    deviceLabel?: string;
  };
};

export type SamlAssertionValidationInput = {
  idpEntityId: string;
  ssoUrl: string;
  certificateFingerprint?: string;
  samlResponse: string;
  requestId: string;
  spEntityId: string;
  acsUrl: string;
  relayState?: string;
  now?: Date;
};

export type SamlAssertionResult = {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  providerClaims: ExternalIdentityProviderClaim[];
};

export interface SamlProtocolClient {
  validateLoginResponse(input: SamlAssertionValidationInput): Promise<SamlAssertionResult>;
}

export type SamlLoginResult = {
  provider: string;
  subject: string;
  userId: string;
  principalId: string;
  externalIdentityId: string;
  createdExternalIdentity: boolean;
  session: AuthSessionRecord;
  appliedMappedPermissions: Permission[];
};

export class ItotoriSamlLoginAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriSamlLoginAdapterError";
  }
}

export function samlExternalIdentityProviderKey(accountId: string, providerId: string): string {
  assertNonEmpty(accountId, "accountId");
  assertNonEmpty(providerId, "providerId");
  return `saml:${encodeURIComponent(accountId)}:${encodeURIComponent(providerId)}`;
}

export function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ItotoriSamlLoginAdapterError(`${label} must be non-empty`);
  }
}
