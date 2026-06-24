#!/usr/bin/env node
// ITOTORI-021 — Generate canonical recorded-bundle JSON files for the
// scored-finding workflow's calibration fixtures.
//
// Each output file is a per-(fixture, agent, authority) snapshot of the
// `StructuredQaFindingOutput` the focused agent would produce. The JSON
// files are loaded at test time and keyed by the deterministic prompt
// hash the agent will compute (the loader handles that — see
// `apps/itotori/src/qa/recorded-bundles/index.ts`).
//
// Usage: node scripts/generate-qa-calibration-bundles.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const BUNDLES_DIR = resolve(REPO_ROOT, "apps/itotori/src/qa/recorded-bundles");

const SCHEMA_VERSION = "itotori.qa-calibration-recorded-bundle.v1";

const FIXTURE_BRIDGE_UNIT_ID_B = "019ed079-0000-7000-8000-000000ca0002";
const FIXTURE_GLOSSARY_TERM_ID = "019ed079-0000-7000-8000-000000cb0001";

// Mirror of `expectedFindings` from calibration-fixtures.ts. Kept here
// (NOT imported) so this generator stays a pure node script with no
// build step. The TEST suite asserts the generated files match the
// fixtures so any drift surfaces immediately.
const ORIGINAL_BUNDLES = {
  "calibration-known-good": {
    "style-adherence": [],
    "semantic-drift": [],
    "tone-register": [],
    "unresolved-terminology": [],
  },
  "calibration-style-violation": {
    "style-adherence": [
      {
        findingId: "019ed079-0000-7000-8000-000fa0000001",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "critical",
        category: "protected-span-violation",
        evidenceRefs: ["style-guide:protected-spans-001"],
        recommendation: "Restore the {player} placeholder before exporting the draft.",
        agentRationale:
          "Source carries the {player} placeholder; draft omits it entirely, breaking the protected-span contract.",
      },
    ],
    "semantic-drift": [],
    "tone-register": [],
    "unresolved-terminology": [],
  },
  "calibration-semantic-drift": {
    "style-adherence": [],
    "semantic-drift": [
      {
        findingId: "019ed079-0000-7000-8000-000fa0000002",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "major",
        category: "mistranslation",
        evidenceRefs: ["scene-summary:scene-calibration"],
        recommendation: "Remove 'and the queen' — the source bows only to the king.",
        agentRationale:
          "Source references only the king; the draft adds the queen as a second target, changing the propositional content.",
      },
    ],
    "tone-register": [],
    "unresolved-terminology": [],
  },
  "calibration-tone-shift": {
    "style-adherence": [],
    "semantic-drift": [],
    "tone-register": [
      {
        findingId: "019ed079-0000-7000-8000-000fa0000003",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "major",
        category: "tone",
        evidenceRefs: ["style-guide:tone-formal-001"],
        recommendation: "Rewrite using the formal register established by units 1 and 3.",
        agentRationale:
          "Draft switches to casual register mid-scene ('kinda just bowed', 'lol'), violating the tone-formal-001 style guide.",
      },
    ],
    "unresolved-terminology": [],
  },
  "calibration-terminology-miss": {
    "style-adherence": [],
    "semantic-drift": [],
    "tone-register": [],
    "unresolved-terminology": [
      {
        findingId: "019ed079-0000-7000-8000-000fa0000004",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "major",
        category: "glossary-conflict",
        evidenceRefs: [`glossary:${FIXTURE_GLOSSARY_TERM_ID}`],
        recommendation:
          "Use the glossary's preferred target form 'hero' for 勇者 instead of 'warrior'.",
        agentRationale:
          "Glossary maps 勇者 → hero (policyAction=localize); the draft renders it as 'warrior'.",
      },
    ],
  },
  "calibration-regrade-trigger": {
    "style-adherence": [
      {
        findingId: "019ed079-0000-7000-8000-000fa0000005",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "critical",
        category: "protected-span-violation",
        evidenceRefs: ["style-guide:protected-spans-001"],
        recommendation: "Restore the {player} placeholder.",
        agentRationale: "Source carries {player}; draft drops the placeholder entirely.",
      },
    ],
    "semantic-drift": [],
    "tone-register": [],
    "unresolved-terminology": [
      {
        findingId: "019ed079-0000-7000-8000-000fa0000006",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "major",
        category: "glossary-conflict",
        evidenceRefs: [`glossary:${FIXTURE_GLOSSARY_TERM_ID}`],
        recommendation: "Use 'hero' per glossary.",
        agentRationale: "Draft renders 勇者 as 'warrior', contradicting glossary.",
      },
    ],
  },
};

// Fresh-judge bundle for the regrade-trigger fixture only. The fresh
// judge:
//   - CONFIRMS the original's critical protected-span finding (same
//     shape, different findingId);
//   - DISPUTES the original's glossary-conflict finding (the fresh
//     judge does NOT see it as a glossary conflict);
//   - DISCOVERS a NEW finding the original missed: a semantic-drift
//     mistranslation on unit B (the original's drafts agent never
//     flagged it).
const FRESH_JUDGE_BUNDLES = {
  "calibration-regrade-trigger": {
    "style-adherence": [
      {
        findingId: "019ed079-0000-7000-8000-000fb0000001",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "critical",
        category: "protected-span-violation",
        evidenceRefs: ["style-guide:protected-spans-001"],
        recommendation:
          "Restore the {player} placeholder — fresh-judge confirms the protected-span loss.",
        agentRationale: "Fresh judge: {player} is in the source but missing from the draft.",
      },
    ],
    "semantic-drift": [
      {
        findingId: "019ed079-0000-7000-8000-000fb0000002",
        bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
        severity: "major",
        category: "mistranslation",
        evidenceRefs: ["scene-summary:scene-calibration"],
        recommendation:
          "Fresh-judge new finding: 'bowed deeply' loses 一礼 nuance — adjust phrasing.",
        agentRationale:
          "Fresh judge flags a semantic nuance loss the original missed: 一礼 (single bow) is rendered as 'bowed deeply', changing the formality marker.",
      },
    ],
    "tone-register": [],
    "unresolved-terminology": [],
  },
};

function writeBundle(authority, fixtureId, agentName, findings) {
  const dir = resolve(BUNDLES_DIR, authority);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${fixtureId}.${agentName}.json`);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    fixtureId,
    agentName,
    authority,
    findings,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

for (const [fixtureId, byAgent] of Object.entries(ORIGINAL_BUNDLES)) {
  for (const [agentName, findings] of Object.entries(byAgent)) {
    writeBundle("original", fixtureId, agentName, findings);
  }
}
for (const [fixtureId, byAgent] of Object.entries(FRESH_JUDGE_BUNDLES)) {
  for (const [agentName, findings] of Object.entries(byAgent)) {
    writeBundle("fresh-judge", fixtureId, agentName, findings);
  }
}

const totalOriginal = Object.values(ORIGINAL_BUNDLES).reduce(
  (sum, byAgent) => sum + Object.keys(byAgent).length,
  0,
);
const totalFresh = Object.values(FRESH_JUDGE_BUNDLES).reduce(
  (sum, byAgent) => sum + Object.keys(byAgent).length,
  0,
);
console.log(`generated ${totalOriginal} original + ${totalFresh} fresh-judge calibration bundles`);
