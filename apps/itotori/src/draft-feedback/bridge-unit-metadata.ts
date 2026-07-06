// ALPHA-002 — Typed contract for the bridge-unit ids a feedback submission
// carries in its (otherwise loosely-typed) `metadata`.
//
// A submission's `metadata` is `Record<string, unknown>` at the repository
// boundary, so the batch service used to scan it with bare string-literal
// keys (`metadata["affectedUnitIds"]` …). That is silent-breakage-prone: a
// rename or reshape of the keys the manual-feedback importer WRITES would
// not be a compile error — the consumer would just stop finding the ids and
// return an empty/wrong bridge-unit set with no signal.
//
// This module makes that access go through ONE typed contract instead:
//
//   - `BridgeUnitMetadata`         the recognized shape (every key optional,
//                                  each a `readonly string[]`);
//   - `BRIDGE_UNIT_METADATA_KEYS`  the recognized keys, pinned to
//                                  `keyof BridgeUnitMetadata` so a rename of a
//                                  key in the type is a COMPILE error here;
//   - `readBridgeUnitMetadata`     validates the loose metadata against the
//                                  contract and returns the typed shape,
//                                  THROWING when a recognized key is present
//                                  but malformed (not a string array) instead
//                                  of silently dropping it.
//
// The manual-feedback importer WRITES this same shape (its
// `affectedUnitMetadata`), typed `BridgeUnitMetadata`, so a producer-side
// rename is caught at compile time on both ends of the contract.

/**
 * The bridge-unit ids a feedback submission may carry in its `metadata`.
 * Every key is optional; each names a list of bridge-unit ids. These are the
 * ONLY metadata keys recognized as bridge-unit references.
 */
export type BridgeUnitMetadata = {
  affectedUnitIds?: readonly string[];
  affectedBridgeUnitIds?: readonly string[];
  bridgeUnitIds?: readonly string[];
  unitIds?: readonly string[];
};

/**
 * The recognized keys, pinned to `keyof BridgeUnitMetadata`. Renaming a key
 * on the type without updating this tuple (or vice versa) is a compile error,
 * so the producer and consumer can never silently drift apart.
 */
export const BRIDGE_UNIT_METADATA_KEYS = [
  "affectedUnitIds",
  "affectedBridgeUnitIds",
  "bridgeUnitIds",
  "unitIds",
] as const satisfies ReadonlyArray<keyof BridgeUnitMetadata>;

/** Raised when a recognized bridge-unit metadata key is present but malformed. */
export class BridgeUnitMetadataError extends Error {
  constructor(
    readonly key: (typeof BRIDGE_UNIT_METADATA_KEYS)[number],
    message: string,
  ) {
    super(message);
    this.name = "BridgeUnitMetadataError";
  }
}

/**
 * Read a submission's loosely-typed `metadata` through the typed contract.
 *
 * Absent and unrecognized keys are ignored. A recognized key that is present
 * but is NOT a `readonly string[]` is a hard `BridgeUnitMetadataError` — a
 * malformed shape is CAUGHT here, never silently mis-scanned into an empty or
 * wrong bridge-unit set. Well-formed input maps 1:1 to `BridgeUnitMetadata`.
 */
export function readBridgeUnitMetadata(
  metadata: Record<string, unknown> | undefined,
): BridgeUnitMetadata {
  if (metadata === undefined) {
    return {};
  }
  const typed: BridgeUnitMetadata = {};
  for (const key of BRIDGE_UNIT_METADATA_KEYS) {
    const value = metadata[key];
    if (value === undefined) {
      continue;
    }
    typed[key] = asBridgeUnitIdArray(value, key);
  }
  return typed;
}

function asBridgeUnitIdArray(
  value: unknown,
  key: (typeof BRIDGE_UNIT_METADATA_KEYS)[number],
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new BridgeUnitMetadataError(
      key,
      `feedback metadata "${key}" must be an array of bridge-unit ids`,
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new BridgeUnitMetadataError(
        key,
        `feedback metadata "${key}" must contain only string bridge-unit ids`,
      );
    }
  }
  return value as readonly string[];
}
