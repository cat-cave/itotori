// ITOTORI-021 — Calibration fixtures for the scored-finding workflow.
//
// Each fixture is a (draft, expected-agent-findings) pair whose expected
// score sits in a declared, narrow range. The fixtures double as:
//
//   1. Calibration tests — drive the workflow end-to-end and assert the
//      derived score lands inside the declared range.
//   2. Regression guards — score-formula drift produces test failures.
//   3. Recorded-bundle authority — each fixture pairs with a JSON
//      bundle under `recorded-bundles/` keyed off the deterministic
//      prompt hash for each focused agent.
//
// The fixtures intentionally cover ONE flaw per known-bad draft so the
// per-agent-lane property is testable: only the correct focused agent
// should produce findings.

import type {
  QaFinding,
  QaFindingCategory,
  QaFindingSeverity,
} from "@itotori/localization-bridge-schema";
import type {
  QaBridgeUnit,
  QaGlossaryEntry,
  QaInvocationInput,
  QaModelProfile,
  QaStyleGuideRule,
} from "../agents/qa/shapes.js";
import type { FocusedQaAgentName } from "../agents/qa/agents/index.js";

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

/**
 * One calibration fixture: a draft + (per focused agent) expected
 * findings + the score range we expect the workflow to land in.
 */
export type CalibrationFixture = {
  fixtureId: string;
  description: string;
  units: QaBridgeUnit[];
  glossary: QaGlossaryEntry[];
  styleGuide: QaStyleGuideRule[];
  sourceLocale: string;
  targetLocale: string;
  modelProfile: QaModelProfile;
  /**
   * Expected findings keyed by focused agent. Agents not listed are
   * expected to return zero findings. The recorded-bundle authority for
   * the test runs the focused agent against a bundle that produces
   * exactly these findings.
   */
  expectedFindings: ReadonlyMap<FocusedQaAgentName, QaFinding[]>;
  expectedScores: {
    overallMin: number;
    overallMax: number;
    perAgent: ReadonlyMap<FocusedQaAgentName, { min: number; max: number }>;
  };
};

// ---------------------------------------------------------------------------
// Constants (stable ids, locales, model profile)
// ---------------------------------------------------------------------------

const FIXTURE_PROJECT_ID = "019ed079-0000-7000-8000-000000c00001";
const FIXTURE_LOCALE_BRANCH_ID = "019ed079-0000-7000-8000-000000c00002";
const FIXTURE_SOURCE_REVISION_ID = "019ed079-0000-7000-8000-000000c00003";
const FIXTURE_DRAFT_JOB_ID_BASE = "019ed079-0000-7000-8000-000000c10";

const FIXTURE_BRIDGE_UNIT_ID_A = "019ed079-0000-7000-8000-000000ca0001";
const FIXTURE_BRIDGE_UNIT_ID_B = "019ed079-0000-7000-8000-000000ca0002";
const FIXTURE_BRIDGE_UNIT_ID_C = "019ed079-0000-7000-8000-000000ca0003";

const FIXTURE_GLOSSARY_TERM_ID = "019ed079-0000-7000-8000-000000cb0001";

const FIXTURE_MODEL_PROFILE: QaModelProfile = {
  providerFamily: "openrouter",
  modelId: "openrouter:itotori-qa-calibration-v1",
  // ITOTORI-220 — pinned provider for the original calibration authority.
  providerId: "anthropic",
  contextWindowTokens: 16000,
  maxOutputTokens: 1024,
};

const FIXTURE_FRESH_JUDGE_MODEL_PROFILE: QaModelProfile = {
  providerFamily: "openrouter",
  modelId: "openrouter:itotori-qa-calibration-fresh-judge-v1",
  // ITOTORI-220 — different upstream provider so the fresh-judge regrade
  // is independent at both the model and provider level.
  providerId: "google-vertex",
  contextWindowTokens: 16000,
  maxOutputTokens: 1024,
};

const FIXTURE_GLOSSARY: QaGlossaryEntry[] = [
  {
    termId: FIXTURE_GLOSSARY_TERM_ID,
    preferredSourceForm: "勇者",
    preferredTargetForm: "hero",
    policyAction: "localize",
  },
];

