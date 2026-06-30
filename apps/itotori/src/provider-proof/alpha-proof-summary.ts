// ALPHA-008 — build + render the sanitized alpha provider-proof summary.
//
// `buildAlphaProviderProofSummary` PROJECTS a validated `ProviderProofBundle`
// (ITOTORI-116, recorded OR opt-in live) into the alpha-facing
// `AlphaProviderProofSummary`: servedRoutes (routed provider/model + fallback
// chain + retry state), structured-output support evidence, the ZDR
// data-policy flags, and the token/cost ledger. It copies/restates every value
// from the bundle — the ONLY arithmetic is summing the ledger's already-real
// micros and the micros → USD restatement. No raw prompt/response/key/private
// text can enter because the bundle never carried one and the summary copies
// only ids/hashes/counts/routing/cost.
//
// `renderReadmeSafeProviderProofSummary` renders that summary into a Markdown
// block that states ONLY facts from the bundle, carries the README banned-claim
// guard (no superlatives), and embeds no raw payload.

import {
  ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION,
  assertAlphaProviderProofSummary,
  type AlphaProviderProofCostRow,
  type AlphaProviderProofServedRoute,
  type AlphaProviderProofStructuredOutputEvidence,
  type AlphaProviderProofSummary,
  type ProviderProofAttempt,
  type ProviderProofBundle,
  type ProviderProofRole,
} from "@itotori/localization-bridge-schema";
import { README_BANNED_CLAIM_TERMS } from "../alpha-readiness/index.js";

const REDACTION_NOTE =
  "Sanitized provider proof: ids, hashes, counts, routing, and cost only. No raw " +
  "prompts, no raw provider responses, no API keys, and no private corpus text are " +
  "included or derivable from this summary (the ZDR account posture is the privacy gate).";

/** Convert integer micros-USD to USD. The ONLY permitted cost transform. */
function microsToUsd(micros: number): number {
  return micros / 1e6;
}

/** The terminal attempt of a role (the accepted one, or the final rejection). */
function terminalAttempt(role: ProviderProofRole): ProviderProofAttempt {
  const last = role.attempts[role.attempts.length - 1];
  if (last === undefined) {
    // assertProviderProofBundle already guarantees ≥1 attempt; this is a guard.
    throw new Error(`provider-proof role '${role.role}' carried no attempts`);
  }
  return last;
}

function servedRouteFor(role: ProviderProofRole): AlphaProviderProofServedRoute {
  const attempt = terminalAttempt(role);
  const fallbackChain = attempt.requestedRoute.split(">").filter((entry) => entry.length > 0);
  const head = fallbackChain[0];
  return {
    role: role.role,
    terminalStatus: role.terminalStatus,
    acceptedProviderProofId: role.acceptedProviderProofId,
    requestedModelId: attempt.requestedModelId,
    servedModel: attempt.servedModel,
    requestedProviderId: attempt.requestedProviderId,
    servedProvider: attempt.servedProvider,
    fallbackChain,
    fallbackOccurred: head !== undefined && attempt.servedProvider !== head,
    attemptCount: role.attempts.length,
    retryState: attempt.retryState,
    retryReason: attempt.retryReason,
  };
}

function structuredOutputEvidenceFor(
  role: ProviderProofRole,
): AlphaProviderProofStructuredOutputEvidence {
  const attempt = terminalAttempt(role);
  return {
    role: role.role,
    structuredOutputMode: attempt.structuredOutputMode,
    accepted: role.terminalStatus === "accepted",
    acceptedItemCount: role.acceptedItemCount,
    acceptedOutputHash: role.acceptedOutputHash,
  };
}

/**
 * Project a validated `ProviderProofBundle` into the alpha provider-proof
 * summary. The result is itself validated by `assertAlphaProviderProofSummary`
 * before return, so a shape regression fails loudly at the producer.
 */
export function buildAlphaProviderProofSummary(
  bundle: ProviderProofBundle,
): AlphaProviderProofSummary {
  const rows: AlphaProviderProofCostRow[] = bundle.ledger.map((row) => ({
    providerProofId: row.providerProofId,
    role: row.role,
    servedProvider: row.servedProvider,
    servedModel: row.servedModel,
    costAmount: row.costAmount,
    costMicrosUsd: row.costMicrosUsd,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokenCountSource: row.tokenCountSource,
    latencyMs: row.latencyMs,
  }));
  const totalMicrosUsd = rows.reduce((sum, row) => sum + row.costMicrosUsd, 0);

  const summary: AlphaProviderProofSummary = {
    schemaVersion: ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION,
    proofId: bundle.proofId,
    mode: bundle.mode,
    fixtureId: bundle.fixtureId,
    maxRepairAttempts: bundle.maxRepairAttempts,
    dataPolicy: {
      zdrAccountAssertion: bundle.zdr.accountAssertion,
      perRequestZdr: bundle.zdr.perRequestZdr,
      allLedgerRoutesZdr: bundle.ledger.length > 0 && bundle.ledger.every((row) => row.zdr),
    },
    servedRoutes: bundle.roles.map(servedRouteFor),
    structuredOutputSupport: bundle.roles.map(structuredOutputEvidenceFor),
    cost: {
      currency: "USD",
      totalMicrosUsd,
      totalUsd: microsToUsd(totalMicrosUsd),
      rows,
    },
    qaOracle: bundle.qaOracle,
    redaction: {
      rawPromptsIncluded: false,
      rawResponsesIncluded: false,
      apiKeysIncluded: false,
      privateCorpusTextIncluded: false,
      note: REDACTION_NOTE,
    },
  };
  assertAlphaProviderProofSummary(summary);
  return summary;
}

