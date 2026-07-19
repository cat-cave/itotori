// Roster proofs — every clause fails if its guarantee is removed.
//
// Clause 1: exactly THREE executable profile shapes; a fourth is rejected; each
//           specialist carries all required immutable fields + a validator.
// Clause 2: the manifest is EXACTLY the 19 roles; missing/duplicate fails.
// Clause 3: the roster defaults to ALL roles.
// Clause 4: every role resolves to deepseek-v4-flash via the certified profile;
//           a provider-named or wrong-model role is rejected at construction.

import { describe, expect, it } from "vitest";

import { RoleIdSchema, type RoleId } from "../src/contracts/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import {
  DEFAULT_ROSTER_SELECTION,
  EXECUTABLE_PROFILE_SHAPES,
  PROFILE_SHAPES,
  ROLE_ID_UNIVERSE,
  ROSTER,
  ROSTER_SPECIALISTS,
  defineSpecialist,
  shapeContract,
  toolsForRole,
  validateRosterManifest,
  type Specialist,
  type SpecialistDeclaration,
} from "../src/roster/index.js";
import { TOOL_ROLE_ALLOWLIST } from "../src/read-tools/access.js";

const EXPECTED_ROLES: readonly RoleId[] = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
  "P1",
  "P2",
  "P3",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "Q5",
  "Q6",
];

const RESOLVED_MODEL = "deepseek/deepseek-v4-flash";

function analystDeclaration(roleId: RoleId): SpecialistDeclaration {
  return {
    roleId,
    shape: "analyst",
    version: `itotori.role.${roleId}.test`,
    instructions: "test specialist",
    granularity: "per-game",
    wikiObjectKind: "style-contract",
    modelProfileKey: deepSeekV4FlashProfile.profileId,
    dagPosition: { stage: "pre-production", upstream: [], downstream: [] },
  };
}

