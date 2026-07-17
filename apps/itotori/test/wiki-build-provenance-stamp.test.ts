import { describe, expect, it } from "vitest";
import { stampSourceProvenance } from "../src/composition/wiki-build-entrypoint.js";
import { STYLE_LEAD_FEW_SHOT_EXAMPLE } from "../src/roles/a1/spec.js";
import { WikiObjectSchema } from "../src/contracts/index.js";

// A real, schema-valid source style-contract with its OWN (non-authoritative)
// provenance — stands in for a model output whose provenance the analyst authored.
const modelAuthored = WikiObjectSchema.parse(STYLE_LEAD_FEW_SHOT_EXAMPLE);

const AUTHORITATIVE_SNAPSHOT = `sha256:${"f".repeat(64)}` as const;
const AUTHORITATIVE_SUBJECT = { kind: "game", id: "authoritative-game" } as const;

describe("stampSourceProvenance", () => {
  it("overwrites the model's provenance identifiers with the authoritative run context", () => {
    // Live on real bytes the analyst emitted a zero snapshot hash and a WRONG
    // runMode ("production" during a test-dev run); the few-shot carries its own
    // snapshot id + run mode. Either way, the system-owned fields must win.
    const [stamped] = stampSourceProvenance([modelAuthored], {
      contextSnapshotId: AUTHORITATIVE_SNAPSHOT,
      contextScope: "whole-game",
      runMode: "test-dev",
      authorRoleId: "A1",
      subject: AUTHORITATIVE_SUBJECT,
      scope: { kind: "global" },
    });

    expect(stamped).toBeDefined();
    expect(stamped.provenance.contextSnapshotId).toBe(AUTHORITATIVE_SNAPSHOT);
    expect(stamped.provenance.runMode).toBe("test-dev");
    expect(stamped.provenance.authorRoleId).toBe("A1");
    if (stamped.provenance.snapshotKind === "context") {
      expect(stamped.provenance.contextScope).toBe("whole-game");
    }
    // Identity + version are system-stamped: the assigned subject overrides the
    // model's invented game id, and a first-build object is version 1.
    expect(stamped.subject).toEqual(AUTHORITATIVE_SUBJECT);
    expect(stamped.version).toBe(1);
    expect(stamped.supersedesVersion == null).toBe(true);
    // It proves an OVERWRITE, not a pass-through: the source object's own snapshot
    // id + subject differ from the authoritative ones.
    expect(modelAuthored.provenance.contextSnapshotId).not.toBe(AUTHORITATIVE_SNAPSHOT);
    expect(modelAuthored.subject).not.toEqual(AUTHORITATIVE_SUBJECT);
  });

  it("preserves the object's CONTENT (kind, body, claims) while stamping identity + provenance", () => {
    const [stamped] = stampSourceProvenance([modelAuthored], {
      contextSnapshotId: AUTHORITATIVE_SNAPSHOT,
      contextScope: "whole-game",
      runMode: "test-dev",
      authorRoleId: "A1",
      subject: AUTHORITATIVE_SUBJECT,
      scope: { kind: "global" },
    });
    expect(stamped.kind).toBe(modelAuthored.kind);
    expect(stamped.body).toEqual(modelAuthored.body);
    if (stamped.kind !== "translation" && modelAuthored.kind !== "translation") {
      expect(stamped.claims).toEqual(modelAuthored.claims);
    }
    // The stamped object is still schema-valid.
    expect(WikiObjectSchema.safeParse(stamped).success).toBe(true);
  });
});
