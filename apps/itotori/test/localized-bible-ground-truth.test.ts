// Make the per-target localized bible the GROUND TRUTH — mutation-falsifiable
// proofs.
//
// The binding + enforcement + invalidation is deterministic; the line CONTENT it
// binds is best-effort model output the module never re-proves. Every proof
// targets one acceptance clause and FAILS if that clause's guarantee is removed:
//   1. a unit RESOLVES the exact bible entries + RECORDS their dependencies;
//   2. a line contradicting an installed canonical form is a DEFECT;
//   3. a justified bible change REFLOWS only the cited lines (unrelated units
//      stay byte-identical);
//   4. a missing required bible entry BLOCKS drafting (no ad-hoc fallback).

import { describe, expect, it } from "vitest";

import {
  LocalizedRenderingSchema,
  type LocalizedRendering,
  type RouteScope,
  type WikiObject,
} from "../src/contracts/index.js";
import { Q1ReviewInputSchema } from "../src/roles/q1/index.js";
import {
  MissingBibleEntryError,
  applyReflowedOutputs,
  bibleEntryDiffBody,
  bindingsToEdges,
  buildInstalledBible,
  deriveUnitRequirements,
  enforceBibleGroundTruth,
  planBibleReflow,
  reflowPlanFor,
  resolveUnitBibleGroundTruth,
  type InstalledBibleEntry,
} from "../src/localized-wiki/ground-truth/index.js";
import type { OrderedUnitFact, TerminologyOccurrenceFact } from "../src/prepass/index.js";
import { makeAccepted, makeSnapshot, makeUnit, sha } from "./support/gate-fixtures.js";
import { LOC_SNAP, RUN_MODE, TARGET_LANG } from "./support/localized-wiki-fixtures.js";

const GLOBAL: RouteScope = { kind: "global" };
const R1: RouteScope = { kind: "route", routeId: "r1" };
const CHAR = "c1";

// ── minimal source Wiki + localized renderings ─────────────────────────────────
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

function rendering(
  renderingId: string,
  sourceObjectId: string,
  kind: string,
  scope: RouteScope,
  body: Record<string, unknown>,
  version = 1,
): LocalizedRendering {
  return LocalizedRenderingSchema.parse({
    schemaVersion: "itotori.localized-rendering.v1",
    renderingId,
    sourceObjectId,
    sourceObjectKind: kind,
    targetLanguage: TARGET_LANG,
    version,
    scope,
    body,
    claimRenderings: [],
    dependencies: [],
    provenance: { basisSourceVersion: 1, localizationSnapshotId: LOC_SNAP, runMode: RUN_MODE },
    provisional: false,
  });
}

function termBody(
  termId: string,
  preferred: string,
  forbidden: readonly string[],
  scope: RouteScope,
) {
  return {
    kind: "term-ruling",
    termId,
    canonicalForms: [
      { form: preferred, status: "preferred", scope },
      ...forbidden.map((form) => ({ form, status: "forbidden", scope })),
    ],
    registerGuidance: "neutral, warm",
  };
}

const STYLE_BODY = {
  kind: "style-contract",
  registerGuidance: "polite by default",
  honorificGuidance: "retain -san",
  nameOrder: "source-order",
  profanityCeiling: "mild",
  punctuationRules: ["… stays …"],
};

const VOICE_BODY = {
  kind: "voice-profile",
  characterId: CHAR,
  baseRegisterGuidance: "soft",
  counterpartGuidance: [],
  arcGuidance: [],
};

function proseBody(kind: string, scope: RouteScope, text: string) {
  return { kind, sections: [{ sectionId: "s1", heading: "arc", text, scope }] };
}

// Renderings (v1). The hero term rules "Hero" (forbidding "Champion").
const heroRendV1 = rendering(
  "rendering:term:hero",
  "term-ruling:T-hero",
  "term-ruling",
  GLOBAL,
  termBody("T-hero", "Hero", ["Champion"], GLOBAL),
);
const nameRend = rendering(
  "rendering:name:c1",
  "term-ruling:c1",
  "term-ruling",
  GLOBAL,
  termBody("name-c1", "Aoi", [], GLOBAL),
);
const styleRendV1 = rendering(
  "rendering:style",
  "style-contract:g",
  "style-contract",
  GLOBAL,
  STYLE_BODY,
);
const voiceRend = rendering(
  "rendering:voice:c1",
  "voice-profile:c1",
  "voice-profile",
  GLOBAL,
  VOICE_BODY,
);
const arcRend = rendering(
  "rendering:arc:r1",
  "route-arc:r1",
  "route-arc",
  R1,
  proseBody("route-arc", R1, "the r1 arc"),
);

