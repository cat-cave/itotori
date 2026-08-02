export type BehaviorProofMode = "normal" | "fixed-success";

export interface SelectedBehaviorCase {
  readonly id: string;
  readonly behavior: string;
  readonly subject: string;
  readonly cell: string;
  readonly requiredAssertionCount: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface BehaviorCellStepContext {
  readonly execution: object;
  readonly selected: SelectedBehaviorCase;
  readonly index: number;
  readonly text: string;
  readonly repositoryRoot: string;
  readonly workRoot: string;
  readonly candidateTreeDigest: string;
  readonly mutationArtifactPath: string | null;
  readonly mode: BehaviorProofMode;
}

export interface BehaviorCellStepResult {
  readonly observationCount?: number;
  readonly assertionCount?: number;
  readonly reasonCodes?: readonly string[];
  readonly deferredFailure?: string;
}

export type BehaviorCellStepExecutor = (
  context: BehaviorCellStepContext,
) => Promise<BehaviorCellStepResult>;

export function requireCaseValue(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined || value.length === 0) throw new Error(`missing-case-value:${name}`);
  return value;
}

export function check(condition: boolean, code: string): void {
  if (!condition) throw new Error(code);
}