const FIXTURE_STYLE_GUIDE: QaStyleGuideRule[] = [
  {
    ruleId: "tone-formal-001",
    section: "tone",
    guidance: "Use a consistent formal register across the scene.",
  },
  {
    ruleId: "protected-spans-001",
    section: "protectedSpans",
    guidance: "Preserve every placeholder verbatim.",
  },
];

// Three canonical units used by every fixture so the recorded bundles
// can share a citation surface across known-good and known-bad cases.
const FIXTURE_UNITS_KNOWN_GOOD: QaBridgeUnit[] = [
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_A,
    sourceUnitKey: "scene.calibration.line.001",
    sourceText: "こんにちは、{player}さん。",
    sourceHash: "calibration-src-1",
    draftText: "Hello, {player}.",
    draftHash: "calibration-drf-1",
    speaker: "narration",
  },
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
    sourceUnitKey: "scene.calibration.line.002",
    sourceText: "勇者は王様に深く一礼した。",
    sourceHash: "calibration-src-2",
    draftText: "The hero bowed deeply to the king.",
    draftHash: "calibration-drf-2",
    speaker: "narration",
  },
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_C,
    sourceUnitKey: "scene.calibration.line.003",
    sourceText: "魔王城の門が開いた。",
    sourceHash: "calibration-src-3",
    draftText: "The gates of the demon castle opened.",
    draftHash: "calibration-drf-3",
    speaker: "narration",
  },
];

// Variants with a single intentional flaw per fixture.
const FIXTURE_UNITS_STYLE_VIOLATION: QaBridgeUnit[] = [
  FIXTURE_UNITS_KNOWN_GOOD[0]!,
  // Unit B drops the {player} placeholder — protected-span violation.
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
    sourceUnitKey: "scene.calibration.line.002",
    sourceText: "{player}は王様に深く一礼した。",
    sourceHash: "calibration-src-2-style",
    draftText: "The hero bowed deeply to the king.",
    draftHash: "calibration-drf-2-style",
    speaker: "narration",
  },
  FIXTURE_UNITS_KNOWN_GOOD[2]!,
];

const FIXTURE_UNITS_SEMANTIC_DRIFT: QaBridgeUnit[] = [
  FIXTURE_UNITS_KNOWN_GOOD[0]!,
  // Unit B silently adds "and the queen" — addition / semantic drift.
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
    sourceUnitKey: "scene.calibration.line.002",
    sourceText: "勇者は王様に深く一礼した。",
    sourceHash: "calibration-src-2",
    draftText: "The hero bowed deeply to the king and the queen.",
    draftHash: "calibration-drf-2-semantic",
    speaker: "narration",
  },
  FIXTURE_UNITS_KNOWN_GOOD[2]!,
];

const FIXTURE_UNITS_TONE_SHIFT: QaBridgeUnit[] = [
  FIXTURE_UNITS_KNOWN_GOOD[0]!,
  // Unit B drops to casual register mid-scene — tone shift.
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
    sourceUnitKey: "scene.calibration.line.002",
    sourceText: "勇者は王様に深く一礼した。",
    sourceHash: "calibration-src-2",
    draftText: "the hero kinda just bowed at the king lol.",
    draftHash: "calibration-drf-2-tone",
    speaker: "narration",
  },
  FIXTURE_UNITS_KNOWN_GOOD[2]!,
];

const FIXTURE_UNITS_TERMINOLOGY_MISS: QaBridgeUnit[] = [
  FIXTURE_UNITS_KNOWN_GOOD[0]!,
  // Unit B renders 勇者 as 'warrior' — glossary conflict with 'hero'.
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
    sourceUnitKey: "scene.calibration.line.002",
    sourceText: "勇者は王様に深く一礼した。",
    sourceHash: "calibration-src-2",
    draftText: "The warrior bowed deeply to the king.",
    draftHash: "calibration-drf-2-terminology",
    speaker: "narration",
  },
  FIXTURE_UNITS_KNOWN_GOOD[2]!,
];

// ---------------------------------------------------------------------------
// Finding factories per fixture
// ---------------------------------------------------------------------------

