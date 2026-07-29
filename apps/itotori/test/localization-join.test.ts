import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  ConflictingNarrativeLinkError,
  DanglingBridgeRefError,
  DuplicateLocalizationUnitError,
  IncompleteNarrativeLinkError,
  SourceBindingMismatchError,
  UnreferencedLocalizationUnitError,
  joinNarrativeToLocalization,
} from "../src/structure/index.js";
import type {
  NarrativeChoice,
  NarrativeMessage,
  NarrativeScene,
  NarrativeStructure,
  NarrativeUnit,
} from "../src/structure/index.js";

import {
  loadBridgeBundle,
  BUNDLE_HASH,
  UnitSpec,
  realliveEvidence,
  sceneRef,
  SCENE_1_LINE,
  SCENE_1_CHOICE_A,
  SCENE_1_CHOICE_B,
  SCENE_2_LINE,
  SCENE_2_CHOICE_A,
  SCENE_2_CHOICE_B,
  makeNarrativeUnit,
  makeMessage,
  makeChoice,
  scene,
  structureFor,
  wellFormedStructure,
  messageChoiceStructure,
  caught,
} from "./localization-join.support.js";

describe("joinNarrativeToLocalization", () => {
  it("binds every narrative line and choice to exactly one active unit", () => {
    const bundle = loadBridgeBundle();
    const result = joinNarrativeToLocalization(wellFormedStructure(), bundle);

    // Every one of the six narrative units binds; nothing is left dangling
    // and (proven by no UnreferencedLocalizationUnitError) every bundle unit
    // is referenced exactly once.
    expect(result.bindings).toHaveLength(6);

    const boundBridgeUnitIds = result.bindings.map((b) => b.unit.bridgeUnitId);
    expect(new Set(boundBridgeUnitIds).size).toBe(6);

    // Line-vs-choice classification is preserved: two lines, four choices.
    const lines = result.bindings.filter((b) => b.link.kind === "line");
    const choices = result.bindings.filter((b) => b.link.kind === "choice");
    expect(lines).toHaveLength(2);
    expect(choices).toHaveLength(4);

    // Each binding agrees on sourceUnitKey and byte range with its unit.
    for (const { link, unit } of result.bindings) {
      expect(link.sourceUnitKey).toBe(unit.sourceUnitKey);
      expect(unit.sourceLocation.range).toEqual(link.byteRange);
    }
  });

  it("binds bridge-linked messages and choices (no flat units[]) covering the whole bundle", () => {
    const bundle = loadBridgeBundle();
    const result = joinNarrativeToLocalization(messageChoiceStructure(), bundle);
    expect(result.bindings).toHaveLength(6);
    expect(result.bindings.filter((b) => b.link.kind === "line")).toHaveLength(2);
    expect(result.bindings.filter((b) => b.link.kind === "choice")).toHaveLength(4);
  });

  // --- Guard: duplicate active unit by bridgeUnitId ---
  it("fails loud when two active localization units share a bridgeUnitId", () => {
    const bundle = loadBridgeBundle();
    const duplicated: BridgeBundleV02 = {
      ...bundle,
      units: [...bundle.units, { ...bundle.units[0]! }],
    };
    const error = caught(() => joinNarrativeToLocalization(wellFormedStructure(), duplicated));
    expect(error).toBeInstanceOf(DuplicateLocalizationUnitError);
    expect((error as DuplicateLocalizationUnitError).keyKind).toBe("bridgeUnitId");
  });

  // --- Guard: duplicate active unit by sourceUnitKey (distinct bridgeUnitId) ---
  it("fails loud when two active units share a sourceUnitKey", () => {
    const bundle = loadBridgeBundle();
    // Mutation: a second unit with a DISTINCT bridgeUnitId but a duplicate
    // sourceUnitKey. Deleting the sourceUnitKey guard would let both index.
    const collidingUnit = {
      ...bundle.units[0]!,
      bridgeUnitId: "11111111-1111-7111-8111-111111111111",
    };
    const duplicated: BridgeBundleV02 = {
      ...bundle,
      units: [...bundle.units, collidingUnit],
    };
    const error = caught(() => joinNarrativeToLocalization(wellFormedStructure(), duplicated));
    expect(error).toBeInstanceOf(DuplicateLocalizationUnitError);
    expect((error as DuplicateLocalizationUnitError).keyKind).toBe("sourceUnitKey");
  });

  // --- Guard: dangling narrative ref ---
  it("fails loud when a narrative ref has no active unit", () => {
    const bundle = loadBridgeBundle();
    const dangling = structureFor([
      scene(1, [
        { ...SCENE_1_LINE, bridgeUnitId: "00000000-0000-7000-8000-000000000000" },
        SCENE_1_CHOICE_A,
        SCENE_1_CHOICE_B,
      ]),
      scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B]),
    ]);
    expect(() => joinNarrativeToLocalization(dangling, bundle)).toThrowError(
      DanglingBridgeRefError,
    );
  });

  // --- Guard: byte-range mismatch ---
  it("fails loud when a bound unit's byte range does not match", () => {
    const bundle = loadBridgeBundle();
    const drifted = structureFor([
      scene(1, [
        { ...SCENE_1_LINE, endByte: SCENE_1_LINE.endByte + 1 },
        SCENE_1_CHOICE_A,
        SCENE_1_CHOICE_B,
      ]),
      scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B]),
    ]);
    const error = caught(() => joinNarrativeToLocalization(drifted, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("byte_range");
  });

  // --- Guard: choice-only byte-range drift (choices now carry coordinates) ---
  it("fails loud when a bound CHOICE's byte range does not match", () => {
    const bundle = loadBridgeBundle();
    const choiceScene: NarrativeScene = {
      sceneId: sceneRef(1),
      selectionControl: "none",
      nextScene: null,
      messages: [makeMessage(SCENE_1_LINE)],
      choices: [
        // Drift the choice's byte range away from the unit's authoritative range.
        {
          ...makeChoice(SCENE_1_CHOICE_A, 0),
          engineEvidence: realliveEvidence(900, 99),
        },
        makeChoice(SCENE_1_CHOICE_B, 1),
      ],
    };
    const structure = structureFor([
      choiceScene,
      {
        sceneId: sceneRef(2),
        selectionControl: "none",
        nextScene: null,
        messages: [makeMessage(SCENE_2_LINE)],
        choices: [makeChoice(SCENE_2_CHOICE_A, 0), makeChoice(SCENE_2_CHOICE_B, 1)],
      },
    ]);
    const error = caught(() => joinNarrativeToLocalization(structure, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("byte_range");
  });

  // --- Guard: source-hash mismatch (structure vs bundle) ---
  it("fails loud when the structure and bundle describe different source bytes", () => {
    const bundle = loadBridgeBundle();
    const structure: NarrativeStructure = {
      ...wellFormedStructure(),
      sourceBundleHash: "sha256:deadbeef",
    };
    const error = caught(() => joinNarrativeToLocalization(structure, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("bundle_hash");
  });

  // --- Guard: absent bundle hash is rejected (no optional-skip) ---
  it("fails loud when the structure carries no sourceBundleHash", () => {
    const bundle = loadBridgeBundle();
    const structure: NarrativeStructure = { ...wellFormedStructure() };
    delete (structure as { sourceBundleHash?: string }).sourceBundleHash;
    const error = caught(() => joinNarrativeToLocalization(structure, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("bundle_hash");
  });

  // --- Guard: recomputed unit sourceHash must match its sourceText ---
  it("fails loud when a unit's sourceHash does not recompute from its sourceText", () => {
    const bundle = loadBridgeBundle();
    // Mutation: tamper a unit's sourceText so its committed sourceHash no
    // longer recomputes. Deleting the recompute guard would bind unverified
    // bytes.
    const tamperedUnits = bundle.units.map((unit, index) =>
      index === 0 ? { ...unit, sourceText: `${unit.sourceText}TAMPERED` } : unit,
    );
    const tampered: BridgeBundleV02 = { ...bundle, units: tamperedUnits };
    const error = caught(() => joinNarrativeToLocalization(wellFormedStructure(), tampered));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("source_hash");
  });

  // --- Guard: sourceUnitKey mismatch ---
  it("fails loud when a bound unit's sourceUnitKey does not match", () => {
    const bundle = loadBridgeBundle();
    const mismatched = structureFor([
      scene(1, [
        { ...SCENE_1_LINE, sourceUnitKey: "reallive:scene-0001#9999" },
        SCENE_1_CHOICE_A,
        SCENE_1_CHOICE_B,
      ]),
      scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B]),
    ]);
    const error = caught(() => joinNarrativeToLocalization(mismatched, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("source_unit_key");
  });

  // --- Guard: source-asset equality ---
  it("fails loud when a bound unit's source asset does not match", () => {
    const bundle = loadBridgeBundle();
    const mismatched = structureFor([
      scene(1, [
        { ...SCENE_1_LINE, assetId: SCENE_2_LINE.assetId },
        SCENE_1_CHOICE_A,
        SCENE_1_CHOICE_B,
      ]),
      scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B]),
    ]);
    const error = caught(() => joinNarrativeToLocalization(mismatched, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("source_asset");
  });

  // --- Guard: bound unit's source asset must be a declared bundle asset ---
  it("fails loud when a bound unit references an asset not declared in the bundle", () => {
    const bundle = loadBridgeBundle();
    const undeclaredAsset = "22222222-2222-7222-8222-222222222222";
    // Mutation: point unit[0]'s sourceAssetRef at an asset the bundle does not
    // declare, and have the narrative link agree with that (bad) asset — so the
    // equality guard passes and only the "declared" guard can catch it.
    const tamperedUnits = bundle.units.map((unit, index) =>
      index === 0
        ? { ...unit, sourceAssetRef: { ...unit.sourceAssetRef, assetId: undeclaredAsset } }
        : unit,
    );
    const tampered: BridgeBundleV02 = { ...bundle, units: tamperedUnits };
    const structure = structureFor([
      scene(1, [{ ...SCENE_1_LINE, assetId: undeclaredAsset }, SCENE_1_CHOICE_A, SCENE_1_CHOICE_B]),
      scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B]),
    ]);
    const error = caught(() => joinNarrativeToLocalization(structure, tampered));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("source_asset");
  });

  // --- Guard: link kind must match the unit's surfaceKind ---
  it("fails loud when a line link binds a choice_label unit", () => {
    const bundle = loadBridgeBundle();
    // A NarrativeUnit whose choiceId is null (→ kind "line") but which points
    // at a choice_label bundle unit (CHOICE_A), retaining that unit's key and
    // range. Without the kind check this returned a line binding to a
    // choice_label unit.
    const miskinded: NarrativeUnit = {
      ...makeNarrativeUnit({ ...SCENE_1_CHOICE_A, isChoice: false }, 0),
      choiceId: null,
    };
    const structure = structureFor([
      {
        sceneId: sceneRef(1),
        selectionControl: "none",
        nextScene: null,
        messages: [],
        choices: [],
        units: [miskinded],
      },
    ]);
    const error = caught(() => joinNarrativeToLocalization(structure, bundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("surface_kind");
  });

  // --- Guard: a `line` link must reject a valid NON-narrative surface kind ---
  it("fails loud when a line link binds a non-narrative surface (ui_label)", () => {
    const bundle = loadBridgeBundle();
    // Mutation: unit[0] (SCENE_1_LINE) is a schema-valid `ui_label`, not a
    // spoken/narrated line. Key, asset, range, source hash, and bundle hash all
    // still agree, so the ONLY thing that may reject it is the narrative-surface
    // allowlist — "anything != choice_label" would have accepted it.
    const uiUnits = bundle.units.map((unit, index) =>
      index === 0
        ? { ...unit, surfaceKind: "ui_label", context: { ...unit.context, ui: { uiArea: "menu" } } }
        : unit,
    );
    const uiBundle = { ...bundle, units: uiUnits } as BridgeBundleV02;
    const error = caught(() => joinNarrativeToLocalization(wellFormedStructure(), uiBundle));
    expect(error).toBeInstanceOf(SourceBindingMismatchError);
    expect((error as SourceBindingMismatchError).reason).toBe("surface_kind");
  });

  // --- Guard: a bridge_linked message with no ref must FAIL, not be skipped ---
  it("fails loud when a bridge_linked message carries no bridgeRef", () => {
    const bundle = loadBridgeBundle();
    const refless: NarrativeMessage = {
      order: 0,
      speaker: null,
      text: "",
      textSurface: null,
      engineEvidence: realliveEvidence(
        SCENE_1_LINE.startByte,
        SCENE_1_LINE.endByte - SCENE_1_LINE.startByte,
      ),
      sourceAsset: { assetId: SCENE_1_LINE.assetId, assetKey: "" },
      bridgeRef: null,
      linkageStatus: "bridge_linked",
    };
    const structure = structureFor([
      {
        sceneId: sceneRef(1),
        selectionControl: "none",
        nextScene: null,
        messages: [refless],
        choices: [],
      },
    ]);
    expect(() => joinNarrativeToLocalization(structure, bundle)).toThrowError(
      IncompleteNarrativeLinkError,
    );
  });

  // --- Guard: a bridge-linked element missing byte coordinates must FAIL ---
  it("fails loud when a bridge_linked message carries no byte coordinates", () => {
    const bundle = loadBridgeBundle();
    const noCoords: NarrativeMessage = {
      ...makeMessage(SCENE_1_LINE),
      engineEvidence: realliveEvidence(null, null),
    };
    const structure = structureFor([
      {
        sceneId: sceneRef(1),
        selectionControl: "none",
        nextScene: null,
        messages: [noCoords],
        choices: [],
      },
    ]);
    expect(() => joinNarrativeToLocalization(structure, bundle)).toThrowError(
      IncompleteNarrativeLinkError,
    );
  });

  // --- Guard: distinct narrative positions colliding on one bridgeUnitId ---
  it("fails loud when two distinct narrative positions share a bridgeUnitId", () => {
    const bundle = loadBridgeBundle();
    // Two flat units both reference SCENE_1_LINE's bridge unit: the first with
    // its correct range, the second a distinct choice with range 999..1000.
    // Global dedup would silently drop the second; the consistency check fails.
    const first = makeNarrativeUnit(SCENE_1_LINE, 0);
    const conflicting: NarrativeUnit = {
      ...makeNarrativeUnit(SCENE_1_LINE, 1),
      choiceId: "choice-conflict",
      surfaceKind: "choice_label",
      engineEvidence: realliveEvidence(999, 1),
    };
    const structure = structureFor([
      {
        sceneId: sceneRef(1),
        selectionControl: "none",
        nextScene: null,
        messages: [],
        choices: [],
        units: [first, conflicting],
      },
    ]);
    expect(() => joinNarrativeToLocalization(structure, bundle)).toThrowError(
      ConflictingNarrativeLinkError,
    );
  });

  // --- Guard: unreferenced active units are rejected, not returned as data ---
  it("fails loud when an active bundle unit binds to no narrative position", () => {
    const bundle = loadBridgeBundle();
    // Reference only scene 1's three units; scene 2's three units are then
    // unreferenced and must be rejected (never returned as data).
    const partial = structureFor([scene(1, [SCENE_1_LINE, SCENE_1_CHOICE_A, SCENE_1_CHOICE_B])]);
    const error = caught(() => joinNarrativeToLocalization(partial, bundle));
    expect(error).toBeInstanceOf(UnreferencedLocalizationUnitError);
    expect((error as UnreferencedLocalizationUnitError).bridgeUnitIds).toHaveLength(3);
  });
});
