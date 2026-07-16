// The web-egress boundary policy — allowlist and gate, entirely as DATA.
//
// ZDR governs remote inference; this module governs the ONE deliberate
// exception the privacy contract allows: A7 (the Character Biographer) may
// reach the public web, and only when the operator explicitly enables egress
// outside a qualifying run. Everything here is DATA derived from the frozen
// privacy/retention/egress contract (permission-not-role): the role that may
// egress and the operator/qualifying switches are contract fields, never a
// hardcoded role check scattered through call sites.
//
// The gate FAILS CLOSED on any ambiguity. It is the single choke point every
// egress-capable tool calls BEFORE it touches a provider or the network, so a
// disabled boundary emits zero bytes: no query, content, prompt, or decode
// fact ever leaves.

import {
  assertWebSearchEgress,
  privacyRetentionEgressManifest,
  type RoleId,
} from "../contracts/index.js";

/** The role permitted to egress, read straight from the frozen contract. */
export const WEB_SEARCH_EGRESS_ROLE: RoleId = privacyRetentionEgressManifest.egress.webSearchRole;

/**
 * Egress-capable tools and the roles allowed to invoke them, as DATA. web_search
 * is the ONLY egress tool and is granted to exactly the contract's configured
 * role. A role absent from this set is denied — there is no other allowlist that
 * can grant web_search, and the local read surface never lists it at all.
 */
export const EGRESS_TOOL_ROLE_ALLOWLIST: Readonly<Record<"web_search", readonly RoleId[]>> = {
  web_search: [WEB_SEARCH_EGRESS_ROLE],
};

/**
 * The operator's egress switches for one run. Both default-off postures
 * (`operatorEnabled: false` or `qualifyingRun: true`) close the boundary.
 */
export interface EgressPolicy {
  /** The operator's explicit opt-in. Absent this, egress fails closed. */
  readonly operatorEnabled: boolean;
  /** True in the ZDR-admission / qualifying posture, where egress is forbidden. */
  readonly qualifyingRun: boolean;
}

/** The default posture: egress disabled. Any run that does not deliberately
 * opt in inherits a closed boundary. */
export const EGRESS_DISABLED: EgressPolicy = { operatorEnabled: false, qualifyingRun: false };

export type EgressDenialCode =
  | "role-not-allowed"
  | "operator-egress-disabled"
  | "qualifying-run-disabled";

/** A loud, typed refusal raised BEFORE any network byte can leave. */
export class EgressDeniedError extends Error {
  constructor(
    readonly code: EgressDenialCode,
    detail: string,
  ) {
    super(`web egress ${code}: ${detail}`);
    this.name = "EgressDeniedError";
  }
}

/**
 * Assert that `roleId` may perform web egress under `policy`, or throw a typed
 * `EgressDeniedError`. Ordered so the strongest structural denial wins: a
 * non-allowlisted role is refused before the operator switch is even consulted.
 * The frozen privacy contract is then asserted as independent defense in depth —
 * if the DATA allowlist and the contract ever disagree, this fails closed.
 *
 * This function performs NO I/O. Every caller MUST invoke it before constructing
 * a query, reading decode facts for a query, or calling a web provider.
 */
export function assertWebEgressAllowed(roleId: RoleId, policy: EgressPolicy): void {
  if (!EGRESS_TOOL_ROLE_ALLOWLIST.web_search.includes(roleId)) {
    throw new EgressDeniedError("role-not-allowed", `role ${roleId} may not use web_search`);
  }
  if (!policy.operatorEnabled) {
    throw new EgressDeniedError(
      "operator-egress-disabled",
      "web egress is disabled; the operator has not explicitly enabled it",
    );
  }
  if (policy.qualifyingRun) {
    throw new EgressDeniedError(
      "qualifying-run-disabled",
      "web egress is forbidden during a qualifying / ZDR-admission run",
    );
  }
  // Defense in depth: the frozen contract must independently agree. This throws
  // a plain Error (not EgressDeniedError) only if the DATA above drifted from
  // the contract, which is itself a fail-closed outcome.
  assertWebSearchEgress({
    roleId,
    operatorEnabled: policy.operatorEnabled,
    qualifyingRun: policy.qualifyingRun,
  });
}

/** True when `roleId` may egress under `policy`, without throwing. A convenience
 * for enumeration/reporting; the executable path always uses the asserting gate. */
export function webEgressAllowed(roleId: RoleId, policy: EgressPolicy): boolean {
  try {
    assertWebEgressAllowed(roleId, policy);
    return true;
  } catch {
    return false;
  }
}
