// The roster manifest — EXACTLY nineteen specialists, each a casting of one of
// the three shapes, every one resolving to the certified deepseek-v4-flash profile.
//
// The manifest is validated at module load: the set of roles must be exactly
// A1-A10, P1-P3, and Q1-Q6. A missing role or a duplicate FAILS. The default
// selection is the WHOLE roster — production and pilot run the full house.
//
// The labor is divided by prompt, tool grant, and chaining position, not by new
// machinery: a Style Lead and a Continuity Keeper are both the analyst shape
// with different instructions, tools, granularity, and DAG position.

import {
  CallLimitsSchema,
  ReasoningPolicySchema,
  RoleIdSchema,
  ToolNameSchema,
  WikiObjectKindSchema,
  type RoleId,
} from "../contracts/index.js";
import {
  deepSeekV4FlashProfile,
  uncertifiedRoleModelProfileCandidateForProbe,
} from "../llm/role-model-profiles.js";
import {
  DAG_STAGES,
  GRANULARITIES,
  defineSpecialist,
  expectedShapeForRole,
  toolsForRole,
  type Specialist,
  type SpecialistDeclaration,
} from "./specialist.js";
import { shapeContract } from "./shapes.js";

export const ROSTER_MANIFEST_VERSION = "itotori.roster-manifest.v1" as const;

/** The 19-role universe, in canonical order. */
export const ROLE_ID_UNIVERSE: readonly RoleId[] = Object.freeze([...RoleIdSchema.options]);

/** Every role resolves to this one profile key — no provider, no role classes. */
const MODEL_PROFILE_KEY = deepSeekV4FlashProfile.profileId;

const DEEP: SpecialistDeclaration["reasoning"] = { effort: "high" };
const DEEP_LIMITS: SpecialistDeclaration["limits"] = {
  maxSteps: 4,
  maxToolCalls: 8,
  maxParallelTools: 4,
  maxOutputTokens: 16_384,
  timeoutClass: "deep",
};

