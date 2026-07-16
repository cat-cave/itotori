// The A7-only web-egress channel.
//
// A7 is the sole role the web-egress boundary permits, and only when the operator
// has explicitly enabled egress outside a qualifying run. This module builds that
// gated tool and reconciles what it returns AGAINST the same-game facts, so web
// content stays a strictly separate, dominated channel:
//   - a web claim can never exceed `medium`, and reaches `medium` only when a
//     same-game fact corroborates it;
//   - a web claim that contradicts a same-game fact is SUPPRESSED, never merged;
//   - the grounded bio's own claims are unaffected — they cite same-game evidence
//     and resolve independently of anything the web returns.
// The boundary fails closed by default: with no operator opt-in, no query, byte,
// or fact ever leaves.

import {
  EGRESS_DISABLED,
  WEB_SEARCH_EGRESS_ROLE,
  createWebSearchTool,
  reconcileWebEvidence,
  webEgressAllowed,
  type EgressPolicy,
  type SameGameFact,
  type WebClaim,
  type WebEvidenceReconciliation,
  type WebSearchProvider,
} from "../../egress/index.js";
import type { DispatchTool } from "../../llm/dispatch.js";
import type { WebSearchResult } from "../../contracts/index.js";

import type { CharacterEvidence } from "./types.js";

/** The default posture: web egress disabled. A run that does not opt in stays
 * entirely local. */
export const A7_LOCAL_ONLY: EgressPolicy = EGRESS_DISABLED;

/** The operator context that opens A7's web channel for a run. */
export interface A7WebContext {
  readonly policy: EgressPolicy;
  readonly provider: WebSearchProvider;
  readonly now: () => Date;
}

/** True only when the web-egress boundary is open for A7 under this policy. */
export function a7WebEnabled(policy: EgressPolicy): boolean {
  return webEgressAllowed(WEB_SEARCH_EGRESS_ROLE, policy);
}

/** The authoritative same-game facts a web claim about a character is reconciled
 * against. The decoded label is a same-game fact; any web claim that disagrees
 * with it about this character is dominated. */
export function sameGameCharacterFacts(evidence: CharacterEvidence): SameGameFact[] {
  return [
    {
      factId: `${evidence.occurrenceFactId}:label`,
      subject: { kind: "character", id: evidence.characterId },
      value: evidence.decodedLabel,
    },
  ];
}

/** Build the A7-only, operator-gated web_search tool. Its execute() fails closed
 * BEFORE any provider call, so constructing it under a disabled policy is safe. */
export function buildA7WebSearchTool(context: A7WebContext, snapshotId: string): DispatchTool {
  return createWebSearchTool({
    roleId: WEB_SEARCH_EGRESS_ROLE,
    policy: context.policy,
    provider: context.provider,
    snapshotId,
    now: context.now,
  });
}

/** Run the gated web channel for one character and reconcile the sealed hits
 * against its same-game facts. Returns the facts-dominate ledger: usable claims
 * (low/medium) that are DISTINCT from the grounded bio, and suppressed claims a
 * same-game fact dominated. */
export async function reconcileCharacterWeb(
  context: A7WebContext,
  snapshotId: string,
  evidence: CharacterEvidence,
): Promise<WebEvidenceReconciliation> {
  const tool = buildA7WebSearchTool(context, snapshotId);
  const raw = await tool.execute(
    { query: evidence.decodedLabel, maxRows: 1_000, maxBytes: 8_388_608 },
    undefined,
  );
  const result = raw as WebSearchResult;
  const claims: WebClaim[] = result.hits.map((hit) => ({
    evidenceId: hit.evidenceId,
    subject: { kind: "character", id: evidence.characterId },
    assertion: hit.excerpt,
    confidence: "low",
  }));
  return reconcileWebEvidence(claims, sameGameCharacterFacts(evidence));
}
