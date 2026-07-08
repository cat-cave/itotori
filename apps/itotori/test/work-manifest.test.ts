// itotori-multiwork-archive-manifest — tests.
//
// Proves the operator work-manifest resolves N work roots within a MULTI-WORK
// archive from entry-point metadata AND VALIDATES each against the archive:
//   (1) on a SYNTHETIC 2-work fixture (base + fandisk), BOTH declared works
//       RESOLVE (rooted at their entry-point scenes) AND VALIDATE (each
//       entry-point scene is present + reachable from the archive entry);
//   (2) a manifest whose entry-point scene is NOT in the archive is REJECTED;
//   (3) a manifest whose entry-point scene is present but UNREACHABLE from the
//       archive entry scene is REJECTED (an orphan scene);
//   (4) the manifest bridges into the carve model so the existing scope-graph
//       builder consumes an operator rooting identically to a decoded carve;
//   (5) shape violations (bad schemaVersion, duplicate workId, duplicate root
//       scene without a finer pin, non-integer scene) are REJECTED at parse;
//   (6) determinism.
//
// The fixture is a SYNTHETIC multi-work archive: scene ids + opcode-shape only
// (the `selectionControl` / dispatch-graph edges the decode emits), NO real
// game bytes. The point is the manifest schema + resolution + validation
// capability, exercised on a representative 2-work shape.

import { describe, expect, it } from "vitest";
import type {
  NarrativeScene,
  NarrativeStructure,
  SelectionControlSignal,
} from "../src/agents/structure-informed-context/index.js";
import {
  parseWorkManifest,
  resolveWorkManifest,
  resolveWorkManifestToCarve,
  WorkManifestError,
  WORK_MANIFEST_SCHEMA_VERSION,
  type WorkManifest,
} from "../src/agents/work-scope/index.js";

const ARCHIVE = "synthetic-multiwork";

// The SYNTHETIC multi-work archive decode.
//
// This mirrors the SHAPE `structure_export.rs` emits for a real multi-work
// archive whose game-select the decode CANNOT enumerate (the
// `game-select-unresolved-options` case in `carve.ts` — the real Sweetie HD
// scene-2 title MENU). Here the archive's first screen (scene 2) is a
// `button-object` select carrying NO enumerable options, but the dispatch
// graph still edges into the menu/config scene (3) AND — through a
// store-relative New-Game routine stand-in — into BOTH work root scenes
// (100 = base, 500 = fandisk). The decode alone cannot tell which dispatch
// target is a work root (the carve reports unresolved-options); the operator
// work-manifest supplies that rooting and the resolver VALIDATES it against
// this dispatch graph.
//
// Text is invented; the SHAPE (scene ids, selectionControl signals,
// nextScene/branchEntryScene dispatch edges) is the decode's.
function scene(
  sceneId: number,
  signal: SelectionControlSignal,
  nextScene: number | null,
  choices: NarrativeScene["choices"] = [],
  messages: NarrativeScene["messages"] = [],
): NarrativeScene {
  return { sceneId, selectionControl: signal, nextScene, messages, choices };
}