describe("clause 1 — exactly three executable profile shapes", () => {
  it("declares precisely analyst, localizer, reviewer", () => {
    expect([...PROFILE_SHAPES]).toEqual(["analyst", "localizer", "reviewer"]);
    expect(Object.keys(EXECUTABLE_PROFILE_SHAPES).sort()).toEqual([
      "analyst",
      "localizer",
      "reviewer",
    ]);
  });

  it("rejects a fourth shape at lookup", () => {
    expect(() => shapeContract("planner")).toThrow(/not executable/);
    expect(() => shapeContract("orchestrator")).toThrow(/not executable/);
  });

  it("rejects a fourth shape at specialist construction", () => {
    expect(() =>
      defineSpecialist({
        ...analystDeclaration("A1"),
        // @ts-expect-error — a fourth shape is not constructible.
        shape: "planner",
      }),
    ).toThrow(/not executable/);
  });

  it("each specialist carries every required immutable field and a validator", () => {
    for (const specialist of ROSTER_SPECIALISTS) {
      expect(typeof specialist.version).toBe("string");
      expect(specialist.instructions.length).toBeGreaterThan(0);
      expect(specialist.input).toBeDefined();
      expect(specialist.output).toBeDefined();
      expect(Array.isArray(specialist.tools)).toBe(true);
      expect(typeof specialist.granularity).toBe("string");
      expect(specialist.dagPosition.stage).toBeDefined();
      expect(specialist.wikiObjectKind).toBeDefined();
      expect(specialist.modelProfileKey).toBe(deepSeekV4FlashProfile.profileId);
      expect(specialist.limits.maxSteps).toBeGreaterThan(0);
      expect(typeof specialist.validate).toBe("function");
      // The specialist is immutable data.
      expect(Object.isFrozen(specialist)).toBe(true);
      expect(Object.isFrozen(specialist.reasoning)).toBe(true);
      expect(Object.isFrozen(specialist.limits)).toBe(true);
    }
  });

  it("the tool allowlist is DATA derived from the read-tool permission table", () => {
    for (const specialist of ROSTER_SPECIALISTS) {
      const expected = toolsForRole(specialist.roleId);
      expect([...specialist.tools]).toEqual([...expected]);
      for (const tool of specialist.tools) {
        expect(TOOL_ROLE_ALLOWLIST[tool]).toContain(specialist.roleId);
      }
    }
  });

  it("each shape's semantic validator rejects a schema-invalid output", () => {
    // CANNOT_ASSESS may never pass: a verdict that omits its evidence request
    // is flagged by the reviewer validator.
    const reviewer = EXECUTABLE_PROFILE_SHAPES.reviewer;
    const issues = reviewer.validate({
      snapshotId: `sha256:${"0".repeat(64)}`,
      verdicts: [
        {
          unitId: "unit-1",
          verdict: "CANNOT_ASSESS",
          severity: "none",
          category: "meaning",
          span: null,
          evidenceIds: [],
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => /never passes/.test(issue.message))).toBe(true);
  });
});

describe("clause 2 — the manifest is exactly the 19 roles", () => {
  it("contains precisely A1-A10, P1-P3, Q1-Q6", () => {
    expect(Object.keys(ROSTER).sort()).toEqual([...EXPECTED_ROLES].sort());
    expect([...ROLE_ID_UNIVERSE]).toEqual([...RoleIdSchema.options]);
    expect(ROSTER_SPECIALISTS).toHaveLength(19);
  });

  it("fails validation when a role is missing", () => {
    const missing = ROSTER_SPECIALISTS.filter((specialist) => specialist.roleId !== "A5");
    expect(() => validateRosterManifest(missing)).toThrow(/missing roles: A5/);
  });

  it("fails validation on a duplicate role", () => {
    const duplicated: Specialist[] = [...ROSTER_SPECIALISTS, ROSTER.Q6];
    expect(() => validateRosterManifest(duplicated)).toThrow(/duplicate role: Q6/);
  });

  it("fails validation when an extra role is present", () => {
    const extra = {
      ...ROSTER.Q6,
      roleId: "X1",
    } as unknown as Specialist;
    expect(() => validateRosterManifest([...ROSTER_SPECIALISTS, extra])).toThrow(
      /unexpected role: X1/,
    );
  });

  it("fails a forged 19-entry manifest when a specialist is incomplete", () => {
    const incomplete = ROSTER_SPECIALISTS.map(
      (specialist) => ({ roleId: specialist.roleId }) as unknown as Specialist,
    );
    expect(() => validateRosterManifest(incomplete)).toThrow(/must be immutable data/);
  });

  it("runs the semantic validator for every declared role", () => {
    for (const specialist of ROSTER_SPECIALISTS) {
      const issues = specialist.validate(undefined);
      expect(issues.length, specialist.roleId).toBeGreaterThan(0);
      expect(issues.every((issue) => issue.path.length > 0 && issue.message.length > 0)).toBe(true);
    }
  });
});

describe("clause 3 — defaults to all roles", () => {
  it("the default selection is the whole roster", () => {
    expect([...DEFAULT_ROSTER_SELECTION].sort()).toEqual([...EXPECTED_ROLES].sort());
    expect(DEFAULT_ROSTER_SELECTION).toHaveLength(19);
  });
});

describe("clause 4 — every role resolves to deepseek-v4-flash, no provider ownership", () => {
  it("resolves every role to the certified deepseek-v4-flash profile", () => {
    for (const specialist of ROSTER_SPECIALISTS) {
      expect(specialist.modelProfileKey).toBe("deepseek-v4-flash");
      expect(specialist.resolvedModel).toBe(RESOLVED_MODEL);
    }
  });

  it("rejects a provider-named model-profile key at construction", () => {
    expect(() =>
      defineSpecialist({
        ...analystDeclaration("A1"),
        modelProfileKey: "deepseek-v4-flash-fireworks",
      }),
    ).toThrow(/must not name a provider/);
  });

  it("rejects a wrong-model role at construction", () => {
    expect(() =>
      defineSpecialist({
        ...analystDeclaration("A1"),
        modelProfileKey: "gpt-5-turbo",
      }),
    ).toThrow(/does not match its certified binding/);
  });

  it("rejects a role cast onto the wrong shape family", () => {
    expect(() =>
      defineSpecialist({
        ...analystDeclaration("P1"),
        shape: "analyst",
      }),
    ).toThrow(/must be cast onto the localizer shape/);
  });
});

describe("PROOF — the exactly-19 roster all resolving to deepseek-v4-flash", () => {
  it("emits the resolution table", () => {
    const rows = ROSTER_SPECIALISTS.map(
      (specialist) =>
        `${specialist.roleId.padEnd(3)} ${specialist.shape.padEnd(9)} ${specialist.modelProfile.padEnd(9)} ${specialist.modelProfileKey} -> ${specialist.resolvedModel}`,
    );
    // eslint-disable-next-line no-console
    console.log(`\nROSTER (${ROSTER_SPECIALISTS.length} roles):\n${rows.join("\n")}`);
    expect(rows).toHaveLength(19);
    expect(rows.every((row) => row.endsWith(RESOLVED_MODEL))).toBe(true);
  });
});