function makeFinding(args: {
  findingId: string;
  bridgeUnitId: string;
  severity: QaFindingSeverity;
  category: QaFindingCategory;
  recommendation: string;
  agentRationale: string;
  evidenceRefs: string[];
}): QaFinding {
  return {
    findingId: args.findingId,
    bridgeUnitId: args.bridgeUnitId,
    severity: args.severity,
    category: args.category,
    evidenceRefs: args.evidenceRefs,
    recommendation: args.recommendation,
    agentRationale: args.agentRationale,
  };
}

// ---------------------------------------------------------------------------
// Public fixtures
// ---------------------------------------------------------------------------

export const KNOWN_GOOD_FIXTURE: CalibrationFixture = {
  fixtureId: "calibration-known-good",
  description:
    "Draft preserves placeholders, glossary, semantics, and tone across all units; every focused agent should emit zero findings.",
  units: FIXTURE_UNITS_KNOWN_GOOD,
  glossary: FIXTURE_GLOSSARY,
  styleGuide: FIXTURE_STYLE_GUIDE,
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  modelProfile: FIXTURE_MODEL_PROFILE,
  expectedFindings: new Map(),
  expectedScores: {
    overallMin: 0.95,
    overallMax: 1.0,
    perAgent: new Map([
      ["style-adherence", { min: 0.95, max: 1.0 }],
      ["semantic-drift", { min: 0.95, max: 1.0 }],
      ["tone-register", { min: 0.95, max: 1.0 }],
      ["unresolved-terminology", { min: 0.95, max: 1.0 }],
    ]),
  },
};

export const STYLE_VIOLATION_FIXTURE: CalibrationFixture = {
  fixtureId: "calibration-style-violation",
  description:
    "Unit B drops a {player} placeholder; only the style-adherence agent should flag it.",
  units: FIXTURE_UNITS_STYLE_VIOLATION,
  glossary: FIXTURE_GLOSSARY,
  styleGuide: FIXTURE_STYLE_GUIDE,
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  modelProfile: FIXTURE_MODEL_PROFILE,
  expectedFindings: new Map<FocusedQaAgentName, QaFinding[]>([
    [
      "style-adherence",
      [
        makeFinding({
          findingId: "019ed079-0000-7000-8000-000fa0000001",
          bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
          severity: "critical",
          category: "protected-span-violation",
          evidenceRefs: ["style-guide:protected-spans-001"],
          recommendation: "Restore the {player} placeholder before exporting the draft.",
          agentRationale:
            "Source carries the {player} placeholder; draft omits it entirely, breaking the protected-span contract.",
        }),
      ],
    ],
  ]),
  // Unit B → 1 critical → score 0.0; unit A and unit C → 1.0; mean per
  // agent that rated only unit B → 0.0. Overall mean across 4 agents is
  // (0 + 1 + 1 + 1) / 4 = 0.75.
  expectedScores: {
    overallMin: 0.7,
    overallMax: 0.8,
    perAgent: new Map([
      ["style-adherence", { min: 0.0, max: 0.05 }],
      ["semantic-drift", { min: 0.95, max: 1.0 }],
      ["tone-register", { min: 0.95, max: 1.0 }],
      ["unresolved-terminology", { min: 0.95, max: 1.0 }],
    ]),
  },
};

export const SEMANTIC_DRIFT_FIXTURE: CalibrationFixture = {
  fixtureId: "calibration-semantic-drift",
  description:
    "Unit B's draft silently adds 'and the queen'; only the semantic-drift agent should flag it.",
  units: FIXTURE_UNITS_SEMANTIC_DRIFT,
  glossary: FIXTURE_GLOSSARY,
  styleGuide: FIXTURE_STYLE_GUIDE,
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  modelProfile: FIXTURE_MODEL_PROFILE,
  expectedFindings: new Map<FocusedQaAgentName, QaFinding[]>([
    [
      "semantic-drift",
      [
        makeFinding({
          findingId: "019ed079-0000-7000-8000-000fa0000002",
          bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
          severity: "major",
          category: "mistranslation",
          evidenceRefs: ["scene-summary:scene-calibration"],
          recommendation: "Remove 'and the queen' — the source bows only to the king.",
          agentRationale:
            "Source references only the king; the draft adds the queen as a second target, changing the propositional content.",
        }),
      ],
    ],
  ]),
  // major → weight 0.5 → unit B score 0.5; unit A/C → 1.0;
  // semantic-drift's per-agent score = 0.5 (mean over rated unit set = {B})
  // overall = (1 + 0.5 + 1 + 1) / 4 = 0.875.
  expectedScores: {
    overallMin: 0.8,
    overallMax: 0.95,
    perAgent: new Map([
      ["style-adherence", { min: 0.95, max: 1.0 }],
      ["semantic-drift", { min: 0.45, max: 0.55 }],
      ["tone-register", { min: 0.95, max: 1.0 }],
      ["unresolved-terminology", { min: 0.95, max: 1.0 }],
    ]),
  },
};

