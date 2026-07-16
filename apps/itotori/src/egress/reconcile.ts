// Facts-dominate reconciliation for web claims.
//
// Web content is a hypothesis, never engine truth. This is the seam that keeps
// it that way, coherent with the deterministic facts-dominate join
// (gates/join.ts): a same-game fact ALWAYS wins a conflict, and a web claim can
// never rise above `medium` — and only reaches `medium` once a same-game fact
// actually corroborates it. An uncorroborated claim stays `low`; a claim that
// contradicts any same-game fact is SUPPRESSED, not merely down-weighted.
//
// This function is pure and does no egress. It runs after web_search has already
// sealed provenance, so it decides only what the rest of itotori may trust.

import type { EntityRef } from "../contracts/index.js";

export type WebConfidence = "low" | "medium";

/** A claim carried by a sealed web hit, about one same-game subject. */
export interface WebClaim {
  /** The sealing evidence id (`web:sha256:...`) from the web hit. */
  readonly evidenceId: string;
  readonly subject: EntityRef;
  readonly assertion: string;
  readonly confidence: WebConfidence;
}

/** An authoritative same-game fact (decode / glossary / accepted output). */
export interface SameGameFact {
  readonly factId: string;
  readonly subject: EntityRef;
  readonly value: string;
}

export type WebClaimStatus = "corroborated" | "uncorroborated" | "contradicted";

/** The per-claim verdict, mirroring the deterministic join's dominance ledger. */
export interface WebClaimReconciliation {
  readonly evidenceId: string;
  readonly status: WebClaimStatus;
  /** Same-game fact ids that agree (non-empty only when corroborated). */
  readonly corroboratingSameGameFactIds: readonly string[];
  /** The same-game fact that suppressed a contradicting claim, if any. */
  readonly dominatingFactId: string | null;
  /** Confidence after reconciliation: `null` when the claim is suppressed. */
  readonly confidence: WebConfidence | null;
  readonly reason: string;
}

/** A usable claim after reconciliation, with confidence corrected in place. */
export interface UsableWebClaim {
  readonly evidenceId: string;
  readonly subject: EntityRef;
  readonly assertion: string;
  readonly confidence: WebConfidence;
  readonly corroboratingSameGameFactIds: readonly string[];
}

export interface WebEvidenceReconciliation {
  /** Corroborated (medium) and uncorroborated (low) claims, safe to consume. */
  readonly usable: readonly UsableWebClaim[];
  /** Claims a same-game fact dominated; these NEVER enter downstream context. */
  readonly suppressed: readonly WebClaimReconciliation[];
  /** The full per-claim ledger in input order. */
  readonly reconciliations: readonly WebClaimReconciliation[];
}

function subjectKey(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Normalize free text for agreement comparison: trim, collapse whitespace, and
 * case-fold. Deliberately conservative — anything not clearly equal counts as a
 * conflict, so a fact dominates rather than a fuzzy match blessing a web claim. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Reconcile sealed web claims against authoritative same-game facts. Facts
 * dominate: any claim that disagrees with a same-game fact for its subject is
 * suppressed; a claim whose subject is covered and agrees is corroborated at
 * `medium`; an uncovered claim survives at `low`. A web claim can never override
 * a fact and can never exceed `medium`.
 */
export function reconcileWebEvidence(
  claims: readonly WebClaim[],
  facts: readonly SameGameFact[],
): WebEvidenceReconciliation {
  const factsBySubject = new Map<string, SameGameFact[]>();
  for (const fact of facts) {
    const key = subjectKey(fact.subject);
    const bucket = factsBySubject.get(key) ?? [];
    bucket.push(fact);
    factsBySubject.set(key, bucket);
  }

  const usable: UsableWebClaim[] = [];
  const suppressed: WebClaimReconciliation[] = [];
  const reconciliations: WebClaimReconciliation[] = [];

  for (const claim of claims) {
    const sameSubject = factsBySubject.get(subjectKey(claim.subject)) ?? [];
    const claimValue = normalize(claim.assertion);
    const disagreeing = sameSubject.find((fact) => normalize(fact.value) !== claimValue);

    if (disagreeing) {
      // A same-game fact contradicts the claim — the fact wins, the claim is out.
      const entry: WebClaimReconciliation = {
        evidenceId: claim.evidenceId,
        status: "contradicted",
        corroboratingSameGameFactIds: [],
        dominatingFactId: disagreeing.factId,
        confidence: null,
        reason: `same-game fact ${disagreeing.factId} contradicts web claim ${claim.evidenceId}; the decode/same-game fact dominates`,
      };
      suppressed.push(entry);
      reconciliations.push(entry);
      continue;
    }

    if (sameSubject.length > 0) {
      // Every same-game fact for the subject agrees — corroborated to medium.
      const corroboratingSameGameFactIds = sameSubject.map((fact) => fact.factId);
      const entry: WebClaimReconciliation = {
        evidenceId: claim.evidenceId,
        status: "corroborated",
        corroboratingSameGameFactIds,
        dominatingFactId: null,
        confidence: "medium",
        reason: `web claim ${claim.evidenceId} corroborated by same-game fact(s) ${corroboratingSameGameFactIds.join(", ")}`,
      };
      usable.push({
        evidenceId: claim.evidenceId,
        subject: claim.subject,
        assertion: claim.assertion,
        confidence: "medium",
        corroboratingSameGameFactIds,
      });
      reconciliations.push(entry);
      continue;
    }

    // No same-game fact covers the subject — the claim survives, but only at low.
    const entry: WebClaimReconciliation = {
      evidenceId: claim.evidenceId,
      status: "uncorroborated",
      corroboratingSameGameFactIds: [],
      dominatingFactId: null,
      confidence: "low",
      reason: `web claim ${claim.evidenceId} has no same-game corroboration; capped at low confidence`,
    };
    usable.push({
      evidenceId: claim.evidenceId,
      subject: claim.subject,
      assertion: claim.assertion,
      confidence: "low",
      corroboratingSameGameFactIds: [],
    });
    reconciliations.push(entry);
  }

  return { usable, suppressed, reconciliations };
}
