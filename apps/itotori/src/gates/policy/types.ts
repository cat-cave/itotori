// The localization-TARGET policy capability — the seam that makes the encoding,
// control-grammar, layout, choice, and trustworthy-runtime-observation rules of
// the deterministic release gates come from the SELECTED extract/patch adapter
// instead of being hard-coded to one engine's legacy encoding.
//
// A policy is content-addressed by its `policyId` and carries the `adapterId` +
// `policyVersion` that its receipt records. The UNIVERSAL semantic gates
// (cardinality, source-hash binding, protected-span preservation, evidence
// scope, coverage) never consult a policy — they are the same for every target.
// Only the ENCODING gate, the LAYOUT (byte/box) gate, the CONTROL-marker gate,
// the choice constraint, and the permitted runtime evidence channels are
// SELECTED from the policy. Engines appear here ONLY as registered policies (see
// ./registry.ts); nothing branches on an engine identity.

import type { SurfaceKindV02 } from "@itotori/localization-bridge-schema";

import type { BoxLimit } from "../types.js";

/** A content-addressed policy identity, e.g.
 * `itotori.localization-target-policy.reallive-sjis.v1`. */
export type LocalizationTargetPolicyId = `itotori.localization-target-policy.${string}`;

/** The character encoding a patched target's bytes are written in. */
export type TargetCodec = "shift-jis" | "utf-8" | "utf-16le" | "utf-16be";

/** A runtime channel a review layer may trust to observe the localized target.
 * A codec whose decoded text channel is lead-byte gated (and so cannot carry an
 * ASCII-leading target line) omits `decoded-textline` and is observed through
 * `render-ocr` only. */
export type RuntimeEvidenceChannel = "decoded-textline" | "render-ocr";

/** The first target codepoint the policy codec / control-grammar rejects. */
export type EncodingViolation = {
  readonly cp: number;
  readonly label: string;
  readonly reason: string;
};

/** A per-surface byte/box budget map, fully covering every surface kind. */
export type PolicyBoxLimits = Readonly<Record<SurfaceKindV02, BoxLimit>>;

/**
 * A localization target policy supplied by the extract/patch adapter. It fixes
 * the codec, the control-markup validator, the layout measurement + budgets, the
 * choice constraint, and the trustworthy runtime evidence channels for one
 * localization target. The deterministic release gates SELECT their encoding /
 * layout / control behavior from here.
 */
export interface LocalizationTargetPolicy {
  readonly policyId: LocalizationTargetPolicyId;
  /** The extract/patch adapter that supplies this policy (recorded in the
   * encoding-policy receipt so a release names its authority). */
  readonly adapterId: string;
  readonly policyVersion: string;
  readonly codec: TargetCodec;

  /** ENCODING gate: the first codepoint the target codec / control-grammar
   * cannot carry, or `null` when every codepoint is representable. */
  firstDisallowedCodePoint(text: string): EncodingViolation | null;

  /** LAYOUT gate: the deterministic byte length of a target string in this
   * codec — the length the patchback actually writes. */
  measureBytes(text: string): number;

  /** LAYOUT gate: per-surface byte/box budgets. */
  readonly boxLimits: PolicyBoxLimits;

  /** CONTROL gate: out-of-band control / markup markers that must never leak
   * into an accepted target (e.g. an engine's runtime Textout marker). */
  readonly controlMarkers: readonly string[];

  /**
   * Project source or draft text to what this target engine treats as visible
   * text before export compares the two. The adapter owns any marker grammar;
   * shared export code only invokes this declared policy capability.
   */
  normalizeVisibleText(text: string): string;

  /** A choice label must remain a single encoded line under this policy. */
  readonly choiceMustBeSingleLine: boolean;

  /** The runtime evidence channels a review layer may trust for this target. */
  readonly runtimeEvidenceChannels: readonly RuntimeEvidenceChannel[];
}