const SYNTHETIC_MULTIWORK_ARCHIVE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 2,
  sceneDispatchOrder: [2, 3, 9996, 100, 101, 500],
  scenes: [
    // Scene 2: the `button-object` TITLE MENU game-select. Carries NO inline
    // enumerable option block (the carve reports unresolved-options); its
    // dispatch edges (nextScene + a stand-in branchEntryScene) reach the
    // menu/config scene + the New-Game routine that roots both works.
    scene(2, "button-object", 3, [
      {
        optionIndex: 0,
        label: "",
        // A store-relative dispatch stand-in — the decode followed ONE arm of
        // the goto_case($store) into the New-Game routine (scene 9996).
        branchEntryScene: 9996,
        branchMessages: [],
      },
    ]),
    // Scene 3: a menu/config leaf.
    scene(3, "none", null),
    // Scene 9996: the New-Game routine. Its dispatch edges root BOTH works —
    // the base game (scene 100) and the fandisk (scene 500). This is the
    // structural seam the operator manifest pins entry-points against.
    scene(9996, "none", 100, [
      {
        optionIndex: 0,
        label: "",
        branchEntryScene: 500,
        branchMessages: [],
      },
    ]),
    // Scene 100: the BASE game's root. Dispatches into 101.
    scene(
      100,
      "none",
      101,
      [],
      [
        { order: 0, speaker: "Rin", text: "Base-game opening.", textSurface: null },
        { order: 1, speaker: "Mei", text: "You're early.", textSurface: null },
      ],
    ),
    scene(
      101,
      "none",
      null,
      [],
      [{ order: 0, speaker: "Rin", text: "Let's go.", textSurface: null }],
    ),
    // Scene 500: the FANDISK's root.
    scene(
      500,
      "none",
      null,
      [],
      [
        { order: 0, speaker: "Rin", text: "It's been a while.", textSurface: null },
        { order: 1, speaker: "Sae", text: "A new face for the fandisk.", textSurface: null },
      ],
    ),
    // Scene 9001: an ORPHAN scene — present in the decode but UNREACHABLE from
    // the archive entry scene (no dispatch edge points at it). A manifest that
    // pins an entry-point here must be REJECTED.
    scene(
      9001,
      "none",
      null,
      [],
      [{ order: 0, speaker: "Debug", text: "Orphan scene.", textSurface: null }],
    ),
  ],
};

// A WELL-FORMED operator work-manifest for the synthetic archive: 2 works
// (base + fandisk), each rooted at a reachable entry-point scene.
const TWO_WORK_MANIFEST: WorkManifest = {
  schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
  archiveRef: ARCHIVE,
  works: [
    {
      workId: "synthetic-multiwork#base",
      name: "Synthetic (base story)",
      entryPoint: { scene: 100 },
    },
    {
      workId: "synthetic-multiwork#fandisk",
      name: "Synthetic After (fandisk)",
      entryPoint: { scene: 500 },
    },
  ],
};

describe("parseWorkManifest (shape validation)", () => {
  it("accepts a well-formed 2-work manifest", () => {
    const manifest = parseWorkManifest(TWO_WORK_MANIFEST);
    expect(manifest.works).toHaveLength(2);
    expect(manifest.works.map((w) => w.workId)).toEqual([
      "synthetic-multiwork#base",
      "synthetic-multiwork#fandisk",
    ]);
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() =>
      parseWorkManifest({ ...TWO_WORK_MANIFEST, schemaVersion: "itotori.work-manifest.v0" }),
    ).toThrow(WorkManifestError);
  });

  it("rejects an empty archiveRef", () => {
    expect(() => parseWorkManifest({ ...TWO_WORK_MANIFEST, archiveRef: "" })).toThrow(
      WorkManifestError,
    );
  });

  it("rejects an empty works array", () => {
    expect(() => parseWorkManifest({ ...TWO_WORK_MANIFEST, works: [] })).toThrow(WorkManifestError);
  });

  it("rejects a duplicate workId", () => {
    expect(() =>
      parseWorkManifest({
        ...TWO_WORK_MANIFEST,
        works: [
          { workId: "dup", entryPoint: { scene: 100 } },
          { workId: "dup", entryPoint: { scene: 500 } },
        ],
      }),
    ).toThrow(WorkManifestError);
  });

  it("rejects a non-integer entry-point scene", () => {
    expect(() =>
      parseWorkManifest({
        ...TWO_WORK_MANIFEST,
        works: [{ workId: "w", entryPoint: { scene: 1.5 } }],
      }),
    ).toThrow(WorkManifestError);
  });

  it("rejects two works at the SAME root scene without a finer pin (not disjoint)", () => {
    expect(() =>
      parseWorkManifest({
        ...TWO_WORK_MANIFEST,
        works: [
          { workId: "a", entryPoint: { scene: 100 } },
          { workId: "b", entryPoint: { scene: 100 } },
        ],
      }),
    ).toThrow(WorkManifestError);
  });

  it("ACCEPTS two works at the same scene when disambiguated by segment (shared prologue)", () => {
    // Two works that share a dispatch scene (e.g. a shared prologue that
    // branches per-work) MAY be pinned at the same scene with a distinct
    // `segment` finer pin. Scene-level validation cannot distinguish them, so
    // the manifest carries the finer disambiguation verbatim.
    const manifest = parseWorkManifest({
      ...TWO_WORK_MANIFEST,
      works: [
        { workId: "a", entryPoint: { scene: 100, segment: "route-A" } },
        { workId: "b", entryPoint: { scene: 100, segment: "route-B" } },
      ],
    });
    expect(manifest.works).toHaveLength(2);
  });

  it("rejects a negative offset", () => {
    expect(() =>
      parseWorkManifest({
        ...TWO_WORK_MANIFEST,
        works: [{ workId: "w", entryPoint: { scene: 100, offset: -1 } }],
      }),
    ).toThrow(WorkManifestError);
  });
});