function entry(sourceObject: WikiObject, r: LocalizedRendering): InstalledBibleEntry {
  return { sourceObject, rendering: r };
}

const HERO_SRC = src(
  "term-ruling",
  { kind: "glossary-term", id: "T-hero" },
  "term-ruling:T-hero",
  GLOBAL,
  { termId: "T-hero", sourceForm: "勇者" },
);
const NAME_SRC = src("term-ruling", { kind: "character", id: CHAR }, "term-ruling:c1", GLOBAL, {
  termId: "name-c1",
  sourceForm: "あおい",
});
const STYLE_SRC = src("style-contract", { kind: "game", id: "g" }, "style-contract:g", GLOBAL, {});
const VOICE_SRC = src(
  "voice-profile",
  { kind: "character", id: CHAR },
  "voice-profile:c1",
  GLOBAL,
  {},
);
const ARC_SRC = src("route-arc", { kind: "route", id: "r1" }, "route-arc:r1", R1, {});

/** The full installed bible (all five entries), overridable to omit some. */
function fullBible(overrides: readonly InstalledBibleEntry[] = defaultEntries()) {
  return buildInstalledBible(overrides);
}
function defaultEntries(): InstalledBibleEntry[] {
  return [
    entry(HERO_SRC, heroRendV1),
    entry(NAME_SRC, nameRend),
    entry(STYLE_SRC, styleRendV1),
    entry(VOICE_SRC, voiceRend),
    entry(ARC_SRC, arcRend),
  ];
}

// ── units + snapshot ───────────────────────────────────────────────────────────
// unit:h — a dialogue line spoken by c1 where the source term T-hero occurs.
const unitH: OrderedUnitFact = makeUnit({
  factId: "unit:h",
  sourceUnitKey: "k-h",
  speaker: {
    knowledgeState: "known",
    speakerId: CHAR,
    displayName: "Aoi",
  } as OrderedUnitFact["speaker"],
});
// unit:r — a route-scoped narrated line with no speaker and no glossary term.
const unitR: OrderedUnitFact = makeUnit({
  factId: "unit:r",
  sourceUnitKey: "k-r",
  routeScope: { kind: "route", routeId: "r1" },
});

const HERO_TERM: TerminologyOccurrenceFact = {
  factId: "glossary:hero",
  termKey: "T-hero",
  policyAction: "translate",
  aliases: ["勇者"],
  occurrenceCount: 1,
  occurrenceUnitKeys: ["k-h"],
};
// The character name is a term too, but occurs in no unit (so the gate does not
// check it here) — it still must exist as a fact for the installed form.
const NAME_TERM: TerminologyOccurrenceFact = {
  factId: "glossary:c1",
  termKey: CHAR,
  policyAction: "translate",
  aliases: ["あおい"],
  occurrenceCount: 0,
  occurrenceUnitKeys: [],
};

const snapshot = makeSnapshot({
  units: [unitH, unitR],
  terminology: [HERO_TERM, NAME_TERM],
});

