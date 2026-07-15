import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NARRATIVE_STRUCTURE_V1,
  NARRATIVE_STRUCTURE_V2,
  NarrativeStructureParseError,
  NarrativeStructureVersionError,
  parseNarrativeStructure,
  reduceCharacterOccurrences,
  reduceNarrativeStructure,
  reduceRouteGraph,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
} from "../src/structure/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function parseFixture(name: string) {
  return parseNarrativeStructure(fixture(name), SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS);
}

describe("narrative structure exports", () => {
  it("parses both negotiated fixture versions deterministically", () => {
    const oldFirst = parseFixture("whole-seen-structure.json");
    const oldSecond = parseFixture("whole-seen-structure.json");
    const additiveFirst = parseFixture("narrative-structure-v2.json");
    const additiveSecond = parseFixture("narrative-structure-v2.json");

    expect(oldFirst).toStrictEqual(oldSecond);
    expect(additiveFirst).toStrictEqual(additiveSecond);
    expect(oldFirst.schemaVersion).toBe(NARRATIVE_STRUCTURE_V1);
    expect(additiveFirst.schemaVersion).toBe(NARRATIVE_STRUCTURE_V2);
    expect(oldFirst.scenes[0]?.messages[0]?.characterId).toBeNull();
  });

  it("rejects unsupported and unnegotiated export versions", () => {
    expect(() =>
      parseNarrativeStructure(fixture("narrative-structure-v2.json"), [NARRATIVE_STRUCTURE_V1]),
    ).toThrow(NarrativeStructureVersionError);
    expect(() =>
      parseNarrativeStructure(
        { schemaVersion: "utsushi.narrative-structure.v3" },
        SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
      ),
    ).toThrow(NarrativeStructureVersionError);
    expect(() => parseNarrativeStructure({}, SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS)).toThrow(
      NarrativeStructureVersionError,
    );
  });

  it("rejects additive fields that were not negotiated by the export version", () => {
    const value = fixture("narrative-structure-v2.json") as {
      scenes: Array<Record<string, unknown>>;
    };
    value.scenes[0]!.unexpected = true;
    expect(() => parseNarrativeStructure(value, SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS)).toThrow(
      NarrativeStructureParseError,
    );
  });
});

describe("narrative structure reductions", () => {
  it("uses only actual decoded scene targets for routes", () => {
    const routeGraph = reduceRouteGraph(parseFixture("narrative-structure-v2.json"));

    expect(routeGraph.edges).toEqual([
      { fromSceneId: 10, toSceneId: 20, kind: "dispatch" },
      { fromSceneId: 10, toSceneId: 30, kind: "dispatch" },
      { fromSceneId: 10, toSceneId: 30, kind: "choice", choiceIndex: 0 },
    ]);
    expect(JSON.stringify(routeGraph)).not.toContain("#choice");
  });

  it("counts characters by canonical ID despite changing display labels", () => {
    const structure = parseFixture("narrative-structure-v2.json");
    const characters = reduceCharacterOccurrences(structure);

    expect(characters).toEqual([
      {
        characterId: "character:ren",
        sceneIds: [10, 20, 30],
        linesByScene: [
          { sceneId: 10, lineCount: 1 },
          { sceneId: 20, lineCount: 1 },
          { sceneId: 30, lineCount: 1 },
        ],
        totalLines: 3,
        firstSceneId: 10,
        lastSceneId: 30,
      },
    ]);
    expect(JSON.stringify(characters)).not.toContain("???");
    expect(reduceCharacterOccurrences(parseFixture("whole-seen-structure.json"))).toEqual([]);
  });

  it("reduces the same negotiated export byte-for-byte consistently", () => {
    const first = reduceNarrativeStructure(parseFixture("narrative-structure-v2.json"));
    const second = reduceNarrativeStructure(parseFixture("narrative-structure-v2.json"));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
