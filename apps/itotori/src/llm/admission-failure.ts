import { LlmSpendAdmissionDeniedError } from "@itotori/db";

import type { SpendAdmissionDiagnostic } from "../contracts/index.js";

/** Preserve the durable admission decision at the dispatch caller boundary. */
export function admissionFailureFields(error: unknown): {
  readonly admission?: SpendAdmissionDiagnostic;
} {
  if (!(error instanceof LlmSpendAdmissionDeniedError)) return {};
  return { admission: error.diagnostic };
}
