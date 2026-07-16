// Shared fixtures for the per-target localized-Wiki (bible) proofs.
//
// A minimal source Wiki (two term-ruling decisions — a glossary TERM and a
// character NAME — plus one descriptive object per bible category), a localizer
// runner that emits exactly one schema-valid rendering per step, and reviewer
// doubles that produce the reviewer-shape outputs the roster validator judges.
// The doubles stand in for best-effort model output; the proofs exercise the
// deterministic control flow around them.

import {
  LocalizedRenderingSchema,
  type LocalizedRendering,
  type RouteScope,
  type RunModeValue,
  type WikiObject,
} from "../../src/contracts/index.js";
import {
  InMemoryBibleRenderingLedger,
  orchestrateLocalizedWiki,
  type BibleStep,
  type DecisionReviewer,
  type LocalizationPosture,
  type LocalizerRunner,
  type RenderingStamp,
} from "../../src/localized-wiki/index.js";
import { sha } from "./gate-fixtures.js";

export const LOC_SNAP = sha("localization-snapshot");
export const TARGET_LANG = "en-US";
export const RUN_MODE: RunModeValue = "test-dev";
export const GLOBAL: RouteScope = { kind: "global" };

/** The target forms the localizer would decide for each ruling. */
const TARGET_FORMS: Readonly<Record<string, { preferred: string; forbidden: readonly string[] }>> =
  {
    "term-ruling:T-mother": { preferred: "Mother", forbidden: ["Mom"] },
    "term-ruling:c1": { preferred: "Aoi", forbidden: [] },
  };

/** A minimal source Wiki object (the plan reads kind/subject/id/scope/body). */
function src(
  kind: string,
  subject: WikiObject["subject"],
  objectId: string,
  scope: RouteScope,
  body: Record<string, unknown>,
): WikiObject {
  return {
    schemaVersion: "itotori.wiki-object.v1",
    objectId,
    version: 1,
    lang: "ja-JP",
    subject,
    scope,
    claims: [],
    media: [],
    dependencies: [],
    provisional: false,
    kind,
    body,
    provenance: {
      snapshotKind: "context",
      contextSnapshotId: sha("ctx"),
      contextScope: "whole-game",
      runMode: RUN_MODE,
    },
  } as unknown as WikiObject;
}

const ROUTE_R1: RouteScope = { kind: "route", routeId: "r1" };

/** The source Wiki: two decisions (a glossary TERM + a character NAME) and one
 * descriptive object for each bible category. */
export function sourceWiki(): readonly WikiObject[] {
  const char = { kind: "character", id: "c1" } as const;
  return [
    src("term-ruling", { kind: "glossary-term", id: "T-mother" }, "term-ruling:T-mother", GLOBAL, {
      termId: "T-mother",
      sourceForm: "母",
    }),
    src("term-ruling", char, "term-ruling:c1", GLOBAL, { termId: "name-c1", sourceForm: "あおい" }),
    src("style-contract", { kind: "game", id: "game-alpha" }, "style-contract:game", GLOBAL, {}),
    src("voice-profile", char, "voice-profile:c1", GLOBAL, {}),
    src("scene-summary", { kind: "scene", id: "10" }, "scene-summary:10", GLOBAL, {}),
    src("route-arc", { kind: "route", id: "r1" }, "route-arc:r1", ROUTE_R1, {}),
    src("character-route-arc", char, "character-route-arc:c1", GLOBAL, {}),
    src("adaptation-note", { kind: "unit", id: "u-10" }, "adaptation-note:u-10", GLOBAL, {}),
    src("speaker-hypothesis", { kind: "unit", id: "u-11" }, "speaker-hypothesis:u-11", GLOBAL, {}),
  ];
}