const DECLARATIONS: readonly SpecialistDeclaration[] = [
  // ── Pre-production: the analyst castings ──────────────────────────────────
  {
    roleId: "A1",
    shape: "analyst",
    version: "itotori.role.A1.v1",
    instructions:
      "Style Lead. Synthesize one coherent source-language style contract (register, honorific policy, name order, profanity ceiling, punctuation, audience) from a representative decode slice and the operator brief. Cite evidence; decide nothing the decode already fixes.",
    granularity: "per-game",
    wikiObjectKind: "style-contract",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: {
      stage: "pre-production",
      upstream: [],
      downstream: ["A2", "A6", "P1", "P2", "P3"],
    },
  },
  {
    roleId: "A2",
    shape: "analyst",
    version: "itotori.role.A2.v2",
    instructions:
      "Terminology Analyst. Treat the deterministic whole-game term, alias, occurrence, and conflict index as ground truth. Author only PROVISIONAL source-language term-ruling WikiObjects for its ambiguous candidates, with meaning, register, source scope, confidence, and real same-snapshot occurrence citations. Never enumerate terms, aliases, or occurrences; never invent a target form.",
    granularity: "per-term",
    wikiObjectKind: "term-ruling",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: {
      stage: "pre-production",
      upstream: ["A1"],
      downstream: ["P1", "P2", "P3", "Q3"],
    },
  },
  {
    roleId: "A3",
    shape: "analyst",
    version: "itotori.role.A3.v1",
    instructions:
      "Scene Analyst. Read one complete scene and fold the prior accepted story-so-far forward into a cited scene summary and updated story-so-far. Compress meaning, subtext, and beat; never restate decoded counts or speakers.",
    granularity: "per-scene",
    wikiObjectKind: "scene-summary",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: [], downstream: ["A4", "A5", "A7", "P1"] },
  },
  {
    roleId: "A4",
    shape: "analyst",
    version: "itotori.role.A4.v1",
    instructions:
      "Continuity and Lore Reconciler. Adopt the final story-so-far as the route spine and emit route-arc, callback, foreshadow, and relationship-delta claims with paired endpoint citations. Origins precede callbacks; never reconstruct topology.",
    granularity: "per-route",
    wikiObjectKind: "route-arc",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: ["A3"], downstream: ["A9", "P1", "Q4"] },
    reasoning: DEEP,
    limits: DEEP_LIMITS,
  },
  {
    roleId: "A5",
    shape: "analyst",
    version: "itotori.role.A5.v1",
    instructions:
      "Granular Voice Director. Emit voice profiles addressable by character, counterpart, route, and arc-position range, with base register, forms, modulation, and citations. No per-character-only fallback may overwrite a more specific rule.",
    granularity: "per-character-route",
    wikiObjectKind: "voice-profile",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: {
      stage: "pre-production",
      upstream: ["A3", "A4", "A8", "A9"],
      downstream: ["P1", "Q2"],
    },
  },
  {
    roleId: "A6",
    shape: "analyst",
    version: "itotori.role.A6.v1",
    instructions:
      "Cultural Adaptation Analyst. Run across the deterministically flagged culture, wordplay, dialect, and honorific candidates and emit cited adaptation notes describing communicative function and bounded options. Never fan out per line or ship a replacement translation.",
    granularity: "per-unit",
    wikiObjectKind: "adaptation-note",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: ["A1", "A2"], downstream: ["P1", "P3"] },
  },
  {
    roleId: "A7",
    shape: "analyst",
    version: "itotori.role.A7.v1",
    instructions:
      "Character Biographer. Emit one source-language character bio with cited whole-game evidence for every character in the deterministic index. Local facts are high confidence; optional web claims are distinct and no higher than medium.",
    granularity: "per-character",
    wikiObjectKind: "character-bio",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: ["A3"], downstream: ["A8", "A10"] },
  },
  {
    roleId: "A8",
    shape: "analyst",
    version: "itotori.role.A8.v1",
    instructions:
      "Relationships and Background Analyst. Emit character-background objects with real counterpart ids and claim-level global/route/route-set relationship scope. Every relationship cites an establishing same-game scene; scope is route-reachable.",
    granularity: "per-character-pair",
    wikiObjectKind: "character-background",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: ["A3", "A7"], downstream: ["A5", "A9"] },
  },
  {
    roleId: "A9",
    shape: "analyst",
    version: "itotori.role.A9.v1",
    instructions:
      "Character-in-Route Arc Analyst. Fan out for every deterministic character-by-route intersection and emit route-scoped character-route-arc objects whose state shifts carry from/to play-order ranges and citations. Skip no minor character.",
    granularity: "per-character-route",
    wikiObjectKind: "character-route-arc",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: ["A4", "A8"], downstream: ["A5", "Q4"] },
  },
  {
    roleId: "A10",
    shape: "analyst",
    version: "itotori.role.A10.v1",
    instructions:
      "Hindsight Speaker Resolver. Examine only truly parser-unknown units against full-route hindsight and emit cited speaker-hypothesis objects with candidate, confidence, reveal scene, and scope. Structurally unable to write a decoded speaker; refuse known speakers.",
    granularity: "per-unit",
    wikiObjectKind: "speaker-hypothesis",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "pre-production", upstream: ["A4", "A7"], downstream: ["P1"] },
  },

  // ── Production: the localizer castings ────────────────────────────────────
  {
    roleId: "P1",
    shape: "localizer",
    version: "itotori.role.P1.v1",
    instructions:
      "Whole-Scene Localizer. Read exact source skeletons, localized-bible entries, and accepted target dialogue through the granted local tools, then realize a complete scene or measured overlapping chunk into target skeletons. Emit only provisional translation WikiObjects with cited source claims and localization provenance. Deterministic source facts, protected placeholders, cardinality, order, and source hashes dominate every judgment; type every uncertainty. Never infer markup, speaker, or choice topology.",
    granularity: "per-batch",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: {
      stage: "production",
      upstream: ["A1", "A2", "A3", "A4", "A5", "A6", "A10"],
      downstream: ["Q1", "Q2", "Q3", "Q4", "Q5"],
    },
  },
  {
    roleId: "P2",
    shape: "localizer",
    version: "itotori.role.P2.v1",
    instructions:
      "Line Editor. Continue the author thread for minor style, format, and voice repairs given the current draft and the exact changed basis. Return patches only for implicated ids and spans; preserve meaning and unaffected bytes; never blind-retranslate.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "production", upstream: ["P1"], downstream: ["Q1", "Q2", "Q3"] },
  },
  {
    roleId: "P3",
    shape: "localizer",
    version: "itotori.role.P3.v1",
    instructions:
      "Semantic Repair. A fresh blinded grounded fork for material meaning defects. Given pre-draft context, the current candidate, and the exact failing spans and constraints, emit minimal patches for the failed ids only. Bounded to one repair before adjudication.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "production", upstream: ["A6", "P1", "Q1"], downstream: ["Q1"] },
  },

  // ── QA: the reviewer castings ─────────────────────────────────────────────
  {
    roleId: "Q1",
    shape: "reviewer",
    version: "itotori.role.Q1.v1",
    instructions:
      "Meaning Reviewer. Judge meaning preservation only, blinded to author identity, over source facts, the candidate, the localized bible, neighbor windows, and an optional back-translation signal. Emit strict PASS/FAIL/CANNOT_ASSESS; CANNOT_ASSESS never passes.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "qa", upstream: ["P1", "P3"], downstream: ["Q6"] },
  },
  {
    roleId: "Q2",
    shape: "reviewer",
    version: "itotori.role.Q2.v1",
    instructions:
      "Voice Reviewer. Judge only voice and register continuity against the localized voice bible and the speaker's accepted target history at the exact counterpart, route, and play position. Meaning and engine faults are outside the rubric.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "qa", upstream: ["A5", "P1"], downstream: ["Q6"] },
  },
  {
    roleId: "Q3",
    shape: "reviewer",
    version: "itotori.role.Q3.v1",
    instructions:
      "Terminology Auditor. Run only after the exact glossary and name gate; judge contextual sense and register of approved forms or a genuinely new ambiguous coinage. Emit a cited candidate back for a ruling; never approve a contradictory target form.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "qa", upstream: ["A2", "P1"], downstream: ["A2", "Q6"] },
  },
  {
    roleId: "Q4",
    shape: "reviewer",
    version: "itotori.role.Q4.v1",
    instructions:
      "Continuity Reviewer. Judge only callback, foreshadow, relationship, and route-arc consistency against the localized route and character bible and accepted origin translations. Cite both real endpoints; deterministic play order proves the origin precedes the use.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "qa", upstream: ["A4", "A9", "P1"], downstream: ["Q6"] },
  },
  {
    roleId: "Q5",
    shape: "reviewer",
    version: "itotori.role.Q5.v1",
    instructions:
      "Build-LQA Reviewer. Given a real patched-byte frame, the expected target, the localized bible, and prior deterministic render facts, judge residual translation-quality-on-screen only. Engine, glyph, charset, overflow, and replay faults route to deterministic gates.",
    granularity: "per-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "qa", upstream: ["P1"], downstream: [] },
  },
  {
    roleId: "Q6",
    shape: "reviewer",
    version: "itotori.role.Q6.v1",
    instructions:
      "Adjudicator. Resolve one genuine subjective conflict after facts have settled, blinded, seeing both verdicts and evidence. Run A/B and B/A ordering; emit one binding verdict or a human-escalation artifact. Bounded to one adjudication.",
    granularity: "per-contested-unit",
    wikiObjectKind: "translation",
    modelProfileKey: MODEL_PROFILE_KEY,
    dagPosition: { stage: "qa", upstream: ["Q1", "Q2", "Q3", "Q4"], downstream: [] },
    reasoning: DEEP,
    limits: DEEP_LIMITS,
  },
];

