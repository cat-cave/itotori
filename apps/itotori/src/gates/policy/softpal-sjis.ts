// Softpal TEXT.DAT target policy.
//
// The Softpal patcher writes every replacement through encoding_rs::SHIFT_JIS
// before rebuilding TEXT.DAT. Keep that production byte contract in a dedicated
// adapter policy: the shared deterministic gates select it by bridge adapter
// identity and never branch on an engine name.

import { firstNonSjisCodePoint, REALLIVE_BOX_LIMITS, sjisByteLength } from "./reallive-sjis.js";
import type { LocalizationTargetPolicy, LocalizationTargetPolicyId } from "./types.js";

export const SOFTPAL_SJIS_POLICY_ID =
  "itotori.localization-target-policy.softpal-sjis.v1" as LocalizationTargetPolicyId;

/** The extractor identity emitted by the Softpal bridge adapter. */
export const SOFTPAL_SJIS_ADAPTER_ID = "kaifuu-softpal";

/**
 * Softpal has no target-side control grammar that is safe to strip or preserve
 * as visible prose. Its text pool is Shift-JIS and follows the same conservative
 * per-surface byte budgets as the other message-box text target.
 */
export const softpalSjisPolicy: LocalizationTargetPolicy = {
  policyId: SOFTPAL_SJIS_POLICY_ID,
  adapterId: SOFTPAL_SJIS_ADAPTER_ID,
  policyVersion: "1",
  codec: "shift-jis",
  firstDisallowedCodePoint: firstNonSjisCodePoint,
  measureBytes: sjisByteLength,
  boxLimits: REALLIVE_BOX_LIMITS,
  controlMarkers: [],
  normalizeVisibleText: (text) => text,
  choiceMustBeSingleLine: true,
  runtimeEvidenceChannels: ["decoded-textline", "render-ocr"],
};