/** The localized body for one step, valid against its source kind. */
function localizedBody(step: BibleStep): Record<string, unknown> {
  const kind = step.target.sourceObjectKind;
  const scope = step.target.scope;
  if (kind === "term-ruling") {
    const forms = TARGET_FORMS[step.target.sourceObjectId] ?? { preferred: "X", forbidden: [] };
    return {
      kind,
      termId: `t-${step.target.sourceObjectId}`.replace(/[^A-Za-z0-9._:#/-]/g, "-"),
      canonicalForms: [
        { form: forms.preferred, status: "preferred", scope },
        ...forms.forbidden.map((form) => ({ form, status: "forbidden", scope })),
      ],
      registerGuidance: "neutral, warm",
    };
  }
  if (kind === "style-contract") {
    return {
      kind,
      registerGuidance: "polite by default",
      honorificGuidance: "retain -san",
      nameOrder: "source-order",
      profanityCeiling: "mild",
      punctuationRules: ["… stays …"],
    };
  }
  if (kind === "voice-profile") {
    return {
      kind,
      characterId: "c1",
      baseRegisterGuidance: "soft",
      counterpartGuidance: [],
      arcGuidance: [],
    };
  }
  if (kind === "speaker-hypothesis") {
    return { kind, displayLabel: "???", disclosureGuidance: "reveal at the confession scene" };
  }
  // prose kinds: scene-summary / story-so-far / route-arc / character-* / adaptation-note.
  return {
    kind,
    sections: [{ sectionId: "s1", heading: "summary", text: "localized prose", scope }],
  };
}

/** Build one schema-valid LocalizedRendering for a step. */
export function makeRendering(step: BibleStep, stamp: RenderingStamp): LocalizedRendering {
  return LocalizedRenderingSchema.parse({
    schemaVersion: "itotori.localized-rendering.v1",
    renderingId: `rendering:${step.target.sourceObjectId}`,
    sourceObjectId: step.target.sourceObjectId,
    sourceObjectKind: step.target.sourceObjectKind,
    targetLanguage: stamp.targetLanguage,
    version: 1,
    scope: step.target.scope,
    body: localizedBody(step),
    claimRenderings: [],
    dependencies: [],
    provenance: {
      basisSourceVersion: 1,
      localizationSnapshotId: stamp.localizationSnapshotId,
      runMode: stamp.runMode,
    },
    provisional: false,
  });
}

/** Rebuild the minimal BibleStep the rendering builder needs from a run input. */
export function stepShim(input: Parameters<LocalizerRunner>[0]): BibleStep {
  return {
    stepId: input.target.key,
    tier: input.tier,
    decisionClass: input.decisionClass,
    sourceObject: input.sourceObject,
    target: input.target,
  };
}

/** The recorded runner: exactly one valid rendering per step. */
export function recordedRunner(): LocalizerRunner {
  return async (input) => [makeRendering(stepShim(input), input.stamp)];
}

export type Verdict = "PASS" | "FAIL" | "CANNOT_ASSESS";

/** A reviewer-shape output for one decision under one rubric. */
export function verdictOutput(
  renderingId: string,
  verdict: Verdict,
  evidenceRequest?: string | null,
) {
  const base = {
    unitId: renderingId,
    category: "terminology" as const,
    span: null,
    evidenceIds: [],
  };
  const one =
    verdict === "FAIL"
      ? {
          ...base,
          verdict,
          severity: "major",
          repairConstraint: "use the approved form",
          evidenceRequest: null,
        }
      : verdict === "CANNOT_ASSESS"
        ? {
            ...base,
            verdict,
            severity: "none",
            repairConstraint: null,
            evidenceRequest: evidenceRequest === undefined ? "need more evidence" : evidenceRequest,
          }
        : { ...base, verdict, severity: "none", repairConstraint: null, evidenceRequest: null };
  return { snapshotId: LOC_SNAP, verdicts: [one] };
}

/** A reviewer that passes every rubric. */
export const passingReviewer: DecisionReviewer = async (input) =>
  verdictOutput(input.rendering.renderingId, "PASS");

/** Default orchestrator deps for a production run over the recorded doubles. */
export function baseDeps(overrides: Partial<Parameters<typeof orchestrateLocalizedWiki>[0]> = {}) {
  return {
    sourceObjects: sourceWiki(),
    targetLanguage: TARGET_LANG,
    posture: "production" as LocalizationPosture,
    runMode: RUN_MODE,
    localizationSnapshotId: LOC_SNAP,
    concurrency: 3,
    runner: recordedRunner(),
    reviewer: passingReviewer,
    ledger: new InMemoryBibleRenderingLedger(),
    ...overrides,
  };
}
