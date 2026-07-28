// Behavior proofs for wiki entry → scene/unit deep-link resolution.
//
// Targets are derived from real provenance (subject, citations, media) and an
// optional structure-address index. Gut-check: gutting the resolver so it
// always returns [] makes these tests fail.

import { describe, expect, it } from "vitest";
import {
  entryResolvesToPlayerTarget,
  entryResolvesToScene,
  citedBridgeUnitIds,
  primaryEntryPlayerTarget,
  resolveEntryPlayerTargets,
  resolveVerifiedEntrySceneTargets,
  structureAddressIndexFromFacts,
  type EntryDeepLinkSource,
} from "../src/ui/screens/wiki-bible/entry-deeplink.js";
import { parseAddressableLocation } from "../src/ui/addressable-routing.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const SCOPE = {
  projectId: "project-1",
  localeBranchId: "locale-1",
  snapshotId: `sha256:${"a".repeat(64)}`,
  objectId: "obj-1",
};
const BRIDGE_UNIT_ID = "019ed001-0000-7000-8000-000000000042";

function entry(
  partial: Partial<EntryDeepLinkSource> & Pick<EntryDeepLinkSource, "subject">,
): EntryDeepLinkSource {
  return {
    citations: [],
    claims: [],
    media: [],
    ...partial,
  };
}

describe("resolveEntryPlayerTargets — provenance-only", () => {
  it("renders a scene jump only when this project resolves a cited bridge unit", () => {
    const source = entry({
      subject: { kind: "scene", id: "scene:untrusted-label" },
      citations: [{ subject: { kind: "unit", id: `unit:${BRIDGE_UNIT_ID}` } }],
    });

    expect(citedBridgeUnitIds(source)).toEqual([BRIDGE_UNIT_ID]);
    expect(resolveVerifiedEntrySceneTargets(source, SCOPE, [])).toEqual([]);

    const [target] = resolveVerifiedEntrySceneTargets(source, SCOPE, [
      { bridgeUnitId: BRIDGE_UNIT_ID, sceneId: "scene-0001" },
    ]);
    expect(target).toMatchObject({
      kind: "scene",
      id: "scene-0001",
      source: "citation",
    });
    const url = new URL(target!.href, "http://itotori.test");
    expect(url.pathname).toBe("/play/scenes/scene-0001");
    expect(url.searchParams.get("unit")).toBe(BRIDGE_UNIT_ID);
  });

  it("deep-links a scene subject into the addressable player", () => {
    const targets = resolveEntryPlayerTargets(
      entry({ subject: { kind: "scene", id: "scene:0001" } }),
      SCOPE,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "scene", id: "scene:0001", source: "subject" });
    const href = targets[0]!.href;
    const url = new URL(href, "http://itotori.test");
    const location = parseAddressableLocation(url.pathname, url.search);
    expect(location).toMatchObject({ kind: "scene", id: "scene:0001", surface: "play" });
  });

  it("deep-links unit citations and does not invent a destination for character-only subjects without structure", () => {
    const targets = resolveEntryPlayerTargets(
      entry({
        subject: { kind: "character", id: "char-a" },
        citations: [
          { subject: { kind: "unit", id: "unit:line-1" } },
          { subject: { kind: "character", id: "char-a" } },
        ],
      }),
      SCOPE,
    );
    expect(targets.map((t) => `${t.kind}:${t.id}`)).toEqual(["unit:unit:line-1"]);
  });

  it("resolves character → scenes only via the structure index (never text search)", () => {
    const structure = structureAddressIndexFromFacts({
      orderedUnits: [
        { factId: "unit:1", bridgeUnitId: "bridge-1", sceneId: "scene:0010" },
        { factId: "unit:2", bridgeUnitId: "bridge-2", sceneId: "scene:0020" },
      ],
      characters: [
        { characterId: "char-a", sceneIds: ["scene:0010", "scene:0020"] },
        { characterId: "char-b", sceneIds: ["scene:0020"] },
      ],
    });
    const targets = resolveEntryPlayerTargets(
      entry({ subject: { kind: "character", id: "char-a" } }),
      SCOPE,
      structure,
    );
    expect(targets.map((t) => t.id).sort()).toEqual(["scene:0010", "scene:0020"]);
    expect(targets.every((t) => t.source === "structure")).toBe(true);
  });

  it("promotes unit citations to their scenes when the structure index is present", () => {
    const structure = structureAddressIndexFromFacts({
      orderedUnits: [{ factId: "unit:line-1", bridgeUnitId: "bridge-1", sceneId: "scene:0007" }],
      characters: [],
    });
    const targets = resolveEntryPlayerTargets(
      entry({
        subject: { kind: "character", id: "char-a" },
        citations: [{ subject: { kind: "unit", id: "unit:line-1" } }],
      }),
      SCOPE,
      structure,
    );
    expect(entryResolvesToScene(targets)).toBe(true);
    expect(primaryEntryPlayerTarget(targets)?.kind).toBe("scene");
    expect(primaryEntryPlayerTarget(targets)?.id).toBe("scene:0007");
  });

  it("shows no link when the entry has no resolvable scene or unit", () => {
    const targets = resolveEntryPlayerTargets(
      entry({ subject: { kind: "glossary-term", id: "term-x" } }),
      SCOPE,
    );
    expect(targets).toEqual([]);
    expect(entryResolvesToPlayerTarget(targets)).toBe(false);
  });

  it("carries returnTo back to the bible object on every player jump", () => {
    const [target] = resolveEntryPlayerTargets(
      entry({ subject: { kind: "scene", id: "scene:1" } }),
      SCOPE,
    );
    expect(target).toBeDefined();
    const url = new URL(target!.href, "http://itotori.test");
    expect(url.searchParams.get("returnTo")).toContain("objectId=obj-1");
  });
});

