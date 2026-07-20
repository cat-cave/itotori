import { describe, expect, it } from "vitest";

import { FULL_ROSTER, resolveRunPolicy } from "../src/run-policy/index.js";
import { projectOutputScope, type WorkflowScene } from "../src/workflow/index.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

const scenes: readonly WorkflowScene[] = [
  {
    sceneId: "scene-1",
    units: [
      {
        unitId: "dialogue",
        sourceHash: HASH,
        surfaceKind: "dialogue",
        speakerId: null,
        routeId: null,
        firstAppearance: false,
      },
      {
        unitId: "choice",
        sourceHash: HASH,
        surfaceKind: "choice_label",
        speakerId: null,
        routeId: null,
        firstAppearance: false,
      },
      {
        unitId: "ui",
        sourceHash: HASH,
        surfaceKind: "ui_label",
        speakerId: null,
        routeId: null,
        firstAppearance: false,
      },
      {
        unitId: "asset",
        sourceHash: HASH,
        surfaceKind: "image_text",
        speakerId: null,
        routeId: null,
        firstAppearance: false,
      },
    ],
  },
];

describe("workflow output scope", () => {
  it("bounds writes without narrowing whole-game context or the A1-A10 roster", () => {
    const policy = resolveRunPolicy({
      runMode: "production",
      contextScope: "whole-game",
      outputScope: "dialogue-only",
      roster: FULL_ROSTER,
    });
    const projection = projectOutputScope(scenes, policy.outputScope);

    expect(policy.contextScope).toBe("whole-game");
    expect(policy.roster).toEqual(FULL_ROSTER);
    expect(projection.scenes[0]?.units.map((unit) => unit.unitId)).toEqual(["dialogue"]);
    expect(projection.excludedUnitIds).toEqual(["choice", "ui", "asset"]);
  });

  it("widens only the independently selected output tier", () => {
    expect(
      projectOutputScope(scenes, "dialogue-and-choices").scenes[0]?.units.map(
        (unit) => unit.unitId,
      ),
    ).toEqual(["dialogue", "choice"]);
    expect(
      projectOutputScope(scenes, "dialogue-choices-ui").scenes[0]?.units.map((unit) => unit.unitId),
    ).toEqual(["dialogue", "choice", "ui"]);
    expect(projectOutputScope(scenes, "all").scenes[0]?.units.map((unit) => unit.unitId)).toEqual([
      "dialogue",
      "choice",
      "ui",
      "asset",
    ]);
  });
});
