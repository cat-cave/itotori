// Precise enhancement + invalidation — mutation-falsifiable proofs.
//
// A route/play-scoped ONE-FIELD change to a Wiki/bible object, batched behind
// an intentional apply action, returns immediately; then this offline-provable
// core plans what it reaches. Every proof targets one acceptance clause and
// FAILS if that clause's guarantee is removed:
//   1. PRECISE ENHANCEMENT — the change enhances ONLY consumers that CITED the
//      changed field (via the recorded claim/rendering dependencies).
//   2. RERUN ONLY IMPLICATED LANES — only the review lanes the enhanced units'
//      defects implicate re-run (reuses the workflow rerun-only-implicated
//      logic).
//   3. UNRELATED STAY HASH-IDENTICAL — unrelated objects, memos, units, routes
//      remain byte/hash-identical (nothing spurious is invalidated).
//   4. BYTE-RANGE SCOPING (offline logic) — the patch update changes ONLY the
//      reached entries' accepted-target bytes; unrelated patch bytes are
//      byte/hash-identical. The real-bytes patch assertion (native apply over
//      the real game root) is a LIVE-LANE follow-up, flagged honestly below.

import { describe, expect, it } from "vitest";

import type { PatchExportEntryV02 } from "@itotori/localization-bridge-schema";

import {
  LocalizedRenderingSchema,
  type LocalizedRendering,
  type RouteScope,
  type WikiObject,
} from "../src/contracts/index.js";
import { buildDefect } from "../src/gates/index.js";
import {
  bibleEntryDiffBody,
  buildInstalledBible,
  resolveUnitBibleGroundTruth,
  type InstalledBibleEntry,
} from "../src/localized-wiki/ground-truth/index.js";
import {
  applyPreciseEnhancement,
  byteRangesOverlap,
  planEnhancementImpact,
  scopePatchUpdate,
  targetTextByteRange,
} from "../src/localized-wiki/enhancement-impact/index.js";
import { joinFindings } from "../src/workflow/finding-join.js";
import type { OrderedUnitFact, TerminologyOccurrenceFact } from "../src/prepass/index.js";
import { makeSnapshot, makeUnit, sha } from "./support/gate-fixtures.js";
import { GLOBAL, LOC_SNAP, RUN_MODE, TARGET_LANG } from "./support/localized-wiki-fixtures.js";

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

