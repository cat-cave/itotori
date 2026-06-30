// ALPHA-003 — README-safe alpha readiness summary renderer.
//
// Renders the composed readiness report into a Markdown summary that states
// ONLY facts derived from the checked-in public fixtures and recorded provider
// artifacts. It carries no superlative / unverifiable marketing claim, embeds
// no private-local contents (the supplementary line is presence + hash only),
// and links every cited artifact by path so a reader can verify it.

import type { AlphaReadinessReport } from "./readiness.js";

/**
 * Words that would turn a factual summary into an unverifiable public claim.
 * The renderer never emits them; the regression suite asserts their absence so
 * a future edit cannot smuggle one in.
 */
export const README_BANNED_CLAIM_TERMS = [
  "best",
  "fastest",
  "state-of-the-art",
  "world-class",
  "unbeatable",
  "guarantee",
  "guaranteed",
  "perfect",
  "flawless",
  "industry-leading",
  "superior",
] as const;

const PROVENANCE_DISCLAIMER =
  "All figures below are derived from checked-in public fixtures and recorded " +
  "provider artifacts (no live runs). They describe what the recorded benchmark " +
  "contains, not a live performance claim.";

/** Render the README-safe Markdown summary for the alpha readiness report. */
export function renderReadmeSafeAlphaSummary(report: AlphaReadinessReport): string {
  const lines: string[] = [];
  lines.push("# Alpha readiness benchmark summary");
  lines.push("");
  lines.push(`- Decision: **${report.decision}** (decided by the public-fixture benchmark)`);
  lines.push(`- Benchmark: ${report.benchmarkName}`);
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push(`> ${PROVENANCE_DISCLAIMER}`);
  lines.push("");

  lines.push("## Gates");
  lines.push("");
  lines.push("| Gate | Status | Detail |");
  lines.push("| --- | --- | --- |");
  for (const gate of report.gates) {
    lines.push(`| ${gate.title} | ${gate.status} | ${escapeCell(gate.detail)} |`);
  }
  lines.push("");

  lines.push("## MTL baseline");
  lines.push("");
  if (report.mtlBaseline.included) {
    const ids = report.mtlBaseline.systems.map((s) => s.systemId).join(", ");
    lines.push(`- Raw MTL baseline included: ${ids}`);
  } else {
    lines.push("- Raw MTL baseline included: no");
  }
  lines.push("");

  lines.push("## Cost (ledger-derived)");
  lines.push("");
  lines.push(
    `- Recorded total: ${report.cost.reportTotalUsd.toFixed(6)} USD ` +
      `(${report.cost.reportTotalMicrosUsd} micros-USD), sourced from the recomputed benchmark cost ledger.`,
  );
  lines.push(`- Unattributed cost present: ${report.cost.includesUnknownCost ? "yes" : "no"}`);
  for (const system of report.cost.perSystem) {
    lines.push(`  - ${system.systemId}: ${system.totalUsd.toFixed(6)} USD`);
  }
  if (report.cost.providerProofReconciliation !== null) {
    const r = report.cost.providerProofReconciliation;
    lines.push(
      `- Provider-ledger cross-check (experiment '${r.experimentId}'): ` +
        `artifact ${r.artifactUsd} USD vs ledger ${r.ledgerUsd} USD over ` +
        `${r.reconciledInvocationCount} reconciled invocation(s).`,
    );
  }
  lines.push("");

  lines.push("## Provider route proof");
  lines.push("");
  if (report.providerProof !== null) {
    const pairs = report.providerProof.servedPairs
      .map((pair) => `${pair.servedModelId} @ ${pair.servedProviderId}`)
      .join(", ");
    lines.push(`- Served (model, provider) pairs: ${pairs}`);
    lines.push(
      `- Invocations: ${report.providerProof.succeededCount} succeeded / ` +
        `${report.providerProof.failedCount} failed of ${report.providerProof.invocationCount}; ` +
        `${report.providerProof.zdrEnforcedCount} ZDR-enforced.`,
    );
  } else {
    lines.push("- Provider route proof: not composed (see findings).");
  }
  lines.push("");

  lines.push("## Provider proof bundle (real-call evidence)");
  lines.push("");
  if (report.providerProofBundle !== null) {
    const bundle = report.providerProofBundle;
    lines.push(
      `- Bundle: \`${bundle.proofId}\` (mode: ${bundle.mode}, fixture: ${bundle.fixtureId})`,
    );
    lines.push(
      `- ZDR posture: account ${bundle.zdr.accountAssertion}, per-request ${bundle.zdr.perRequestZdr ? "yes" : "no"}, ` +
        `all ledger routes ZDR ${bundle.zdr.allLedgerRoutesZdr ? "yes" : "no"}.`,
    );
    for (const route of bundle.servedRoutes) {
      lines.push(
        `  - ${route.role}: served ${route.servedModel} @ ${route.servedProvider}; ` +
          `fallback chain ${route.fallbackChain.join(" > ")} (fallback occurred: ${route.fallbackOccurred ? "yes" : "no"}).`,
      );
    }
    for (const support of bundle.structuredOutputSupport) {
      lines.push(
        `  - ${support.role} structured-output mode ${support.mode}: accepted ${support.accepted ? "yes" : "no"}.`,
      );
    }
    lines.push(`- Bundle cost total: ${bundle.totalCostUsd.toFixed(6)} USD.`);
  } else {
    lines.push("- Provider proof bundle: not supplied (see findings).");
  }
  lines.push("");

  lines.push("## Quality evidence");
  lines.push("");
  lines.push(`- Deterministic QA results: ${report.quality.deterministicQa.length}`);
  lines.push(`- QA-agent (LLM) evaluations: ${report.quality.qaAgentEvaluations.length}`);
  for (const evaluation of report.quality.qaAgentEvaluations) {
    lines.push(
      `  - ${evaluation.qaAgentId} on ${evaluation.evaluatedSystemId}: ` +
        `seeded precision ${evaluation.seededPrecision}, seeded recall ${evaluation.seededRecall}, ` +
        `F1 ${evaluation.f1} (against the seeded-defect oracle).`,
    );
  }
  lines.push("");

  lines.push("## Linked artifacts");
  lines.push("");
  for (const link of [
    report.links.benchmarkRunManifest,
    report.links.benchmarkSeedSelection,
    report.links.qualityReport,
    report.links.providerProof,
  ]) {
    const hash = link.artifactHash === null ? "" : ` (${link.artifactHash})`;
    lines.push(`- ${link.role}: \`${link.artifactPath}\`${hash}`);
  }
  lines.push("");

  lines.push("## Supplementary private-local evidence");
  lines.push("");
  if (report.supplementaryPrivateLocal.provided) {
    lines.push(
      `- Present (label: ${report.supplementaryPrivateLocal.label ?? "unlabelled"}, ` +
        `sha256: ${report.supplementaryPrivateLocal.aggregateSha256 ?? "n/a"}); ` +
        "contents not shown.",
    );
  } else {
    lines.push("- Not provided.");
  }
  lines.push(`- ${report.supplementaryPrivateLocal.note}`);
  lines.push("");

  if (report.findings.length > 0) {
    lines.push("## Findings");
    lines.push("");
    for (const finding of report.findings) {
      lines.push(`- [${finding.kind}] ${escapeCell(finding.message)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}