// ── clause 1 ───────────────────────────────────────────────────────────────────
describe("clause 1 — a unit RESOLVES the exact bible entries + RECORDS the dependencies", () => {
  it("PROOF: the required entries are derived mechanically from the unit's facts", () => {
    const req = deriveUnitRequirements(unitH, snapshot);
    expect(req.map((r) => r.category).sort()).toEqual(["name", "style", "term", "voice"]);
    // the route unit needs the style + its route arc, nothing speaker-derived.
    expect(
      deriveUnitRequirements(unitR, snapshot)
        .map((r) => r.category)
        .sort(),
    ).toEqual(["arc", "style"]);
  });

  it("PROOF: resolution binds the EXACT renderings and records one dependency per entry", () => {
    const binding = resolveUnitBibleGroundTruth(unitH, snapshot, fullBible());
    expect(binding.bibleRenderingIds).toEqual([
      "rendering:name:c1",
      "rendering:style",
      "rendering:term:hero",
      "rendering:voice:c1",
    ]);
    // The ids are accompanied by the actual installed bodies P1/review input
    // assemblers put on the wire; an id is never a substitute for a rule.
    expect(binding.renderings.map((rendering) => rendering.renderingId)).toEqual(
      binding.bibleRenderingIds,
    );
    expect(
      binding.renderings.find((rendering) => rendering.renderingId === "rendering:term:hero")?.body,
    ).toEqual(heroRendV1.body);
    // every resolved rendering is RECORDED as a fine-grained dependency (renderingId
    // + body field-path + the unit's route/play window) — this is what a later
    // bible change intersects to find this unit. Remove the recording and the set
    // is empty (and clause 3 can no longer scope).
    expect(binding.dependencies.map((d) => d.renderingId).sort()).toEqual(
      binding.bibleRenderingIds,
    );
    for (const dep of binding.dependencies) {
      expect(dep.fieldPath).toEqual(["body"]);
      expect(dep.upstreamObjectId).toBe(dep.renderingId);
      expect(dep.fromPlayOrder).toBe(unitH.playReveal.playOrderIndex);
    }
  });

  it("PROOF: the resolved ids populate the Q-role input contract (the roles resolve, never re-decide)", () => {
    const binding = resolveUnitBibleGroundTruth(unitH, snapshot, fullBible());
    const parsed = Q1ReviewInputSchema.parse({
      unitId: unitH.factId,
      contextSnapshotId: sha("ctx"),
      localizationSnapshotId: LOC_SNAP,
      targetLanguage: TARGET_LANG,
      reviewScope: GLOBAL,
      sourceFacts: [
        {
          factId: "glossary:hero",
          field: "meaning",
          text: "勇者",
          evidence: {
            evidenceHash: sha("glossary:hero"),
            snapshotId: sha("ctx"),
            subject: { kind: "glossary-term", id: "T-hero" },
            playOrderIndex: 0,
          },
        },
      ],
      candidateTarget: "The Hero appears.",
      bibleRenderingIds: binding.bibleRenderingIds,
      localizedBible: binding.bibleRenderingIds.map((renderingId) => ({
        renderingId,
        text: `resolved ${renderingId}`,
      })),
      neighbors: [],
      backTranslationSignal: null,
    });
    expect(parsed.bibleRenderingIds).toEqual(binding.bibleRenderingIds);
  });
});

// ── clause 2 ───────────────────────────────────────────────────────────────────
describe("clause 2 — a line contradicting an installed canonical form is a DEFECT", () => {
  it("PROOF: a contradictory line is a glossary-exact defect; the SAME line passes only when the bible is not bound", () => {
    const bible = fullBible();
    // conforming — renders the ruled form "Hero", no forbidden "Champion".
    const clean = enforceBibleGroundTruth(
      snapshot,
      [makeAccepted(unitH, "The Hero appears.")],
      bible,
    );
    expect(clean.contradictions).toHaveLength(0);

    // contradictory — omits "Hero" AND uses the forbidden "Champion".
    const dirty = enforceBibleGroundTruth(
      snapshot,
      [makeAccepted(unitH, "The Champion appears.")],
      bible,
    );
    expect(dirty.contradictions.length).toBeGreaterThan(0);
    expect(dirty.contradictions.every((d) => d.category === "glossary-exact")).toBe(true);
    expect(dirty.contradictions.every((d) => d.origin === "deterministic")).toBe(true);

    // FALSIFIER: an empty bible has no canonical authority, so the identical
    // contradictory line is NOT a defect. Feeding the bible forms is the whole
    // guarantee — remove it and the contradiction slips through as a "style".
    const unbound = buildInstalledBible([]);
    const slipped = enforceBibleGroundTruth(
      snapshot,
      [makeAccepted(unitH, "The Champion appears.")],
      unbound,
    );
    expect(slipped.contradictions).toHaveLength(0);
  });
});