/**
 * Validate that a set of specialists is EXACTLY the 19-role roster — each role
 * present exactly once, no role missing, no role duplicated — and return them
 * keyed by role. A missing or extra role throws.
 */
export function validateRosterManifest(
  specialists: readonly Specialist[],
): Readonly<Record<RoleId, Specialist>> {
  const byRole = new Map<RoleId, Specialist>();
  for (const specialist of specialists) {
    const parsedRoleId = RoleIdSchema.safeParse(specialist?.roleId);
    if (!parsedRoleId.success) {
      throw new Error(`roster manifest has unexpected role: ${String(specialist?.roleId)}`);
    }
    if (byRole.has(parsedRoleId.data)) {
      throw new Error(`roster manifest has a duplicate role: ${parsedRoleId.data}`);
    }
    byRole.set(parsedRoleId.data, specialist);
  }
  const missing = ROLE_ID_UNIVERSE.filter((roleId) => !byRole.has(roleId));
  if (missing.length > 0) {
    throw new Error(`roster manifest is missing roles: ${missing.join(", ")}`);
  }
  const extra = [...byRole.keys()].filter((roleId) => !ROLE_ID_UNIVERSE.includes(roleId));
  if (extra.length > 0) {
    throw new Error(`roster manifest has unexpected roles: ${extra.join(", ")}`);
  }
  if (byRole.size !== ROLE_ID_UNIVERSE.length) {
    throw new Error(
      `roster manifest must contain exactly ${ROLE_ID_UNIVERSE.length} roles, found ${byRole.size}`,
    );
  }
  for (const roleId of ROLE_ID_UNIVERSE) {
    validateSpecialistContract(roleId, byRole.get(roleId)!);
  }
  const entries = ROLE_ID_UNIVERSE.map((roleId) => [roleId, byRole.get(roleId)!] as const);
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<RoleId, Specialist>>;
}

