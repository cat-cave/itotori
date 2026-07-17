/** Retired legacy agentic-loop wire contract. */
type Retired = any;
export const AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION = "retired" as const;
export const AGENTIC_LOOP_STAGE_NAMES: Retired = [];
export type AgenticLoopStageName = Retired;
export type AgenticLoopProviderPair = Retired;
export type AgenticLoopInvocation = Retired;
export type AgenticLoopStageRecord = Retired;
export type NonBlankTargetText = string & { readonly __brand: "NonBlank" };
export function asNonBlankTargetText(value: string): NonBlankTargetText {
  if (!value.trim()) throw new AgenticLoopBundleValidationError("target text must not be blank");
  return value as NonBlankTargetText;
}
export function isLocaleTaggedSourceEcho(_value: string): boolean {
  return false;
}
export type TranslationCandidate = Retired;
export const WRITTEN_QA_FINDING_SEVERITIES: Retired = [];
export type WrittenQaFindingSeverity = Retired;
export type WrittenQaFinding = Retired;
export type WrittenUnitOutcome = Retired;
export type AgenticLoopBundle = Retired;
export class AgenticLoopBundleValidationError extends Error {
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
  constructor(path: string, rule = "retired", detail = path) {
    super(detail);
    this.path = path;
    this.rule = rule;
    this.detail = detail;
  }
}
export function assertAgenticLoopBundle(_value: unknown): asserts _value is AgenticLoopBundle {}
export function assertWrittenUnitOutcome(
  _value: unknown,
  _name?: string,
): asserts _value is WrittenUnitOutcome {}
export function assertNonBlankTargetText(
  _value: unknown,
  _name?: string,
): asserts _value is NonBlankTargetText {}
export function parseAgenticLoopBundle(_raw: string): AgenticLoopBundle {
  throw new AgenticLoopBundleValidationError("The legacy agentic-loop contract has been removed.");
}