describe("resolveWorkManifest (resolve N works + VALIDATE against the archive)", () => {
  it("resolves BOTH works on the synthetic multi-work fixture + validates each reachable", () => {
    const resolved = resolveWorkManifest(TWO_WORK_MANIFEST, SYNTHETIC_MULTIWORK_ARCHIVE);
    expect(resolved.archiveRef).toBe(ARCHIVE);
    expect(resolved.works).toHaveLength(2);
    // Both works resolve at their declared entry-point scene.
    expect(resolved.works.map((w) => w.rootScene)).toEqual([100, 500]);
    // Both entry-points VALIDATE — present + reachable from the archive entry.
    expect(resolved.derivation.allEntryPointsReachable).toBe(true);
    for (const work of resolved.works) {
      expect(work.validation.reachable).toBe(true);
      expect(work.validation.status === "reachable-from-entry").toBe(true);
      expect(work.validation.dispatchDepth).toBeGreaterThan(0);
    }
    // Base (100) is reached via 2 -> 9996 -> 100 (depth 2); fandisk (500) via
    // 2 -> 9996 -> 500 (depth 2 — the choice branch from 9996). Both depth 2.
    const base = resolved.works.find((w) => w.workId.endsWith("#base"))!;
    const fandisk = resolved.works.find((w) => w.workId.endsWith("#fandisk"))!;
    expect(base.validation.dispatchDepth).toBe(2);
    expect(fandisk.validation.dispatchDepth).toBe(2);
    expect(resolved.derivation.rootedBy).toBe("operator-manifest");
  });

  it("the archive entry scene itself validates as a work root (depth 0, status present)", () => {
    // An operator MAY pin a work at the archive's own entry scene (scene 2).
    const manifest: WorkManifest = {
      schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
      archiveRef: ARCHIVE,
      works: [{ workId: "entry", entryPoint: { scene: 2 } }],
    };
    const resolved = resolveWorkManifest(manifest, SYNTHETIC_MULTIWORK_ARCHIVE);
    expect(resolved.works[0]!.validation.reachable).toBe(true);
    expect(resolved.works[0]!.validation.status).toBe("present");
    expect(resolved.works[0]!.validation.dispatchDepth).toBe(0);
  });

  it("REJECTS a manifest whose entry-point scene is NOT in the archive (missing)", () => {
    const bad: WorkManifest = {
      schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
      archiveRef: ARCHIVE,
      works: [
        { workId: "ok", entryPoint: { scene: 100 } },
        { workId: "ghost", entryPoint: { scene: 4242 } },
      ],
    };
    expect(() => resolveWorkManifest(bad, SYNTHETIC_MULTIWORK_ARCHIVE)).toThrow(WorkManifestError);
    // With rejectOnValidationFailure:false it returns a partial result whose
    // ghost work carries a missing-entry diagnostic.
    const partial = resolveWorkManifest(bad, SYNTHETIC_MULTIWORK_ARCHIVE, {
      rejectOnValidationFailure: false,
    });
    expect(partial.derivation.allEntryPointsReachable).toBe(false);
    const ghost = partial.works.find((w) => w.workId === "ghost")!;
    expect(ghost.validation.reachable).toBe(false);
    expect(ghost.validation.status).toBe("missing");
    expect(ghost.validation.reason).toContain("not present");
    // The ok work still validated.
    expect(partial.works.find((w) => w.workId === "ok")!.validation.reachable).toBe(true);
  });

  it("REJECTS a manifest whose entry-point scene is present but UNREACHABLE (orphan)", () => {
    // Scene 9001 is in the decode but NO dispatch edge reaches it.
    const bad: WorkManifest = {
      schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
      archiveRef: ARCHIVE,
      works: [{ workId: "orphan", entryPoint: { scene: 9001 } }],
    };
    expect(() => resolveWorkManifest(bad, SYNTHETIC_MULTIWORK_ARCHIVE)).toThrow(WorkManifestError);
    const partial = resolveWorkManifest(bad, SYNTHETIC_MULTIWORK_ARCHIVE, {
      rejectOnValidationFailure: false,
    });
    const orphan = partial.works[0]!;
    expect(orphan.validation.reachable).toBe(false);
    expect(orphan.validation.status).toBe("unreachable");
    expect(orphan.validation.reason).toContain("NOT reachable");
  });

  it("rejects when ALL entry-points are bad (surfaces every failure in the message)", () => {
    const bad: WorkManifest = {
      schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
      archiveRef: ARCHIVE,
      works: [
        { workId: "ghost", entryPoint: { scene: 4242 } },
        { workId: "orphan", entryPoint: { scene: 9001 } },
      ],
    };
    try {
      resolveWorkManifest(bad, SYNTHETIC_MULTIWORK_ARCHIVE);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkManifestError);
      const msg = (err as WorkManifestError).message;
      expect(msg).toContain("ghost");
      expect(msg).toContain("orphan");
    }
  });

  it("is deterministic (same manifest + archive → identical resolution)", () => {
    const a = resolveWorkManifest(TWO_WORK_MANIFEST, SYNTHETIC_MULTIWORK_ARCHIVE);
    const b = resolveWorkManifest(TWO_WORK_MANIFEST, SYNTHETIC_MULTIWORK_ARCHIVE);
    expect(a).toEqual(b);
  });
});

