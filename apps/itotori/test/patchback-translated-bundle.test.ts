// Proof: the translated bundle carries a target for EVERY unit — accepted text
// for in-scope units, a source-identical no-op for the rest — sourced only from
// the PatchExportV02, and fails loud on an entry that names an absent unit.

import { describe, expect, it } from "vitest";

import type { PatchExportV02 } from "@itotori/localization-bridge-schema";

import {
  bindScopedTargets,
  buildPatchExportV02,
  materializeTranslatedBundle,
  TranslatedBundleError,
} from "../src/patchback/index.js";
import type { NativePatchbackInput } from "../src/patchback/index.js";
import { buildRb024Snapshot, loadBridgeBundle, makeAccepted } from "./support/gate-fixtures.js";

/** Scope only the FIRST unit so the rest exercise the source-identical no-op. */
function partialScopeInput(): NativePatchbackInput {
  const snapshot = buildRb024Snapshot();
  const scoped = snapshot.orderedUnits[0]!;
  return {
    snapshot,
    accepted: [makeAccepted(scoped, "TRANSLATED-BODY")],
    rawBridge: loadBridgeBundle(),
    workScope: { inScopeUnitFactIds: [scoped.factId] },
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
  };
}

describe("materializeTranslatedBundle", () => {
  it("gives every unit a target: accepted text in-scope, source-identical no-op elsewhere", () => {
    const input = partialScopeInput();
    const patch = buildPatchExportV02(input, bindScopedTargets(input));
    const bundle = materializeTranslatedBundle(input.rawBridge, patch, "en-US") as {
      units: Array<{
        bridgeUnitId: string;
        sourceText: string;
        target: { locale: string; text: string };
      }>;
    };
    const bridge = loadBridgeBundle();
    expect(bundle.units).toHaveLength(bridge.units.length);
    const scopedBridgeUnitId = input.snapshot.orderedUnits[0]!.bridgeUnitId;
    for (const unit of bundle.units) {
      expect(unit.target.locale).toBe("en-US");
      if (unit.bridgeUnitId === scopedBridgeUnitId) {
        expect(unit.target.text).toBe("TRANSLATED-BODY");
      } else {
        // Out-of-scope: byte no-op — target text equals the source text verbatim.
        expect(unit.target.text).toBe(unit.sourceText);
      }
    }
  });

  it("fails loud when an export entry names a bridge unit that is absent", () => {
    const input = partialScopeInput();
    const patch = buildPatchExportV02(input, bindScopedTargets(input));
    const tampered: PatchExportV02 = {
      ...patch,
      entries: [{ ...patch.entries[0]!, bridgeUnitId: "00000000-0000-7000-8000-000000000000" }],
    };
    expect(() => materializeTranslatedBundle(input.rawBridge, tampered, "en-US")).toThrow(
      TranslatedBundleError,
    );
  });
});
