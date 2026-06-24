import type { ProviderFamily, ProviderRunRecord } from "../../providers/types.js";
import type { Bcp47Locale, Uuid7 } from "../../batch-planner/shapes.js";

/**
 * Closed-enum list of route-choice kinds the agent may emit. Mirrors the
 * DB CHECK constraint in 0032_route_choice_maps.sql; adding a kind is a
 * prompt-template version bump + migration.
 */
export const ROUTE_CHOICE_KINDS = [
  "RouteBranch",
  "FlagToggle",
  "SceneSelector",
  "Cosmetic",
  "Other",
] as const;

export type ChoiceKind = (typeof ROUTE_CHOICE_KINDS)[number];

export type RouteMapStatus = "Fresh" | "Stale";

export type RouteMapInvalidatedReason =
  | "source_hash_drift"
  | "template_version_bump"
  | "unknown_route_target"
  | "manual";

export type RouteChoiceMapModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

export type BridgeUnitForRouteMap = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string | undefined;
  routeKey?: string | undefined;
  sceneKey?: string | undefined;
  choiceContext?:
    | {
        choiceKey: string;
        optionIndex?: number | undefined;
        routeTargetRef?: string | undefined;
      }
    | undefined;
};

export type CuratedRouteRef = {
  routeKey: string;
  routeTitle?: string | undefined;
};

export type PriorRouteMapRef = {
  routes: ReadonlyArray<{
    routeKey: string;
    routeTitle: string;
    routeSummary: string;
  }>;
  choices: ReadonlyArray<{
    choiceKey: string;
    kind: ChoiceKind;
    promptSummary: string;
    options: ReadonlyArray<{
      optionLabel: string;
      targetRouteKey?: string | undefined;
    }>;
  }>;
  promptTemplateVersion: string;
};

export type RouteChoiceMapInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;
  units: ReadonlyArray<BridgeUnitForRouteMap>;
  curatedRoutes: ReadonlyArray<CuratedRouteRef>;
  priorMap?: PriorRouteMapRef | undefined;
  modelProfile: RouteChoiceMapModelProfile;
  now?: (() => Date) | undefined;
  promptTemplateVersion?: string | undefined;
};

export type RouteMap = {
  id: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  routeKey: string;
  routeTitle: string;
  mapLocale: Bcp47Locale;
  routeSummary: string;
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];
  modelProfile: RouteChoiceMapModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  generatedAt: string;
  status: RouteMapStatus;
  invalidatedAt?: string;
  invalidatedReason?: RouteMapInvalidatedReason;
};

export type RouteChoiceOption = {
  optionId: Uuid7;
  optionIndex: number;
  optionLabel: string;
  targetRouteKey?: string | undefined;
  targetUnitIds: Uuid7[];
  targetUnitHashes: string[];
};

export type RouteChoice = {
  id: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  choiceKey: string;
  kind: ChoiceKind;
  fromRouteKey?: string | undefined;
  promptSummary: string;
  mapLocale: Bcp47Locale;
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];
  options: RouteChoiceOption[];
  modelProfile: RouteChoiceMapModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  generatedAt: string;
  status: RouteMapStatus;
  invalidatedAt?: string;
  invalidatedReason?: RouteMapInvalidatedReason;
};

export type RouteChoiceMapOutput = {
  routes: RouteMap[];
  choices: RouteChoice[];
  providerRun: ProviderRunRecord;
};

export type ProviderEmittedPack = {
  routes: Array<{
    routeKey: string;
    routeTitle: string;
    routeSummary: string;
    citedUnitIds: string[];
  }>;
  choices: Array<{
    choiceKey: string;
    kind: ChoiceKind;
    fromRouteKey?: string | undefined;
    promptSummary: string;
    citedUnitIds: string[];
    options: Array<{
      optionIndex: number;
      optionLabel: string;
      targetRouteKey?: string | undefined;
      targetUnitIds: string[];
    }>;
  }>;
};

export class RouteMapLocaleMismatchError extends Error {
  constructor(
    public readonly expectedSourceLocale: Bcp47Locale,
    public readonly providedLocale: Bcp47Locale,
  ) {
    super(
      `route-choice-map agent refused: expected sourceLocale ${expectedSourceLocale}, got ${providedLocale}`,
    );
    this.name = "RouteMapLocaleMismatchError";
  }
}

export class RouteMapEmptyInputError extends Error {
  constructor(public readonly projectId: string) {
    super(`route-choice-map agent refused: project ${projectId} has no units`);
    this.name = "RouteMapEmptyInputError";
  }
}

export class RouteUncitedError extends Error {
  constructor(public readonly routeKey: string) {
    super(`route-choice-map agent refused: route ${routeKey} cites no bridge units`);
    this.name = "RouteUncitedError";
  }
}

export class ChoiceUncitedError extends Error {
  constructor(
    public readonly choiceKey: string,
    public readonly subject: "prompt" | "option",
    public readonly optionContext?: string,
  ) {
    const where = subject === "prompt" ? "prompt" : `option ${optionContext ?? "unknown"}`;
    super(`route-choice-map agent refused: choice ${choiceKey} ${where} cites no bridge units`);
    this.name = "ChoiceUncitedError";
  }
}

export class UnknownRouteError extends Error {
  constructor(
    public readonly choiceKey: string,
    public readonly targetRouteKey: string,
  ) {
    super(
      `route-choice-map agent refused: choice ${choiceKey} option targets unknown route ${targetRouteKey}`,
    );
    this.name = "UnknownRouteError";
  }
}

export class ChoiceOptionOutOfOrderError extends Error {
  constructor(
    public readonly choiceKey: string,
    public readonly expectedIndex: number,
    public readonly observedIndex: number,
  ) {
    super(
      `route-choice-map agent refused: choice ${choiceKey} option index ${observedIndex} does not match expected ${expectedIndex}`,
    );
    this.name = "ChoiceOptionOutOfOrderError";
  }
}

export class RouteChoiceMapInvalidKindError extends Error {
  constructor(public readonly observed: string) {
    super(
      `route-choice-map agent refused: kind ${observed} is not in the closed enum ${ROUTE_CHOICE_KINDS.join(",")}`,
    );
    this.name = "RouteChoiceMapInvalidKindError";
  }
}

export class RouteChoiceMapParseError extends Error {
  constructor(public readonly reason: string) {
    super(`route-choice-map agent refused: provider output could not be parsed (${reason})`);
    this.name = "RouteChoiceMapParseError";
  }
}

export class RouteChoiceMapUnknownCitationError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly context: string,
  ) {
    super(
      `route-choice-map agent refused: cited bridge unit ${bridgeUnitId} (${context}) is not in input.units`,
    );
    this.name = "RouteChoiceMapUnknownCitationError";
  }
}
