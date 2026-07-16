// Materialize the translated v0.2 BridgeBundle that `kaifuu patch --bundle`
// consumes, STRICTLY from a PatchExportV02.
//
// The translated bundle is the source-side v0.2 bridge augmented with a per-unit
// `target: { locale, text }`. Every unit receives a target: an in-scope unit gets
// its accepted target text (from the PatchExportV02 entry); every other unit gets
// `target.text = sourceText`, an explicit byte no-op the patchback carries
// byte-identical (it never decompresses that unit's scene). The target bodies are
// sourced ONLY from the PatchExportV02 entries — there is no journal read here.

import { writeFileSync } from "node:fs";

import type { PatchExportV02 } from "@itotori/localization-bridge-schema";

/** Raised when the raw bridge JSON is not shaped like a v0.2 bridge, or an
 * export entry references a unit the bridge does not carry. */
export class TranslatedBundleError extends Error {
  constructor(message: string) {
    super(`translated bundle materialization refused: ${message}`);
    this.name = "TranslatedBundleError";
  }
}

type RawUnit = Record<string, unknown> & {
  bridgeUnitId?: unknown;
  sourceText?: unknown;
};

function asRawBridge(rawBridge: unknown): Record<string, unknown> & { units: RawUnit[] } {
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new TranslatedBundleError("bridge JSON must be an object");
  }
  const record = rawBridge as Record<string, unknown>;
  if (!Array.isArray(record.units)) {
    throw new TranslatedBundleError("bridge.units must be an array");
  }
  return record as Record<string, unknown> & { units: RawUnit[] };
}

/**
 * Build the translated bridge JSON (the exact shape `TranslatedBundleV02::from_json`
 * consumes). The raw bridge is preserved field-for-field; only a per-unit `target`
 * is added. In-scope units carry their accepted target text; all others carry
 * `sourceText` (byte no-op). Fails loud if an export entry names a unit absent
 * from the bridge, or a bridge unit has no source text to fall back to.
 */
export function materializeTranslatedBundle(
  rawBridge: unknown,
  patchExport: PatchExportV02,
  targetLocale: string,
): Record<string, unknown> {
  const bridge = asRawBridge(rawBridge);
  const targetByBridgeUnitId = new Map<string, string>();
  for (const entry of patchExport.entries) {
    targetByBridgeUnitId.set(entry.bridgeUnitId, entry.targetText);
  }

  const bridgeUnitIds = new Set<string>();
  const units = bridge.units.map((unit) => {
    if (typeof unit.bridgeUnitId !== "string") {
      throw new TranslatedBundleError("bridge unit is missing a string bridgeUnitId");
    }
    if (typeof unit.sourceText !== "string") {
      throw new TranslatedBundleError(
        `bridge unit ${unit.bridgeUnitId} is missing a string sourceText`,
      );
    }
    bridgeUnitIds.add(unit.bridgeUnitId);
    const translated = targetByBridgeUnitId.get(unit.bridgeUnitId);
    // In-scope: accepted target. Out-of-scope/untranslated: source-identical
    // no-op (the patchback skips it and carries the owning scene byte-identical).
    const text = translated ?? unit.sourceText;
    return { ...unit, target: { locale: targetLocale, text } };
  });

  const unknownEntries = [...targetByBridgeUnitId.keys()].filter((id) => !bridgeUnitIds.has(id));
  if (unknownEntries.length > 0) {
    throw new TranslatedBundleError(
      `patch export names bridge unit(s) absent from the bridge: ${unknownEntries.sort().join(", ")}`,
    );
  }

  return { ...bridge, units };
}

/** Materialize + write the translated bundle JSON to disk (kaifuu reads a path). */
export function writeTranslatedBundle(
  path: string,
  rawBridge: unknown,
  patchExport: PatchExportV02,
  targetLocale: string,
): Record<string, unknown> {
  const bundle = materializeTranslatedBundle(rawBridge, patchExport, targetLocale);
  writeFileSync(path, `${JSON.stringify(bundle)}\n`);
  return bundle;
}
