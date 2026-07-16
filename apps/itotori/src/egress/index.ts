// Web egress boundary — public exports.
//
// The one deliberate ZDR exception the privacy contract allows: A7-only,
// operator-enabled web_search. The boundary fails closed by default (zero
// egress) and, when open, seals auditable web provenance whose claims can never
// override decode or same-game facts.

export {
  EGRESS_DISABLED,
  EGRESS_TOOL_ROLE_ALLOWLIST,
  EgressDeniedError,
  WEB_SEARCH_EGRESS_ROLE,
  assertWebEgressAllowed,
  webEgressAllowed,
  type EgressDenialCode,
  type EgressPolicy,
} from "./policy.js";

export {
  WebSearchArgsSchema,
  createWebSearchTool,
  sealWebHit,
  type RawWebHit,
  type WebSearchArgs,
  type WebSearchProvider,
  type WebSearchToolConfig,
} from "./web-search.js";

export {
  reconcileWebEvidence,
  type SameGameFact,
  type UsableWebClaim,
  type WebClaim,
  type WebClaimReconciliation,
  type WebClaimStatus,
  type WebConfidence,
  type WebEvidenceReconciliation,
} from "./reconcile.js";
