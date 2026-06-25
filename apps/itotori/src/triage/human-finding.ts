// ITOTORI-022 — Human finding shape for the triage router.
//
// Findings entering the triage router come from two sources:
//   1. QA agents (typed `QaFinding` from
//      `@itotori/localization-bridge-schema`). Wire-validated.
//   2. Humans (this file) — reviewers, translators, runtime observers, or
//      playtesters. The shape is intentionally narrow; richer fields
//      (attachments, screenshots, save-state references) are added in
//      ITOTORI-024 (playtest feedback intake).
//
// The router branches on `attribution` to decide whether a human finding
// is `runtime_evidence` vs. a more specific class. Today only the
// `'runtime'` attribution has a dedicated routing rule; other
// attributions fall through to `unknown` until ITOTORI-024 and the
// reviewer-queue UI land richer category routing.

import type { Uuid7 } from "@itotori/localization-bridge-schema";

export const HUMAN_FINDING_ATTRIBUTIONS = [
  "translator",
  "reviewer",
  "runtime",
  "playtest",
] as const;
export type HumanFindingAttribution = (typeof HUMAN_FINDING_ATTRIBUTIONS)[number];

export const HUMAN_FINDING_SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type HumanFindingSeverity = (typeof HUMAN_FINDING_SEVERITIES)[number];

/**
 * Human-reported finding. `category` is intentionally a free-form string
 * (humans coin new categories all the time); the router does NOT branch
 * on it. Branching is on `attribution` only — the typed surface the
 * orchestrator can rely on.
 */
export type HumanFinding = {
  findingId: Uuid7;
  bridgeUnitId?: Uuid7;
  draftId?: Uuid7;
  attribution: HumanFindingAttribution;
  severity: HumanFindingSeverity;
  /**
   * Free-text category coined by the reporter. Not enforced; surfaced in
   * triage rationale verbatim so reviewers see what the reporter wrote.
   */
  category: string;
  summary: string;
  recordedAt: Date;
};
