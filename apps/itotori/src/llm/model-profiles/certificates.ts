import type { ModelProfileCertificate } from "../role-model-profiles.js";

/**
 * Dated certificates are appended only after the live probe has emitted a
 * verified result. Until that evidence is committed, production resolution is
 * deliberately fail-closed rather than treating an older deferred capture as
 * proof of the current reconciliation contract.
 */
export const modelProfileCertificates: readonly ModelProfileCertificate[] = [];
