export class DuplicateLocalizationUnitError extends Error {
  constructor(
    public readonly key: string,
    public readonly keyKind: "bridgeUnitId" | "sourceUnitKey",
  ) {
    super(`duplicate active localization unit: two units share ${keyKind} ${key}`);
    this.name = "DuplicateLocalizationUnitError";
  }
}

/**
 * A narrative element references a bridge unit that has no active
 * localization unit in the bundle — a dangling ref. Dropping it would lose
 * a translatable narrative position, so the join refuses.
 */
export class DanglingBridgeRefError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly locator: string,
  ) {
    super(
      `dangling narrative bridge ref: ${locator} references bridgeUnitId ${bridgeUnitId} with no active localization unit`,
    );
    this.name = "DanglingBridgeRefError";
  }
}

/**
 * A narrative element and the localization unit it resolved to disagree on
 * a source-identity property (bundle hash, source asset, sourceUnitKey, byte
 * range, surface kind, or the recomputed source-text hash). A binding built
 * on drifting coordinates would patch the wrong bytes, so the join refuses.
 */
export class SourceBindingMismatchError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly reason:
      | "bundle_hash"
      | "source_asset"
      | "source_unit_key"
      | "byte_range"
      | "surface_kind"
      | "source_hash",
    public readonly locator: string,
    detail: string,
  ) {
    super(
      `source binding mismatch (${reason}) for bridgeUnitId ${bridgeUnitId} at ${locator}: ${detail}`,
    );
    this.name = "SourceBindingMismatchError";
  }
}

/**
 * A narrative element is marked as bridge-linked (or is an inherently
 * translatable choice) but carries no bridge ref or no authoritative byte
 * coordinates / source asset. Silently skipping it would drop a translatable
 * narrative position, so the join refuses.
 */
export class IncompleteNarrativeLinkError extends Error {
  constructor(
    public readonly locator: string,
    detail: string,
  ) {
    super(`incomplete bridge-linked narrative element at ${locator}: ${detail}`);
    this.name = "IncompleteNarrativeLinkError";
  }
}

/**
 * Two distinct narrative positions claim the same bridgeUnitId but disagree
 * on their source coordinates (kind, sourceUnitKey, byte range, or asset).
 * Globally de-duplicating by bridgeUnitId would silently erase one position;
 * the join refuses instead so a real conflict is never papered over.
 */
export class ConflictingNarrativeLinkError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly firstLocator: string,
    public readonly secondLocator: string,
    detail: string,
  ) {
    super(
      `conflicting narrative links for bridgeUnitId ${bridgeUnitId}: ${firstLocator} vs ${secondLocator}: ${detail}`,
    );
    this.name = "ConflictingNarrativeLinkError";
  }
}

/**
 * An active localization unit in the bundle is referenced by no narrative
 * element. The join must be complete: an unreferenced translatable unit means
 * a narrative position was lost, so the join refuses rather than return it as
 * data.
 */
export class UnreferencedLocalizationUnitError extends Error {
  constructor(public readonly bridgeUnitIds: string[]) {
    super(
      `unreferenced active localization unit(s) — every active unit must bind to a narrative position: ${bridgeUnitIds.join(", ")}`,
    );
    this.name = "UnreferencedLocalizationUnitError";
  }
}