export const TONE_SHIFT_FIXTURE: CalibrationFixture = {
  fixtureId: "calibration-tone-shift",
  description:
    "Unit B's draft uses casual register mid-scene where formal is required; only the tone-register agent should flag it.",
  units: FIXTURE_UNITS_TONE_SHIFT,
  glossary: FIXTURE_GLOSSARY,
  styleGuide: FIXTURE_STYLE_GUIDE,
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  modelProfile: FIXTURE_MODEL_PROFILE,
  expectedFindings: new Map<FocusedQaAgentName, QaFinding[]>([
    [
      "tone-register",
      [
        makeFinding({
          findingId: "019ed079-0000-7000-8000-000fa0000003",
          bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
          severity: "major",
          category: "tone",
          evidenceRefs: ["style-guide:tone-formal-001"],
          recommendation: "Rewrite using the formal register established by units 1 and 3.",
          agentRationale:
            "Draft switches to casual register mid-scene ('kinda just bowed', 'lol'), violating the tone-formal-001 style guide.",
        }),
      ],
    ],
  ]),
  expectedScores: {
    overallMin: 0.8,
    overallMax: 0.95,
    perAgent: new Map([
      ["style-adherence", { min: 0.95, max: 1.0 }],
      ["semantic-drift", { min: 0.95, max: 1.0 }],
      ["tone-register", { min: 0.45, max: 0.55 }],
      ["unresolved-terminology", { min: 0.95, max: 1.0 }],
    ]),
  },
};

export const TERMINOLOGY_MISS_FIXTURE: CalibrationFixture = {
  fixtureId: "calibration-terminology-miss",
  description:
    "Unit B renders 勇者 as 'warrior' instead of glossary's 'hero'; only the unresolved-terminology agent should flag it.",
  units: FIXTURE_UNITS_TERMINOLOGY_MISS,
  glossary: FIXTURE_GLOSSARY,
  styleGuide: FIXTURE_STYLE_GUIDE,
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  modelProfile: FIXTURE_MODEL_PROFILE,
  expectedFindings: new Map<FocusedQaAgentName, QaFinding[]>([
    [
      "unresolved-terminology",
      [
        makeFinding({
          findingId: "019ed079-0000-7000-8000-000fa0000004",
          bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
          severity: "major",
          category: "glossary-conflict",
          evidenceRefs: [`glossary:${FIXTURE_GLOSSARY_TERM_ID}`],
          recommendation:
            "Use the glossary's preferred target form 'hero' for 勇者 instead of 'warrior'.",
          agentRationale:
            "Glossary maps 勇者 → hero (policyAction=localize); the draft renders it as 'warrior'.",
        }),
      ],
    ],
  ]),
  expectedScores: {
    overallMin: 0.8,
    overallMax: 0.95,
    perAgent: new Map([
      ["style-adherence", { min: 0.95, max: 1.0 }],
      ["semantic-drift", { min: 0.95, max: 1.0 }],
      ["tone-register", { min: 0.95, max: 1.0 }],
      ["unresolved-terminology", { min: 0.45, max: 0.55 }],
    ]),
  },
};

/**
 * A draft so flawed it triggers the fresh-judge regrade. Unit B carries
 * a critical protected-span violation AND a major glossary conflict; the
 * overall score drops below the default regrade threshold (0.7).
 */
const FIXTURE_UNITS_REGRADE_TRIGGER: QaBridgeUnit[] = [
  FIXTURE_UNITS_KNOWN_GOOD[0]!,
  {
    bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
    sourceUnitKey: "scene.calibration.line.002",
    sourceText: "{player}と勇者は王様に深く一礼した。",
    sourceHash: "calibration-src-2-regrade",
    draftText: "The warrior bowed deeply to the king.",
    draftHash: "calibration-drf-2-regrade",
    speaker: "narration",
  },
  FIXTURE_UNITS_KNOWN_GOOD[2]!,
];