// ── clause 3 ───────────────────────────────────────────────────────────────────
describe("clause 3 — a justified bible change REFLOWS only the cited lines", () => {
  const bH = resolveUnitBibleGroundTruth(unitH, snapshot, fullBible());
  const bR = resolveUnitBibleGroundTruth(unitR, snapshot, fullBible());
  const edges = bindingsToEdges([bH, bR]);
  const priorOutputs = [
    { unitId: "unit:h", targetHash: sha("line-h") },
    { unitId: "unit:r", targetHash: sha("line-r") },
  ];

  it("PROOF: changing ONLY the hero term reflows unit:h and leaves unit:r byte-identical", () => {
    // The hero ruling advances "Hero" -> "Protagonist" (a justified change).
    const heroRendV2 = rendering(
      "rendering:term:hero",
      "term-ruling:T-hero",
      "term-ruling",
      GLOBAL,
      termBody("T-hero", "Protagonist", ["Champion"], GLOBAL),
      2,
    );
    const impact = planBibleReflow({
      prior: bibleEntryDiffBody(heroRendV1),
      next: bibleEntryDiffBody(heroRendV2),
      edges,
    });
    const plan = reflowPlanFor(impact, [bH, bR]);
    // only unit:h cited the hero rendering, so only it reflows.
    expect(plan.reflowUnitIds).toEqual(["unit:h"]);
    expect(plan.preservedUnitIds).toEqual(["unit:r"]);
    expect(impact.consumers.map((c) => c.downstreamObjectId)).toEqual(["translation:unit:h"]);

    const next = applyReflowedOutputs(priorOutputs, plan, (id) => sha(`redraft:${id}`));
    const byId = new Map(next.map((o) => [o.unitId, o.targetHash]));
    // unrelated unit stays HASH-IDENTICAL; the cited unit is re-drafted.
    expect(byId.get("unit:r")).toBe(sha("line-r"));
    expect(byId.get("unit:h")).toBe(sha("redraft:unit:h"));
    expect(byId.get("unit:h")).not.toBe(sha("line-h"));
  });

  it("PROOF: the scope is precise — a shared entry (style) reflows BOTH, a private entry reflows ONE", () => {
    const styleV2 = rendering(
      "rendering:style",
      "style-contract:g",
      "style-contract",
      GLOBAL,
      { ...STYLE_BODY, registerGuidance: "casual by default" },
      2,
    );
    const styleImpact = planBibleReflow({
      prior: bibleEntryDiffBody(styleRendV1),
      next: bibleEntryDiffBody(styleV2),
      edges,
    });
    // BOTH units cited the global style contract -> both reflow.
    expect(reflowPlanFor(styleImpact, [bH, bR]).reflowUnitIds).toEqual(["unit:h", "unit:r"]);

    // The voice profile is private to unit:h -> only it reflows.
    const voiceV2 = rendering(
      "rendering:voice:c1",
      "voice-profile:c1",
      "voice-profile",
      GLOBAL,
      { ...VOICE_BODY, baseRegisterGuidance: "brisk" },
      2,
    );
    const voiceImpact = planBibleReflow({
      prior: bibleEntryDiffBody(voiceRend),
      next: bibleEntryDiffBody(voiceV2),
      edges,
    });
    expect(reflowPlanFor(voiceImpact, [bH, bR]).reflowUnitIds).toEqual(["unit:h"]);
  });
});

// ── clause 4 ───────────────────────────────────────────────────────────────────
describe("clause 4 — a missing required bible entry BLOCKS drafting (no fallback)", () => {
  it("PROOF: a unit whose required entry is absent throws, and resolves once installed", () => {
    // Bible missing the voice profile the speaker requires.
    const noVoice = buildInstalledBible(
      defaultEntries().filter((e) => e.rendering.renderingId !== "rendering:voice:c1"),
    );
    let thrown: unknown;
    try {
      resolveUnitBibleGroundTruth(unitH, snapshot, noVoice);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingBibleEntryError);
    expect((thrown as MissingBibleEntryError).required.category).toBe("voice");
    // installing it unblocks — no ad-hoc fallback was taken.
    expect(() => resolveUnitBibleGroundTruth(unitH, snapshot, fullBible())).not.toThrow();
  });

  it("PROOF: the route unit blocks on its missing arc, but the speaker unit (no arc) does not", () => {
    const noArc = buildInstalledBible(
      defaultEntries().filter((e) => e.rendering.renderingId !== "rendering:arc:r1"),
    );
    expect(() => resolveUnitBibleGroundTruth(unitR, snapshot, noArc)).toThrow(
      MissingBibleEntryError,
    );
    // unit:h requires no arc, so the missing arc does not block it.
    expect(() => resolveUnitBibleGroundTruth(unitH, snapshot, noArc)).not.toThrow();
  });
});