describe("resolveWorkManifestToCarve (bridge into the work-scope carve model)", () => {
  it("produces a WorkCarve-compatible view the scope-graph builder consumes", () => {
    const { resolved, carve } = resolveWorkManifestToCarve(
      TWO_WORK_MANIFEST,
      SYNTHETIC_MULTIWORK_ARCHIVE,
    );
    // Resolved manifest carried through.
    expect(resolved.works).toHaveLength(2);
    // Carve view: 2 works in manifest order, each with its dispatch root.
    expect(carve.archiveRef).toBe(ARCHIVE);
    expect(carve.works).toHaveLength(2);
    expect(carve.works.map((w) => w.branchEntryScene)).toEqual([100, 500]);
    expect(carve.works.map((w) => w.optionIndex)).toEqual([0, 1]);
    // Names rode through from the manifest (the `provided` naming signal).
    expect(carve.works[0]!.optionLabel).toContain("base");
    expect(carve.works[1]!.optionLabel).toContain("fandisk");
    expect(carve.derivation.signal).toBe("operator-manifest");
    expect(carve.derivation.namingSignal).toBe("provided");
    // The base root scene (100) has 2 messages and 2 distinct speakers.
    const base = carve.works.find((w) => w.workId.endsWith("#base"))!;
    expect(base.branchMessageCount).toBe(2);
    expect(base.branchSpeakers).toEqual(["Rin", "Mei"]);
  });

  it("reports namingSignal=unknown when the manifest carries no work names", () => {
    const unnamed: WorkManifest = {
      schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
      archiveRef: ARCHIVE,
      works: [
        { workId: "a", entryPoint: { scene: 100 } },
        { workId: "b", entryPoint: { scene: 500 } },
      ],
    };
    const { carve } = resolveWorkManifestToCarve(unnamed, SYNTHETIC_MULTIWORK_ARCHIVE);
    expect(carve.derivation.namingSignal).toBe("unknown");
  });

  it("propagates the validation rejection (bad entry-point) through the bridge", () => {
    const bad: WorkManifest = {
      schemaVersion: WORK_MANIFEST_SCHEMA_VERSION,
      archiveRef: ARCHIVE,
      works: [{ workId: "ghost", entryPoint: { scene: 4242 } }],
    };
    expect(() => resolveWorkManifestToCarve(bad, SYNTHETIC_MULTIWORK_ARCHIVE)).toThrow(
      WorkManifestError,
    );
  });
});
