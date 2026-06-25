import type { ProviderFamily, ProviderRunRecord } from "../../providers/types.js";
import type { GlossaryRef, Uuid7 } from "../../batch-planner/shapes.js";

export type Bcp47Locale = string;

export type SummaryStatus = "Fresh" | "Stale";

export type SceneSummaryInvalidatedReason =
  | "source_hash_drift"
  | "template_version_bump"
  | "manual";

export type SceneSummaryModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  /**
   * ITOTORI-220 — required (modelId, providerId) pair. Pins the scene-
   * summary invocation to a specific upstream provider.
   */
  providerId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

export type BridgeUnitForSummary = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string | undefined;
  occurrenceId?: string | undefined;
};

export type PriorSummaryRef = {
  summaryText: string;
  promptTemplateVersion: string;
};

export type SceneSummaryInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;
  sceneId: string;
  units: ReadonlyArray<BridgeUnitForSummary>;
  glossaryExcerpt: ReadonlyArray<GlossaryRef>;
  priorSummary?: PriorSummaryRef | undefined;
  modelProfile: SceneSummaryModelProfile;
  now?: (() => Date) | undefined;
  /** Caller-supplied id; defaults to a stable derivation of the input set. */
  sceneSummaryId?: Uuid7 | undefined;
  /** Override the prompt template version for tests. */
  promptTemplateVersion?: string | undefined;
};

export type SceneSummary = {
  id: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sceneId: string;
  summaryLocale: Bcp47Locale;
  summaryText: string;
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];
  modelProfile: SceneSummaryModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  generatedAt: string;
  status: SummaryStatus;
  invalidatedAt?: string;
  invalidatedReason?: SceneSummaryInvalidatedReason;
};

export type SceneSummaryOutput = {
  summary: SceneSummary;
  providerRun: ProviderRunRecord;
};

export class SceneSummaryLocaleMismatchError extends Error {
  constructor(
    public readonly expectedSourceLocale: Bcp47Locale,
    public readonly providedLocale: Bcp47Locale,
  ) {
    super(
      `scene-summary agent refused: expected sourceLocale ${expectedSourceLocale}, got ${providedLocale}`,
    );
    this.name = "SceneSummaryLocaleMismatchError";
  }
}

export class SceneSummaryEmptyInputError extends Error {
  constructor(public readonly sceneId: string) {
    super(`scene-summary agent refused: scene ${sceneId} has no units`);
    this.name = "SceneSummaryEmptyInputError";
  }
}
