// The itotori join: bind every narrative line and every choice from a
// decoded NarrativeStructure to EXACTLY ONE active localization unit in a
// v0.2 bridge bundle, proving each binding agrees on source hash and byte
// range. The structure side gives narrative position + reveal/route
// context; the bridge side owns the translatable text, its source hash,
// and its authoritative byte range. This join is the seam that lets a
// translated bundle flow back to the exact narrative position it came
// from — so a silent mis-binding (dangling ref, duplicated unit, or a
// hash/byte-range drift between the two artifacts) is a correctness bug,
// never something to paper over. Every such violation throws a typed
// error; the join never returns a partial or best-effort mapping.

import { createHash } from "node:crypto";

import type {
  BridgeBundleV02,
  ByteRangeV02,
  LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";

import type {
  NarrativeChoice,
  NarrativeMessage,
  NarrativeStructure,
  NarrativeUnit,
} from "./types.js";

/** Whether a bound narrative element is a spoken/narrated line or a choice option. */
export type NarrativeLinkKind = "line" | "choice";

/**
 * One narrative element that claims a bridge unit, normalized across the
 * message / choice / unit shapes the structure can carry. Every collected
 * link is proof-carrying by construction: `byteRange` and `sourceAssetId` are
 * REQUIRED (a narrative element that cannot supply them is rejected at
 * collection, never bound blind), so `assertSourceMatch` can prove key +
 * asset + range + hash agreement for every accepted binding.
 */
export type NarrativeLink = {
  kind: NarrativeLinkKind;
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: number;
  /** Authoritative narrative byte coordinates (required, verified vs the unit). */
  byteRange: ByteRangeV02;
  /** Owning source asset id (required, verified vs the unit's sourceAssetRef). */
  sourceAssetId: string;
  /** Human-readable locator for diagnostics (never source text). */
  locator: string;
};

/** One proven binding: a narrative link to its single active localization unit. */
export type NarrativeLocalizationBinding = {
  link: NarrativeLink;
  unit: LocalizationUnitV02;
};

export type NarrativeLocalizationJoin = {
  bindings: NarrativeLocalizationBinding[];
};

/**
 * Two active localization units in the bundle share an identity key
 * (bridgeUnitId or sourceUnitKey) — "exactly one active unit" is violated
 * at the source. Binding against an ambiguous set would silently pick one,
 * so the join refuses.
 */
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

function requireByteRange(
  byteOffsetInScene: number | null | undefined,
  byteLength: number | null | undefined,
  locator: string,
): ByteRangeV02 {
  if (typeof byteOffsetInScene !== "number" || typeof byteLength !== "number") {
    throw new IncompleteNarrativeLinkError(
      locator,
      "bridge-linked element must carry byteOffsetInScene + byteLength",
    );
  }
  return {
    startByte: byteOffsetInScene,
    endByte: byteOffsetInScene + byteLength,
  };
}

function requireSourceAssetId(
  sourceAsset: { assetId: string } | undefined,
  locator: string,
): string {
  if (!sourceAsset) {
    throw new IncompleteNarrativeLinkError(
      locator,
      "bridge-linked element must name its owning sourceAsset",
    );
  }
  return sourceAsset.assetId;
}

/**
 * A message contributes a link only when it is not runtime_only. A message
 * flagged `bridge_linked` (or carrying a bridgeRef) with no ref, or missing
 * its byte coordinates / asset, is an incomplete link and FAILS — it is never
 * silently skipped.
 */
function messageLink(
  message: NarrativeMessage,
  sceneId: number,
  locator: string,
): NarrativeLink | null {
  if (message.linkageStatus === "runtime_only") {
    return null;
  }
  const ref = message.bridgeRef;
  if (!ref) {
    if (message.linkageStatus === "bridge_linked") {
      throw new IncompleteNarrativeLinkError(
        locator,
        "message is marked bridge_linked but carries no bridgeRef",
      );
    }
    return null;
  }
  return {
    kind: "line",
    bridgeUnitId: ref.bridgeUnitId,
    sourceUnitKey: ref.sourceUnitKey,
    sceneId,
    byteRange: requireByteRange(message.byteOffsetInScene, message.byteLength, locator),
    sourceAssetId: requireSourceAssetId(message.sourceAsset, locator),
    locator,
  };
}

/**
 * Every narrative choice option is an inherently translatable surface, so a
 * choice with no bridgeRef (or no coordinates / asset) is an incomplete link
 * and FAILS rather than being silently dropped.
 */
function choiceLink(choice: NarrativeChoice, sceneId: number, locator: string): NarrativeLink {
  const ref = choice.bridgeRef;
  if (!ref) {
    throw new IncompleteNarrativeLinkError(
      locator,
      "narrative choice carries no bridgeRef (a translatable choice must bind to a bridge unit)",
    );
  }
  return {
    kind: "choice",
    bridgeUnitId: ref.bridgeUnitId,
    sourceUnitKey: ref.sourceUnitKey,
    sceneId,
    byteRange: requireByteRange(choice.byteOffsetInScene, choice.byteLength, locator),
    sourceAssetId: requireSourceAssetId(choice.sourceAsset, locator),
    locator,
  };
}

function unitLink(unit: NarrativeUnit, sceneId: number, locator: string): NarrativeLink {
  return {
    kind: unit.choiceId != null ? "choice" : "line",
    bridgeUnitId: unit.bridgeRef.bridgeUnitId,
    sourceUnitKey: unit.bridgeRef.sourceUnitKey,
    sceneId,
    byteRange: requireByteRange(unit.byteOffsetInScene, unit.byteLength, locator),
    sourceAssetId: requireSourceAssetId(unit.sourceAsset, locator),
    locator,
  };
}

/** Whether two links that share a bridgeUnitId describe the same source
 * position (the same line in an alternate representation) — same kind, key,
 * byte range, and asset. If they agree the duplicate is redundant and kept
 * once; if they disagree it is a genuine conflict that must fail loud. */
function sameSourcePosition(a: NarrativeLink, b: NarrativeLink): boolean {
  return (
    a.kind === b.kind &&
    a.sourceUnitKey === b.sourceUnitKey &&
    a.sourceAssetId === b.sourceAssetId &&
    a.byteRange.startByte === b.byteRange.startByte &&
    a.byteRange.endByte === b.byteRange.endByte
  );
}

/**
 * Collect every bridge-linked narrative element into normalized links.
 * A scene's flat `units[]` (authoritative byte coordinates) takes
 * precedence; a message/choice whose bridge unit is already collected is the
 * same line in another representation ONLY when it agrees on every source
 * coordinate — that alternate representation is consistency-checked, not
 * blindly dropped. Two DISTINCT narrative positions sharing a bridgeUnitId
 * (a different kind, key, range, or asset) is a conflict and fails loud, so a
 * suppressed representation can never silently erase a narrative position.
 */
function collectNarrativeLinks(structure: NarrativeStructure): NarrativeLink[] {
  const links: NarrativeLink[] = [];
  const byBridgeUnitId = new Map<string, NarrativeLink>();

  const push = (link: NarrativeLink | null): void => {
    if (!link) {
      return;
    }
    const existing = byBridgeUnitId.get(link.bridgeUnitId);
    if (existing) {
      if (!sameSourcePosition(existing, link)) {
        throw new ConflictingNarrativeLinkError(
          link.bridgeUnitId,
          existing.locator,
          link.locator,
          `${existing.kind} ${existing.sourceUnitKey} ${existing.byteRange.startByte}..${existing.byteRange.endByte} (asset ${existing.sourceAssetId}) vs ${link.kind} ${link.sourceUnitKey} ${link.byteRange.startByte}..${link.byteRange.endByte} (asset ${link.sourceAssetId})`,
        );
      }
      return;
    }
    byBridgeUnitId.set(link.bridgeUnitId, link);
    links.push(link);
  };

  for (const scene of structure.scenes) {
    for (const [index, unit] of (scene.units ?? []).entries()) {
      push(unitLink(unit, scene.sceneId, `scene ${scene.sceneId} unit[${index}]`));
    }
    for (const [index, message] of scene.messages.entries()) {
      push(messageLink(message, scene.sceneId, `scene ${scene.sceneId} message[${index}]`));
    }
    for (const [choiceIndex, choice] of scene.choices.entries()) {
      push(choiceLink(choice, scene.sceneId, `scene ${scene.sceneId} choice[${choiceIndex}]`));
      for (const [branchIndex, message] of choice.branchMessages.entries()) {
        push(
          messageLink(
            message,
            scene.sceneId,
            `scene ${scene.sceneId} choice[${choiceIndex}].branch[${branchIndex}]`,
          ),
        );
      }
    }
  }

  return links;
}

/**
 * Index the bundle's active localization units by bridgeUnitId, failing
 * loud on any duplicate identity (bridgeUnitId or sourceUnitKey).
 */
function indexActiveUnits(bundle: BridgeBundleV02): Map<string, LocalizationUnitV02> {
  const byBridgeUnitId = new Map<string, LocalizationUnitV02>();
  const seenSourceUnitKeys = new Set<string>();
  for (const unit of bundle.units) {
    if (byBridgeUnitId.has(unit.bridgeUnitId)) {
      throw new DuplicateLocalizationUnitError(unit.bridgeUnitId, "bridgeUnitId");
    }
    if (seenSourceUnitKeys.has(unit.sourceUnitKey)) {
      throw new DuplicateLocalizationUnitError(unit.sourceUnitKey, "sourceUnitKey");
    }
    byBridgeUnitId.set(unit.bridgeUnitId, unit);
    seenSourceUnitKeys.add(unit.sourceUnitKey);
  }
  return byBridgeUnitId;
}

/** The surface kinds a narrative `line` link may bind: spoken/narrated text
 * lines ONLY. This is an explicit allowlist, NOT "anything that isn't a
 * choice" — otherwise a `line` would accept non-narrative surfaces like
 * `ui_label`, `speaker_name`, `tutorial_text`, `metadata_text`, which are
 * legal `SurfaceKindV02` values but are not narrative lines. */
const NARRATIVE_LINE_SURFACE_KINDS: ReadonlySet<string> = new Set(["dialogue", "narration"]);

/** Whether a narrative link kind and a bundle unit's surfaceKind agree: a
 * `choice` link binds a `choice_label` surface and only that; a `line` link
 * binds ONLY a narrative/dialogue line surface (see
 * {@link NARRATIVE_LINE_SURFACE_KINDS}). */
function kindMatchesSurface(kind: NarrativeLinkKind, surfaceKind: string): boolean {
  return kind === "choice"
    ? surfaceKind === "choice_label"
    : NARRATIVE_LINE_SURFACE_KINDS.has(surfaceKind);
}

/** Recompute the unit's declared `sourceHash` from its `sourceText` (the
 * bridge producer's `sha256:<hex>` over the UTF-8 sourceText). A drift means
 * the unit's text and its committed hash disagree — the binding would carry
 * unverified bytes — so it must fail. */
function computeSourceHash(sourceText: string): string {
  return `sha256:${createHash("sha256").update(sourceText, "utf8").digest("hex")}`;
}

function assertSourceMatch(
  link: NarrativeLink,
  unit: LocalizationUnitV02,
  assetHashById: Map<string, string>,
): void {
  if (link.sourceUnitKey !== unit.sourceUnitKey) {
    throw new SourceBindingMismatchError(
      link.bridgeUnitId,
      "source_unit_key",
      link.locator,
      `narrative sourceUnitKey ${link.sourceUnitKey} !== unit sourceUnitKey ${unit.sourceUnitKey}`,
    );
  }

  // Kind must agree with the unit's surface: a choice link may not bind a
  // dialogue unit, nor a line link a choice_label unit.
  if (!kindMatchesSurface(link.kind, unit.surfaceKind)) {
    throw new SourceBindingMismatchError(
      link.bridgeUnitId,
      "surface_kind",
      link.locator,
      `narrative link kind ${link.kind} does not match unit surfaceKind ${unit.surfaceKind}`,
    );
  }

  // Source asset must agree AND be a declared bundle asset (required — every
  // accepted binding proves its owning asset).
  if (link.sourceAssetId !== unit.sourceAssetRef.assetId) {
    throw new SourceBindingMismatchError(
      link.bridgeUnitId,
      "source_asset",
      link.locator,
      `narrative sourceAsset ${link.sourceAssetId} !== unit sourceAssetRef ${unit.sourceAssetRef.assetId}`,
    );
  }
  if (!assetHashById.has(unit.sourceAssetRef.assetId)) {
    throw new SourceBindingMismatchError(
      link.bridgeUnitId,
      "source_asset",
      link.locator,
      `unit sourceAssetRef ${unit.sourceAssetRef.assetId} is not declared in the bundle assets`,
    );
  }

  // Byte range must agree (required — no optional-skip).
  const unitRange = unit.sourceLocation.range;
  if (
    unitRange === undefined ||
    unitRange.startByte !== link.byteRange.startByte ||
    unitRange.endByte !== link.byteRange.endByte
  ) {
    const unitRangeText =
      unitRange === undefined ? "absent" : `${unitRange.startByte}..${unitRange.endByte}`;
    throw new SourceBindingMismatchError(
      link.bridgeUnitId,
      "byte_range",
      link.locator,
      `narrative byte range ${link.byteRange.startByte}..${link.byteRange.endByte} !== unit range ${unitRangeText}`,
    );
  }

  // The unit's own source hash must recompute from its sourceText (proves the
  // bound text and its committed hash agree).
  const recomputed = computeSourceHash(unit.sourceText);
  if (recomputed !== unit.sourceHash) {
    throw new SourceBindingMismatchError(
      link.bridgeUnitId,
      "source_hash",
      link.locator,
      `unit sourceHash ${unit.sourceHash} !== recomputed ${recomputed} over its sourceText`,
    );
  }
}

/**
 * Bind every narrative line and choice to exactly one active localization
 * unit, proving each binding agrees on source hash and byte range.
 *
 * Throws (never returns partial):
 * - {@link DuplicateLocalizationUnitError} — two active units share an identity key.
 * - {@link DanglingBridgeRefError} — a narrative ref has no active unit.
 * - {@link IncompleteNarrativeLinkError} — a bridge-linked element lacks a
 *   ref, byte range, or source asset.
 * - {@link ConflictingNarrativeLinkError} — two narrative positions collide on
 *   one bridgeUnitId with disagreeing coordinates.
 * - {@link SourceBindingMismatchError} — a bound unit disagrees on bundle
 *   hash, source asset, sourceUnitKey, byte range, surface kind, or source hash.
 * - {@link UnreferencedLocalizationUnitError} — an active unit binds to no
 *   narrative position.
 */
export function joinNarrativeToLocalization(
  structure: NarrativeStructure,
  bundle: BridgeBundleV02,
): NarrativeLocalizationJoin {
  // Bundle-level source-hash agreement is REQUIRED, not optional: the two
  // artifacts must prove they describe the same source bytes, else every
  // per-line binding below is meaningless. A SINGLE guard covers both an
  // absent hash (a structure that cannot make the proof) and a mismatched
  // hash — `undefined !== bundle.sourceBundleHash` is a mismatch — so there is
  // no redundant branch: deleting this guard fails BOTH the absent-hash and
  // the different-bytes test.
  if (structure.sourceBundleHash !== bundle.sourceBundleHash) {
    const detail =
      structure.sourceBundleHash === undefined
        ? "structure carries no sourceBundleHash; a proof-carrying join requires it to equal the bundle sourceBundleHash"
        : `structure sourceBundleHash ${structure.sourceBundleHash} !== bundle sourceBundleHash ${bundle.sourceBundleHash}`;
    throw new SourceBindingMismatchError(
      structure.bridgeId ?? "unknown",
      "bundle_hash",
      "structure root",
      detail,
    );
  }

  const byBridgeUnitId = indexActiveUnits(bundle);
  const assetHashById = new Map<string, string>(
    bundle.assets.map((asset) => [asset.assetId, asset.sourceHash]),
  );

  const links = collectNarrativeLinks(structure);
  const referenced = new Set<string>();
  const bindings: NarrativeLocalizationBinding[] = [];

  for (const link of links) {
    const unit = byBridgeUnitId.get(link.bridgeUnitId);
    if (!unit) {
      throw new DanglingBridgeRefError(link.bridgeUnitId, link.locator);
    }
    assertSourceMatch(link, unit, assetHashById);
    referenced.add(link.bridgeUnitId);
    bindings.push({ link, unit });
  }

  // Completeness: every active localization unit must bind to a narrative
  // position. An unreferenced unit is a lost narrative position, not data.
  const unreferencedUnitIds = [...byBridgeUnitId.keys()].filter(
    (bridgeUnitId) => !referenced.has(bridgeUnitId),
  );
  if (unreferencedUnitIds.length > 0) {
    throw new UnreferencedLocalizationUnitError(unreferencedUnitIds);
  }

  return { bindings };
}