const HERO_SRC = src(
  "term-ruling",
  { kind: "glossary-term", id: "T-hero" },
  "term-ruling:T-hero",
  GLOBAL,
  {
    termId: "T-hero",
    sourceForm: "勇者",
  },
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

function entry(sourceObject: WikiObject, r: LocalizedRendering): InstalledBibleEntry {
  return { sourceObject, rendering: r };
}

function fullBible(): ReturnType<typeof buildInstalledBible> {
  return buildInstalledBible([
    entry(HERO_SRC, heroRendV1),
    entry(NAME_SRC, nameRend),
    entry(STYLE_SRC, styleRendV1),
    entry(VOICE_SRC, voiceRend),
    entry(ARC_SRC, arcRend),
  ]);
}

// ── units + snapshot ───────────────────────────────────────────────────────────
// unit:h — a dialogue line spoken by c1 where the source term T-hero occurs.
const unitH: OrderedUnitFact = makeUnit({
  factId: "unit:h",
  sourceUnitKey: "reallive:unit:h",
  speaker: {
    knowledgeState: "known",
    speakerId: CHAR,
    displayName: "Aoi",
  } as OrderedUnitFact["speaker"],
});
// unit:r — a route-scoped narrated line with no speaker and no glossary term.
const unitR: OrderedUnitFact = makeUnit({
  factId: "unit:r",
  sourceUnitKey: "reallive:unit:r",
  routeScope: { kind: "route", routeId: "r1" },
});

const HERO_TERM: TerminologyOccurrenceFact = {
  factId: "glossary:hero",
  termKey: "T-hero",
  policyAction: "translate",
  aliases: ["勇者"],
  occurrenceCount: 1,
  occurrenceUnitKeys: ["reallive:unit:h"],
};

const snapshot = makeSnapshot({ units: [unitH, unitR], terminology: [HERO_TERM] });

// The resolved bindings: unit:h cited hero+name+style+voice; unit:r cited
// style+arc. These recorded dependencies are what a later change intersects.
const bH = resolveUnitBibleGroundTruth(unitH, snapshot, fullBible());
const bR = resolveUnitBibleGroundTruth(unitR, snapshot, fullBible());
const bindings = [bH, bR];

// A defect bundle: unit:h's defect implicates Q1; unit:r's implicates Q4. This
// is the rerun-only-implicated fixture (only the enhanced units' lanes re-run).
const bundle = joinFindings({
  localizationSnapshotId: LOC_SNAP,
  draftBatchId: "batch.enh",
  deterministic: [
    buildDefect({
      unitId: "unit:h",
      category: "protected-span",
      detail: "unit:h protected span",
      basisFactIds: ["fact.h"],
      implicatedReviewLanes: ["Q1"],
    }),
    buildDefect({
      unitId: "unit:r",
      category: "protected-span",
      detail: "unit:r protected span",
      basisFactIds: ["fact.r"],
      implicatedReviewLanes: ["Q4"],
    }),
  ],
  evaluatedGates: ["protected-spans"],
  reviews: [],
});

// ── clause 1 ───────────────────────────────────────────────────────────────────
describe("clause 1 — PRECISE ENHANCEMENT: only consumers that CITED the changed field", () => {
  it("PROOF: a one-field hero-term change reaches ONLY unit:h (it cited the hero rendering)", () => {
    // The hero ruling advances "Hero" -> "Protagonist" (a justified one-field
    // enhancement), batched behind an apply action.
    const heroRendV2 = rendering(
      "rendering:term:hero",
      "term-ruling:T-hero",
      "term-ruling",
      GLOBAL,
      termBody("T-hero", "Protagonist", ["Champion"], GLOBAL),
      2,
    );
    const plan = planEnhancementImpact({
      prior: bibleEntryDiffBody(heroRendV1),
      next: bibleEntryDiffBody(heroRendV2),
      bindings,
      bundle,
    });
    // ONLY unit:h recorded a dependency on the hero rendering's body — so only
    // it is in the enhancement set; unit:r (which never cited it) is preserved.
    expect(plan.enhancedUnitIds).toEqual(["unit:h"]);
    expect(plan.preservedUnitIds).toEqual(["unit:r"]);
    // The impact set is exactly the citing consumer, classified precisely.
    expect(plan.impactSet.consumers.map((c) => c.downstreamObjectId)).toEqual([
      "translation:unit:h",
    ]);

    // FALSIFIER: a shared entry (style) is cited by BOTH units -> both enhance.
    // This proves the scoping is content-addressed, not a fixed unit list.
    const styleV2 = rendering(
      "rendering:style",
      "style-contract:g",
      "style-contract",
      GLOBAL,
      { ...STYLE_BODY, registerGuidance: "casual by default" },
      2,
    );
    const shared = planEnhancementImpact({
      prior: bibleEntryDiffBody(styleRendV1),
      next: bibleEntryDiffBody(styleV2),
      bindings,
      bundle,
    });
    expect(shared.enhancedUnitIds).toEqual(["unit:h", "unit:r"]);
  });
});

// ── clause 2 ───────────────────────────────────────────────────────────────────
describe("clause 2 — RERUN ONLY IMPLICATED LANES: only the enhanced units' lanes re-run", () => {
  it("PROOF: enhancing unit:h re-runs ONLY Q1 over ONLY unit:h (Q4 / unit:r never re-run)", () => {
    const heroRendV2 = rendering(
      "rendering:term:hero",
      "term-ruling:T-hero",
      "term-ruling",
      GLOBAL,
      termBody("T-hero", "Protagonist", ["Champion"], GLOBAL),
      2,
    );
    const plan = planEnhancementImpact({
      prior: bibleEntryDiffBody(heroRendV1),
      next: bibleEntryDiffBody(heroRendV2),
      bindings,
      bundle,
    });
    // The change reached ONLY unit:h, so the rerun is restricted to unit:h and
    // the ONE lane its defects implicate (Q1). unit:r's Q4 is never re-run.
    expect(plan.rerun.unitIds).toEqual(["unit:h"]);
    expect(plan.rerun.lanes).toEqual(["Q1"]);
    expect(plan.rerun.lanes).not.toContain("Q4");

    // FALSIFIER: change NOTHING (a pure re-version) -> no consumer is reached,
    // so the rerun set is empty. A no-op enhancement cannot re-open any lane.
    const noop = planEnhancementImpact({
      prior: bibleEntryDiffBody(heroRendV1),
      next: bibleEntryDiffBody(heroRendV1),
      bindings,
      bundle,
    });
    expect(noop.enhancedUnitIds).toEqual([]);
    expect(noop.rerun.unitIds).toEqual([]);
    expect(noop.rerun.lanes).toEqual([]);
  });
});

// ── clause 3 ───────────────────────────────────────────────────────────────────
describe("clause 3 — UNRELATED STAY HASH-IDENTICAL: nothing spurious is invalidated", () => {
  it("PROOF: enhancing unit:h changes ONLY unit:h; objects/memos/units/routes stay byte-identical", () => {
    // The prior work-scope: unit:h + unit:r, plus an unrelated memo, object,
    // and route. Each carries a content hash — the hash-identity proof.
    const prior = [
      { key: "unit:h", contentHash: sha("line-h") },
      { key: "unit:r", contentHash: sha("line-r") },
      { key: "memo:betrayal", contentHash: sha("memo-betrayal") },
      { key: "object:scene-10", contentHash: sha("obj-scene10") },
      { key: "route:r2", contentHash: sha("route-r2") },
    ];
    // The enhancement reached ONLY unit:h (clause 1).
    const next = applyPreciseEnhancement(prior, ["unit:h"], (id) => sha(`enhanced:${id}`));

    const byKey = new Map(next.map((target) => [target.key, target.contentHash]));
    // The enhanced unit is re-emitted with a NEW hash.
    expect(byKey.get("unit:h")).toBe(sha("enhanced:unit:h"));
    expect(byKey.get("unit:h")).not.toBe(sha("line-h"));

    // Every UNRELATED artifact is the SAME object reference (byte-identical) and
    // carries the SAME hash — a unit, a memo, an object, and a route alike.
    const preservedKeys = ["unit:r", "memo:betrayal", "object:scene-10", "route:r2"];
    for (const key of preservedKeys) {
      const before = prior.find((target) => target.key === key);
      const after = next.find((target) => target.key === key);
      expect(after).toBe(before); // === same reference => byte-identical
      expect(byKey.get(key)).toBe(before?.contentHash);
    }

    // FALSIFIER: remove the scoping (enhance EVERYTHING) and an unrelated
    // artifact's hash changes — the proof the partition is load-bearing.
    const unscoped = applyPreciseEnhancement(
      prior,
      prior.map((target) => target.key),
      (id) => sha(`enhanced:${id}`),
    );
    const unscopedByHash = new Map(unscoped.map((target) => [target.key, target.contentHash]));
    expect(unscopedByHash.get("route:r2")).not.toBe(sha("route-r2"));
  });
});

// ── clause 4 (offline logic; real-bytes patch is a LIVE-LANE follow-up) ─────────
describe("clause 4 — BYTE-RANGE SCOPING (offline logic): only reached patch bytes change", () => {
  // NOTE (live-only, flagged honestly): the assertion that real patched GAME
  // bytes change only in the expected ranges needs the native Kaifuu apply over
  // the real game root — a live-lane run, not a deterministic fixture. This
  // proof exercises the byte-range-scoping LOGIC over patch entries; the
  // real-bytes patch assertion is a live-lane follow-up.

  function patchEntry(sourceUnitKey: string, targetText: string): PatchExportEntryV02 {
    return {
      entryId: `entry:${sourceUnitKey}`,
      bridgeUnitId: `bridge:${sourceUnitKey}`,
      sourceUnitKey,
      sourceHash: sha(sourceUnitKey),
      sourceRevision: {
        revisionId: `rev:${sourceUnitKey}`,
        revisionKind: "content_hash",
        value: sha(sourceUnitKey),
      },
      targetText,
      protectedSpanMappings: [],
    } as PatchExportEntryV02;
  }

  it("PROOF: scoping a patch update to unit:h changes ONLY its entry; others are byte-identical", () => {
    const prior = [
      patchEntry("reallive:unit:h", "The Hero appears."),
      patchEntry("reallive:unit:r", "the r1 arc"),
      patchEntry("reallive:unit:other", "an unrelated line"),
    ];
    // The enhancement reached ONLY unit:h (clause 1) -> its source-unit key is
    // the one impacted patch key.
    const scope = scopePatchUpdate({
      prior,
      impactedSourceUnitKeys: ["reallive:unit:h"],
      redraft: (key) => patchEntry(key, "The Protagonist appears."),
    });

    expect(scope.changedSourceUnitKeys).toEqual(["reallive:unit:h"]);
    expect(scope.preservedSourceUnitKeys).toEqual(["reallive:unit:other", "reallive:unit:r"]);

    // The impacted entry's accepted-target bytes changed.
    const hEntry = scope.entries.find((entry) => entry.sourceUnitKey === "reallive:unit:h");
    expect(hEntry?.targetText).toBe("The Protagonist appears.");

    // Every other entry is the SAME object reference (byte/hash-identical).
    const rAfter = scope.entries.find((entry) => entry.sourceUnitKey === "reallive:unit:r");
    const otherAfter = scope.entries.find((entry) => entry.sourceUnitKey === "reallive:unit:other");
    expect(rAfter).toBe(prior[1]);
    expect(otherAfter).toBe(prior[2]);

    // FALSIFIER: with no scoping (every key impacted), a previously-identical
    // entry's bytes would change — the proof the scoping is load-bearing.
    const unscoped = scopePatchUpdate({
      prior,
      impactedSourceUnitKeys: prior.map((entry) => entry.sourceUnitKey),
      redraft: (key) => patchEntry(key, "rewritten"),
    });
    const rUnscoped = unscoped.entries.find((entry) => entry.sourceUnitKey === "reallive:unit:r");
    expect(rUnscoped?.targetText).not.toBe("the r1 arc");
  });

  it("PROOF: a change confined to one entry's byte range cannot reach a disjoint entry", () => {
    // The byte ranges the three accepted targets occupy in the assembled patch.
    const rangeH = targetTextByteRange({ targetText: "The Hero appears." }, 0);
    const rangeR = targetTextByteRange({ targetText: "the r1 arc" }, rangeH.end);
    const rangeOther = targetTextByteRange(
      { targetText: "an unrelated line" },
      rangeH.end + rangeR.end,
    );

    // A change scoped to unit:h's range overlaps unit:h, but neither unit:r nor
    // the unrelated entry — pure interval math, the deterministic half of the
    // "changes only expected patch BYTE ranges" clause.
    expect(byteRangesOverlap(rangeH, rangeH)).toBe(true);
    expect(byteRangesOverlap(rangeH, rangeR)).toBe(false);
    expect(byteRangesOverlap(rangeH, rangeOther)).toBe(false);

    // Adjacent ranges (end === start) do not overlap — no off-by-one leakage.
    expect(rangeH.end).toBe(rangeR.start);
    expect(byteRangesOverlap(rangeH, { start: rangeH.end, end: rangeH.end + 1 })).toBe(false);
  });
});
