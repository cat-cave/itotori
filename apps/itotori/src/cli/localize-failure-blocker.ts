import {
  classifyApplicationFailure,
  hasApplicationFailureEvidence,
} from "../explicit-failure/index.js";

/** Preserve the legacy blocker for unknown faults; enrich only typed evidence. */
export function localizeFailureBlocker(stage: string, error: unknown): string {
  if (!hasApplicationFailureEvidence(error)) return `${stage}-failed`;
  const classification = classifyApplicationFailure(error);
  return `${stage}:${classification.code}:${classification.nextAction}`;
}