export const REGRADE_TRIGGER_FIXTURE: CalibrationFixture = {
  fixtureId: "calibration-regrade-trigger",
  description:
    "Unit B carries a critical protected-span violation (missing {player}) AND a major glossary conflict (warrior vs hero); overall score drops below the regrade threshold.",
  units: FIXTURE_UNITS_REGRADE_TRIGGER,
  glossary: FIXTURE_GLOSSARY,
  styleGuide: FIXTURE_STYLE_GUIDE,
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  modelProfile: FIXTURE_MODEL_PROFILE,
  expectedFindings: new Map<FocusedQaAgentName, QaFinding[]>([
    [
      "style-adherence",
      [
        makeFinding({
          findingId: "019ed079-0000-7000-8000-000fa0000005",
          bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
          severity: "critical",
          category: "protected-span-violation",
          evidenceRefs: ["style-guide:protected-spans-001"],
          recommendation: "Restore the {player} placeholder.",
          agentRationale: "Source carries {player}; draft drops the placeholder entirely.",
        }),
      ],
    ],
    [
      "unresolved-terminology",
      [
        makeFinding({
          findingId: "019ed079-0000-7000-8000-000fa0000006",
          bridgeUnitId: FIXTURE_BRIDGE_UNIT_ID_B,
          severity: "major",
          category: "glossary-conflict",
          evidenceRefs: [`glossary:${FIXTURE_GLOSSARY_TERM_ID}`],
          recommendation: "Use 'hero' per glossary.",
          agentRationale: "Draft renders 勇者 as 'warrior', contradicting glossary.",
        }),
      ],
    ],
  ]),
  // Unit B findings: critical (1.0) + major (0.5) = 1.5 → clamps to 0.
  // Unit A/C → 1.0.
  // style-adherence per-agent = 0; unresolved-terminology per-agent = 0;
  // semantic-drift = 1; tone-register = 1.
  // overall = (0 + 1 + 1 + 0) / 4 = 0.5. Triggers regrade.
  expectedScores: {
    overallMin: 0.45,
    overallMax: 0.55,
    perAgent: new Map([
      ["style-adherence", { min: 0.0, max: 0.05 }],
      ["semantic-drift", { min: 0.95, max: 1.0 }],
      ["tone-register", { min: 0.95, max: 1.0 }],
      ["unresolved-terminology", { min: 0.0, max: 0.05 }],
    ]),
  },
};

export const CALIBRATION_FIXTURES: ReadonlyArray<CalibrationFixture> = [
  KNOWN_GOOD_FIXTURE,
  STYLE_VIOLATION_FIXTURE,
  SEMANTIC_DRIFT_FIXTURE,
  TONE_SHIFT_FIXTURE,
  TERMINOLOGY_MISS_FIXTURE,
  REGRADE_TRIGGER_FIXTURE,
];

// ---------------------------------------------------------------------------
// Input projection
// ---------------------------------------------------------------------------

/**
 * Project a calibration fixture into the (qaPromptVersion-less) workflow
 * input. The workflow assigns the correct prompt version per focused
 * agent on invocation.
 */
export function calibrationFixtureWorkflowInput(
  fixture: CalibrationFixture,
): Omit<QaInvocationInput, "qaPromptVersion"> {
  return {
    draftJobId: `${FIXTURE_DRAFT_JOB_ID_BASE}${fixture.fixtureId.slice(-2)}`,
    projectId: FIXTURE_PROJECT_ID,
    localeBranchId: FIXTURE_LOCALE_BRANCH_ID,
    sourceRevisionId: FIXTURE_SOURCE_REVISION_ID,
    sourceLocale: fixture.sourceLocale,
    targetLocale: fixture.targetLocale,
    units: fixture.units,
    glossary: fixture.glossary,
    styleGuide: fixture.styleGuide,
    modelProfile: fixture.modelProfile,
  };
}

export const CALIBRATION_FIXTURE_FRESH_JUDGE_MODEL_PROFILE = FIXTURE_FRESH_JUDGE_MODEL_PROFILE;
