// UTSUSHI-011 — Runtime-evidence triage integration.
//
// Runtime findings become deterministic human findings. A real correction
// enters through the canonical feedback/context-correction or result-revision
// surface; runtime QA never creates a separate approval queue.

import type { Uuid7 } from "@itotori/localization-bridge-schema";
import type { HumanFinding, HumanFindingSeverity } from "../../triage/human-finding.js";
import type { RuntimeEvidenceFinding } from "./shapes.js";

/** Map runtime-evidence findings onto human findings for the triage router. */
export function runtimeEvidenceFindingsToHumanFindings(
  findings: ReadonlyArray<RuntimeEvidenceFinding>,
  options: { now?: () => Date } = {},
): HumanFinding[] {
  const recordedAt = options.now?.() ?? new Date(0);
  return findings.map((finding) => {
    const human: HumanFinding = {
      findingId: finding.findingId as Uuid7,
      attribution: "runtime",
      severity: finding.severity satisfies HumanFindingSeverity,
      category: finding.findingKind,
      summary: finding.message,
      recordedAt,
    };
    if (finding.bridgeUnitId !== null) {
      human.bridgeUnitId = finding.bridgeUnitId as Uuid7;
    }
    return human;
  });
}