/**
 * Validate the complete runtime contract of one entry, not only its ID. Types
 * vanish at the process boundary, so accepting an array cast through `unknown`
 * must not let an incomplete role manifest reach dispatch. This also executes
 * each role's semantic validator against malformed output, proving the
 * validator is live rather than a decorative field.
 */
function validateSpecialistContract(roleId: RoleId, specialist: Specialist): void {
  const candidate = specialist as unknown as Record<string, unknown>;
  if (typeof specialist !== "object" || specialist === null || !Object.isFrozen(specialist)) {
    throw new Error(`roster specialist ${roleId} must be immutable data`);
  }
  if (candidate.roleId !== roleId) {
    throw new Error(`roster specialist key ${roleId} does not match its role id`);
  }
  if (typeof candidate.version !== "string" || candidate.version.trim().length === 0) {
    throw new Error(`roster specialist ${roleId} has no version`);
  }
  if (typeof candidate.instructions !== "string" || candidate.instructions.trim().length === 0) {
    throw new Error(`roster specialist ${roleId} has no instructions`);
  }

  const expectedShape = expectedShapeForRole(roleId);
  if (candidate.shape !== expectedShape) {
    throw new Error(`roster specialist ${roleId} must use the ${expectedShape} profile shape`);
  }
  const contract = shapeContract(expectedShape);
  if (candidate.input !== contract.input || candidate.output !== contract.output) {
    throw new Error(`roster specialist ${roleId} must use its shape's strict input/output schemas`);
  }

  const expectedTools = toolsForRole(roleId);
  if (
    !Array.isArray(candidate.tools) ||
    !Object.isFrozen(candidate.tools) ||
    candidate.tools.length !== expectedTools.length ||
    candidate.tools.some(
      (tool, index) => !ToolNameSchema.safeParse(tool).success || tool !== expectedTools[index],
    )
  ) {
    throw new Error(`roster specialist ${roleId} tool allowlist does not match RB-025`);
  }

  if (!GRANULARITIES.includes(candidate.granularity as (typeof GRANULARITIES)[number])) {
    throw new Error(`roster specialist ${roleId} has an invalid granularity`);
  }
  if (!WikiObjectKindSchema.safeParse(candidate.wikiObjectKind).success) {
    throw new Error(`roster specialist ${roleId} has an invalid WikiObject kind`);
  }

  const dagPosition = candidate.dagPosition;
  if (
    typeof dagPosition !== "object" ||
    dagPosition === null ||
    !Object.isFrozen(dagPosition) ||
    !DAG_STAGES.includes((dagPosition as { stage?: unknown }).stage as (typeof DAG_STAGES)[number])
  ) {
    throw new Error(`roster specialist ${roleId} has an invalid DAG position`);
  }
  for (const edge of [
    (dagPosition as { upstream?: unknown }).upstream,
    (dagPosition as { downstream?: unknown }).downstream,
  ]) {
    if (
      !Array.isArray(edge) ||
      !Object.isFrozen(edge) ||
      edge.some((dependency) => !RoleIdSchema.safeParse(dependency).success) ||
      new Set(edge).size !== edge.length
    ) {
      throw new Error(`roster specialist ${roleId} has invalid DAG dependencies`);
    }
  }

  const resolved = uncertifiedRoleModelProfileCandidateForProbe(roleId);
  if (
    candidate.modelProfileKey !== resolved.profileId ||
    candidate.modelProfile !== resolved.modelProfile ||
    candidate.resolvedModel !== resolved.model ||
    resolved.model !== deepSeekV4FlashProfile.model ||
    !contract.callProfiles.includes(resolved.modelProfile)
  ) {
    throw new Error(
      `roster specialist ${roleId} does not resolve through its RB-019 model profile`,
    );
  }
  if (
    !ReasoningPolicySchema.safeParse(candidate.reasoning).success ||
    !CallLimitsSchema.safeParse(candidate.limits).success ||
    !Object.isFrozen(candidate.reasoning as object) ||
    !Object.isFrozen(candidate.limits as object)
  ) {
    throw new Error(`roster specialist ${roleId} has invalid immutable call limits`);
  }

  if (typeof candidate.validate !== "function") {
    throw new Error(`roster specialist ${roleId} has no semantic validator`);
  }
  let semanticIssues: unknown;
  try {
    semanticIssues = candidate.validate(undefined);
  } catch {
    throw new Error(`roster specialist ${roleId} semantic validator must handle malformed output`);
  }
  if (
    !Array.isArray(semanticIssues) ||
    semanticIssues.length === 0 ||
    semanticIssues.some(
      (issue) =>
        typeof issue !== "object" ||
        issue === null ||
        typeof (issue as { path?: unknown }).path !== "string" ||
        typeof (issue as { message?: unknown }).message !== "string",
    )
  ) {
    throw new Error(`roster specialist ${roleId} semantic validator is not strict`);
  }
}

/** The validated, immutable roster — exactly the 19 specialists. */
export const ROSTER: Readonly<Record<RoleId, Specialist>> = validateRosterManifest(
  DECLARATIONS.map(defineSpecialist),
);

/** Production and pilot default to the WHOLE roster. */
export const DEFAULT_ROSTER_SELECTION: readonly RoleId[] = ROLE_ID_UNIVERSE;

/** All 19 specialists in canonical role order. */
export const ROSTER_SPECIALISTS: readonly Specialist[] = Object.freeze(
  ROLE_ID_UNIVERSE.map((roleId) => ROSTER[roleId]),
);

/** Resolve a specialist by role, or throw for an unknown role. */
export function specialistFor(roleId: RoleId): Specialist {
  const specialist = ROSTER[RoleIdSchema.parse(roleId)];
  if (!specialist) throw new Error(`no specialist for role ${roleId}`);
  return specialist;
}