const PROVENANCE_BY_MODE = {
  recorded:
    "Figures below are derived from a recorded provider-proof fixture (no live runs, no " +
    "credentials). They describe what the recorded call contains, not a live performance claim.",
  live:
    "Figures below are derived from an opted-in live ZDR provider call. They are sanitized to " +
    "ids, hashes, counts, routing, and the real billed cost only; no prompt, response, key, or " +
    "private text is shown.",
} as const;

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

/** Render the README-safe Markdown summary for the alpha provider-proof bundle. */
export function renderReadmeSafeProviderProofSummary(summary: AlphaProviderProofSummary): string {
  const lines: string[] = [];
  lines.push("# Provider proof bundle (sanitized)");
  lines.push("");
  lines.push(`- Proof: \`${summary.proofId}\` (mode: ${summary.mode})`);
  lines.push(`- Fixture: ${summary.fixtureId}`);
  lines.push(`- Bounded schema repairs allowed: ${summary.maxRepairAttempts}`);
  lines.push("");
  lines.push(`> ${PROVENANCE_BY_MODE[summary.mode]}`);
  lines.push("");

  lines.push("## Data policy (ZDR) flags");
  lines.push("");
  lines.push(`- Account ZDR assertion: ${summary.dataPolicy.zdrAccountAssertion}`);
  lines.push(
    `- Per-request ZDR on accepted calls: ${summary.dataPolicy.perRequestZdr ? "yes" : "no"}`,
  );
  lines.push(
    `- Every ledger route ZDR-enforced: ${summary.dataPolicy.allLedgerRoutesZdr ? "yes" : "no"}`,
  );
  lines.push("");

  lines.push("## Routed (served) provider, model, and fallback chain");
  lines.push("");
  lines.push(
    "| Role | Terminal | Requested (model @ provider) | Served (model @ provider) | Fallback chain | Fallback occurred | Retry state |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const route of summary.servedRoutes) {
    lines.push(
      `| ${route.role} | ${route.terminalStatus} | ${escapeCell(`${route.requestedModelId} @ ${route.requestedProviderId}`)} | ` +
        `${escapeCell(`${route.servedModel} @ ${route.servedProvider}`)} | ${escapeCell(route.fallbackChain.join(" > "))} | ` +
        `${route.fallbackOccurred ? "yes" : "no"} | ${route.retryState}${route.retryReason === null ? "" : ` (${escapeCell(route.retryReason)})`} |`,
    );
  }
  lines.push("");

  lines.push("## Structured-output support evidence");
  lines.push("");
  lines.push("| Role | Mode | Accepted | Items | Output hash |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const evidence of summary.structuredOutputSupport) {
    lines.push(
      `| ${evidence.role} | ${evidence.structuredOutputMode} | ${evidence.accepted ? "yes" : "no"} | ` +
        `${evidence.acceptedItemCount ?? "n/a"} | ${escapeCell(evidence.acceptedOutputHash ?? "n/a")} |`,
    );
  }
  lines.push("");

  lines.push("## Cost and token usage (from the real call)");
  lines.push("");
  lines.push(
    `- Total: ${summary.cost.totalUsd.toFixed(6)} USD (${summary.cost.totalMicrosUsd} micros-USD) across ${summary.cost.rows.length} accepted route(s).`,
  );
  lines.push(
    "| Proof id | Role | Served route | Cost (USD) | Tokens in/out | Source | Latency (ms) |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of summary.cost.rows) {
    lines.push(
      `| ${escapeCell(row.providerProofId)} | ${row.role} | ${escapeCell(`${row.servedModel} @ ${row.servedProvider}`)} | ` +
        `${escapeCell(row.costAmount)} | ${row.tokensIn}/${row.tokensOut} | ${escapeCell(row.tokenCountSource)} | ${row.latencyMs} |`,
    );
  }
  lines.push("");

  lines.push("## Seeded QA oracle");
  lines.push("");
  lines.push(
    `- ${summary.qaOracle.truePositives} true / ${summary.qaOracle.falsePositives} false positive(s), ` +
      `${summary.qaOracle.falseNegatives} false negative(s) over ${summary.qaOracle.seededDefectCount} seeded defect(s); ` +
      `precision ${summary.qaOracle.precision}, recall ${summary.qaOracle.recall}, F1 ${summary.qaOracle.f1}.`,
  );
  lines.push("");

  lines.push("## Redaction");
  lines.push("");
  lines.push(`- ${summary.redaction.note}`);
  lines.push("");

  const rendered = `${lines.join("\n")}\n`;
  assertNoBannedClaim(rendered);
  return rendered;
}

/**
 * The README banned-claim guard, reused so the provider-proof summary can never
 * smuggle in an unverifiable marketing claim. Throws on the first banned term.
 */
function assertNoBannedClaim(rendered: string): void {
  const lower = rendered.toLowerCase();
  for (const term of README_BANNED_CLAIM_TERMS) {
    if (lower.includes(term)) {
      throw new Error(`provider-proof summary contained banned claim term '${term}'`);
    }
  }
}