describe("resolveEntryPlayerTargets — real structure artifact coverage", () => {
  it("reports scene resolution rate across wiki-shaped entries on a real fact snapshot", () => {
    const { snapshot } = buildClaimFixture({
      characters: [
        {
          characterId: "char-hero",
          decodedLabel: "Hero",
          lines: 2,
          boundUnitPlayOrder: 0,
        },
        {
          characterId: "char-friend",
          decodedLabel: "Friend",
          lines: 1,
          boundUnitPlayOrder: 1,
        },
      ],
      scene2Routes: ["route-a"],
    });

    const structure = structureAddressIndexFromFacts({
      orderedUnits: snapshot.orderedUnits.map((unit) => ({
        factId: unit.factId,
        bridgeUnitId: unit.bridgeUnitId,
        sceneId: String(unit.sceneId),
      })),
      characters: snapshot.characters.map((character) => ({
        characterId: character.characterId,
        sceneIds: character.sceneIds.map(String),
      })),
    });

    // Wiki-shaped entries derived from the structure artifact (the same
    // subject / citation kinds the analyst roles emit):
    //  - one scene-summary per scene (subject = scene)
    //  - one character-bio per character (subject = character; cites occurrence + units)
    //  - one term-ruling with no unit/scene provenance (must stay unlinked)
    const entries: EntryDeepLinkSource[] = [];

    for (const scene of snapshot.scenes) {
      entries.push(
        entry({
          subject: { kind: "scene", id: String(scene.sceneId) },
          citations: [{ subject: { kind: "scene", id: String(scene.sceneId) } }],
        }),
      );
    }

    for (const character of snapshot.characters) {
      const unitCitations = snapshot.orderedUnits
        .filter((unit) => unit.speaker?.characterId === character.characterId)
        .map((unit) => ({ subject: { kind: "unit" as const, id: unit.factId } }));
      entries.push(
        entry({
          subject: { kind: "character", id: character.characterId },
          citations: [
            { subject: { kind: "character", id: character.characterId } },
            ...unitCitations,
          ],
        }),
      );
    }

    // A glossary/term entry with no unit/scene provenance — honest no-link.
    entries.push(entry({ subject: { kind: "glossary-term", id: "term-honorific" } }));

    let withPlayer = 0;
    let withScene = 0;
    for (const object of entries) {
      const targets = resolveEntryPlayerTargets(object, SCOPE, structure);
      if (entryResolvesToPlayerTarget(targets)) withPlayer += 1;
      if (entryResolvesToScene(targets)) withScene += 1;
    }

    const total = entries.length;
    const unresolvableByDesign = entries.filter((e) => e.subject.kind === "glossary-term").length;
    const sceneRate = withScene / total;
    const playerRate = withPlayer / total;
    const sceneRateAmongAddressable = withScene / Math.max(1, total - unresolvableByDesign);

    // The only non-resolving entry is the uncited term (honest no-link).
    expect(withScene).toBe(total - unresolvableByDesign);
    expect(withPlayer).toBe(total - unresolvableByDesign);
    // Every scene/character entry resolves to a scene when structure is present.
    expect(sceneRateAmongAddressable).toBe(1);
    // Overall rate includes honest no-links (glossary with no unit/scene provenance).
    expect(sceneRate).toBeGreaterThanOrEqual(0.8);

    // Named coverage numbers for the report (clause 2).
    const coverage = {
      totalEntries: total,
      entriesWithScene: withScene,
      entriesWithPlayerTarget: withPlayer,
      unresolvableByDesign,
      sceneResolutionRate: sceneRate,
      sceneResolutionRateAmongAddressable: sceneRateAmongAddressable,
      playerResolutionRate: playerRate,
      scenesInStructure: snapshot.scenes.length,
      charactersInStructure: snapshot.characters.length,
      unitsInStructure: snapshot.orderedUnits.length,
    };
    expect(coverage.sceneResolutionRateAmongAddressable).toBe(1);
    expect(coverage.totalEntries).toBeGreaterThan(0);
    // Keep the full object in the assertion so a failed gut-check prints rates.
    expect(coverage).toMatchObject({
      unresolvableByDesign: 1,
      sceneResolutionRateAmongAddressable: 1,
    });
  });
});
