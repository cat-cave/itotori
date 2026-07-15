import type { ModelProfileCertificate } from "../role-model-profiles.js";
import { deepSeekV4FlashCertificate20260715 } from "./2026-07-15-deepseek-v4-flash-probe.js";

/**
 * Dated live certificates, appended only from a passing live conformance
 * probe. Each certifies a (model, capability + ZDR policy, version) triple
 * and pins NO provider; selection is fail-closed on the exact subject.
 */
export const modelProfileCertificates: readonly ModelProfileCertificate[] = [
  deepSeekV4FlashCertificate20260715,
];
