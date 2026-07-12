import { createUuid7 } from "@itotori/db";
import { estimateTokens } from "../../batch-planner/token-estimator.js";
import { executeStructuredInvocation } from "../../orchestrator/invocation-supervisor.js";
import { assertReportedTokenCount } from "../../providers/token-accounting.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelProvider,
  ProviderRunRecord,
} from "../../providers/types.js";
import { buildPrompt, PROMPT_TEMPLATE_VERSION_V1, promptHash } from "./prompt-template.js";
import {
  ROUTE_CHOICE_KINDS,
  RouteChoiceMapInvalidKindError,
  RouteChoiceMapParseError,
  RouteChoiceMapUnknownCitationError,
  RouteMapEmptyInputError,
  RouteMapLocaleMismatchError,
  RouteUncitedError,
  ChoiceOptionOutOfOrderError,
  ChoiceUncitedError,
  UnknownRouteError,
  type ChoiceKind,
  type ProviderEmittedPack,
  type RouteChoice,
  type RouteChoiceMapInput,
  type RouteChoiceMapOutput,
  type RouteChoiceOption,
  type RouteMap,
} from "./shapes.js";

export type GenerateRouteChoiceMapOptions = {
  provider: ModelProvider;
};

export async function generateRouteChoiceMap(
  input: RouteChoiceMapInput,
  options: GenerateRouteChoiceMapOptions,
): Promise<RouteChoiceMapOutput> {
  // 1. Source locale must be non-empty.
  if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
    throw new RouteMapLocaleMismatchError("<project sourceLocale>", input.sourceLocale ?? "");
  }

  // 2. Non-empty input.
  if (input.units.length === 0) {
    throw new RouteMapEmptyInputError(input.projectId);
  }

  // 3. Compute the closed route set.
  const allowedRouteKeys = computeRouteKeySet(input);
  const requiredRouteKeys = new Set(input.curatedRoutes.map((route) => route.routeKey));
  // 4. Compute the closed choice set.
  const allowedChoiceKeys = computeChoiceKeySet(input);
  const sourceHashByUnitId = new Map<string, string>();
  const validUnitIds = new Set<string>();
  for (const unit of input.units) {
    sourceHashByUnitId.set(unit.bridgeUnitId, unit.sourceHash);
    validUnitIds.add(unit.bridgeUnitId);
  }

  const templateVersion = input.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSION_V1;
  const rendered = buildPrompt(input);
  const hash = promptHash(rendered);

  const messages: ModelMessage[] = [
    { role: "system", content: rendered.systemText },
    { role: "user", content: rendered.userText },
  ];
  const request: ModelInvocationRequest = {
    taskKind: "experiment",
    modelId: input.modelProfile.modelId,
    providerId: input.modelProfile.providerId,
    inputClassification: "private_corpus",
    messages,
    prompt: {
      presetId: "itotori-route-choice-map",
      templateVersion,
      promptHash: `sha256:${hash}`,
    },
    generation:
      input.modelProfile.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.modelProfile.maxOutputTokens },
  };

  const supervised: { invocation: ModelInvocationResult; parsed: ProviderEmittedPack } =
    await executeStructuredInvocation(options.provider, {
      request,
      parse: parseProviderPack,
      isSchemaValidationError: (error) =>
        error instanceof RouteChoiceMapParseError ||
        error instanceof RouteChoiceMapInvalidKindError,
      validateParsed: (pack) =>
        validateProviderPack(
          pack,
          allowedRouteKeys,
          requiredRouteKeys,
          allowedChoiceKeys,
          validUnitIds,
          sourceHashByUnitId,
        ),
      successDecision: "advance",
    });
  const { invocation, parsed: pack } = supervised;
  const providerRun: ProviderRunRecord = invocation.providerRun;

  const now = (input.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  // `inputTokenEstimate` is an explicit pre-flight estimate stored in a
  // field that names itself as such — honest provenance, not a real count.
  const inputTokenEstimate = estimateTokens(`${rendered.systemText}\n${rendered.userText}`);
  // `completionTokens` is a REAL count: throw on absence rather than
  // substitute an estimate (PROJECT LAW, mirror of assertBilledCost).
  const completionTokens = assertReportedTokenCount(
    providerRun.tokenUsage,
    "completionTokens",
    providerRun.runId,
  );

  // Project routes before choices, preserving the provider pack's order.
  const routes: RouteMap[] = [];
  for (const emitted of pack.routes) {
    const citedUnitIds = [...emitted.citedUnitIds];
    const citedUnitHashes = emitted.citedUnitIds.map((id) => sourceHashByUnitId.get(id)!);
    routes.push({
      id: createUuid7(),
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      routeKey: emitted.routeKey,
      routeTitle: emitted.routeTitle,
      mapLocale: input.sourceLocale,
      routeSummary: emitted.routeSummary,
      citedUnitIds,
      citedUnitHashes,
      modelProfile: input.modelProfile,
      promptTemplateVersion: templateVersion,
      promptHash: hash,
      inputTokenEstimate,
      completionTokens,
      generatedAt,
      status: "Fresh",
    });
  }

  const choices: RouteChoice[] = [];
  for (const emitted of pack.choices) {
    const citedUnitIds = [...emitted.citedUnitIds];
    const citedUnitHashes = emitted.citedUnitIds.map((id) => sourceHashByUnitId.get(id)!);

    // Validate options.
    const choiceOptions: RouteChoiceOption[] = [];
    for (let optionPos = 0; optionPos < emitted.options.length; optionPos += 1) {
      const optionEmitted = emitted.options[optionPos]!;
      const targetUnitIds = [...optionEmitted.targetUnitIds];
      const targetUnitHashes = optionEmitted.targetUnitIds.map((id) => sourceHashByUnitId.get(id)!);
      const option: RouteChoiceOption = {
        optionId: createUuid7(),
        optionIndex: optionPos,
        optionLabel: optionEmitted.optionLabel,
        ...(optionEmitted.targetRouteKey !== undefined
          ? { targetRouteKey: optionEmitted.targetRouteKey }
          : {}),
        targetUnitIds,
        targetUnitHashes,
      };
      choiceOptions.push(option);
    }

    const choiceRecord: RouteChoice = {
      id: createUuid7(),
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      choiceKey: emitted.choiceKey,
      kind: emitted.kind,
      ...(emitted.fromRouteKey !== undefined ? { fromRouteKey: emitted.fromRouteKey } : {}),
      promptSummary: emitted.promptSummary,
      mapLocale: input.sourceLocale,
      citedUnitIds,
      citedUnitHashes,
      options: choiceOptions,
      modelProfile: input.modelProfile,
      promptTemplateVersion: templateVersion,
      promptHash: hash,
      generatedAt,
      status: "Fresh",
    };
    choices.push(choiceRecord);
  }

  return { routes, choices, providerRun };
}

export async function generateRouteChoiceMaps(
  inputs: ReadonlyArray<RouteChoiceMapInput>,
  options: GenerateRouteChoiceMapOptions,
): Promise<RouteChoiceMapOutput[]> {
  const results: RouteChoiceMapOutput[] = [];
  for (const input of inputs) {
    results.push(await generateRouteChoiceMap(input, options));
  }
  return results;
}

export function computeRouteKeySet(input: RouteChoiceMapInput): Set<string> {
  const keys = new Set<string>();
  for (const ref of input.curatedRoutes) {
    if (ref.routeKey.trim().length > 0) {
      keys.add(ref.routeKey);
    }
  }
  for (const unit of input.units) {
    if (unit.routeKey && unit.routeKey.trim().length > 0) {
      keys.add(unit.routeKey);
    }
  }
  return keys;
}

export function computeChoiceKeySet(input: RouteChoiceMapInput): Set<string> {
  const keys = new Set<string>();
  for (const unit of input.units) {
    const choiceKey = unit.choiceContext?.choiceKey;
    if (choiceKey && choiceKey.trim().length > 0) {
      keys.add(choiceKey);
    }
  }
  return keys;
}

function validateProviderPack(
  pack: ProviderEmittedPack,
  allowedRouteKeys: ReadonlySet<string>,
  requiredRouteKeys: ReadonlySet<string>,
  allowedChoiceKeys: ReadonlySet<string>,
  validUnitIds: ReadonlySet<string>,
  sourceHashByUnitId: ReadonlyMap<string, string>,
): void {
  const emittedRouteKeys = new Set<string>();
  for (const emitted of pack.routes) {
    if (!allowedRouteKeys.has(emitted.routeKey)) {
      throw new UnknownRouteError(`route:${emitted.routeKey}`, emitted.routeKey);
    }
    if (emitted.citedUnitIds.length === 0) {
      throw new RouteUncitedError(emitted.routeKey);
    }
    for (const id of emitted.citedUnitIds) {
      assertKnownCitation(id, `route ${emitted.routeKey}`, validUnitIds, sourceHashByUnitId);
    }
    emittedRouteKeys.add(emitted.routeKey);
  }

  for (const routeKey of requiredRouteKeys) {
    if (!emittedRouteKeys.has(routeKey)) {
      throw new RouteUncitedError(routeKey);
    }
  }

  for (const emitted of pack.choices) {
    if (!allowedChoiceKeys.has(emitted.choiceKey)) {
      throw new RouteChoiceMapUnknownCitationError(
        emitted.choiceKey,
        `choice ${emitted.choiceKey} (not in observed choice set)`,
      );
    }
    if (!isValidChoiceKind(emitted.kind)) {
      throw new RouteChoiceMapInvalidKindError(emitted.kind);
    }
    if (emitted.citedUnitIds.length === 0) {
      throw new ChoiceUncitedError(emitted.choiceKey, "prompt");
    }
    for (const id of emitted.citedUnitIds) {
      assertKnownCitation(id, `choice ${emitted.choiceKey}`, validUnitIds, sourceHashByUnitId);
    }
    if (emitted.options.length < 1) {
      throw new ChoiceUncitedError(emitted.choiceKey, "prompt");
    }
    for (let optionPos = 0; optionPos < emitted.options.length; optionPos += 1) {
      const optionEmitted = emitted.options[optionPos];
      if (!optionEmitted) {
        throw new RouteChoiceMapParseError(
          `choice ${emitted.choiceKey} missing option at ${optionPos}`,
        );
      }
      if (optionEmitted.optionIndex !== optionPos) {
        throw new ChoiceOptionOutOfOrderError(
          emitted.choiceKey,
          optionPos,
          optionEmitted.optionIndex,
        );
      }
      const requiresTargetUnits =
        emitted.kind === "RouteBranch" || emitted.kind === "SceneSelector";
      if (requiresTargetUnits && optionEmitted.targetUnitIds.length === 0) {
        throw new ChoiceUncitedError(
          emitted.choiceKey,
          "option",
          `index=${optionPos} label="${optionEmitted.optionLabel}"`,
        );
      }
      for (const id of optionEmitted.targetUnitIds) {
        assertKnownCitation(
          id,
          `choice ${emitted.choiceKey} option ${optionPos} target`,
          validUnitIds,
          sourceHashByUnitId,
        );
      }
      if (
        emitted.kind === "RouteBranch" &&
        optionEmitted.targetRouteKey !== undefined &&
        !emittedRouteKeys.has(optionEmitted.targetRouteKey)
      ) {
        throw new UnknownRouteError(emitted.choiceKey, optionEmitted.targetRouteKey);
      }
    }
  }
}

function assertKnownCitation(
  id: string,
  context: string,
  validUnitIds: ReadonlySet<string>,
  sourceHashByUnitId: ReadonlyMap<string, string>,
): void {
  if (!validUnitIds.has(id)) {
    throw new RouteChoiceMapUnknownCitationError(id, context);
  }
  if (!sourceHashByUnitId.get(id)) {
    throw new RouteChoiceMapUnknownCitationError(id, `${context} (no source hash)`);
  }
}

function parseProviderPack(content: string): ProviderEmittedPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new RouteChoiceMapParseError(error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RouteChoiceMapParseError("output is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const routesRaw = Array.isArray(record.routes) ? record.routes : null;
  const choicesRaw = Array.isArray(record.choices) ? record.choices : null;
  if (routesRaw === null) {
    throw new RouteChoiceMapParseError("output.routes is not an array");
  }
  if (choicesRaw === null) {
    throw new RouteChoiceMapParseError("output.choices is not an array");
  }
  const routes: ProviderEmittedPack["routes"] = [];
  for (const entry of routesRaw) {
    if (typeof entry !== "object" || entry === null) {
      throw new RouteChoiceMapParseError("output.routes entry not an object");
    }
    const row = entry as Record<string, unknown>;
    const routeKey = typeof row.routeKey === "string" ? row.routeKey : null;
    const routeTitle = typeof row.routeTitle === "string" ? row.routeTitle : null;
    const routeSummary = typeof row.routeSummary === "string" ? row.routeSummary : null;
    const citedUnitIds = parseStringArray(row.citedUnitIds);
    if (
      routeKey === null ||
      routeTitle === null ||
      routeSummary === null ||
      citedUnitIds === null
    ) {
      throw new RouteChoiceMapParseError("output.routes entry missing required field");
    }
    routes.push({ routeKey, routeTitle, routeSummary, citedUnitIds });
  }
  const choices: ProviderEmittedPack["choices"] = [];
  for (const entry of choicesRaw) {
    if (typeof entry !== "object" || entry === null) {
      throw new RouteChoiceMapParseError("output.choices entry not an object");
    }
    const row = entry as Record<string, unknown>;
    const choiceKey = typeof row.choiceKey === "string" ? row.choiceKey : null;
    const kindRaw = typeof row.kind === "string" ? row.kind : null;
    const fromRouteKey = typeof row.fromRouteKey === "string" ? row.fromRouteKey : undefined;
    const promptSummary = typeof row.promptSummary === "string" ? row.promptSummary : null;
    const citedUnitIds = parseStringArray(row.citedUnitIds);
    if (choiceKey === null || kindRaw === null || promptSummary === null || citedUnitIds === null) {
      throw new RouteChoiceMapParseError("output.choices entry missing required field");
    }
    if (!isValidChoiceKind(kindRaw)) {
      throw new RouteChoiceMapInvalidKindError(kindRaw);
    }
    const optionsRaw = Array.isArray(row.options) ? row.options : null;
    if (optionsRaw === null) {
      throw new RouteChoiceMapParseError("output.choices entry missing options array");
    }
    const options: ProviderEmittedPack["choices"][number]["options"] = [];
    for (const optEntry of optionsRaw) {
      if (typeof optEntry !== "object" || optEntry === null) {
        throw new RouteChoiceMapParseError("option entry not an object");
      }
      const opt = optEntry as Record<string, unknown>;
      const optionIndex = typeof opt.optionIndex === "number" ? opt.optionIndex : null;
      const optionLabel = typeof opt.optionLabel === "string" ? opt.optionLabel : null;
      const targetRouteKey =
        typeof opt.targetRouteKey === "string" ? opt.targetRouteKey : undefined;
      const targetUnitIds = parseStringArray(opt.targetUnitIds);
      if (optionIndex === null || optionLabel === null || targetUnitIds === null) {
        throw new RouteChoiceMapParseError("option entry missing required field");
      }
      options.push({
        optionIndex,
        optionLabel,
        ...(targetRouteKey !== undefined ? { targetRouteKey } : {}),
        targetUnitIds,
      });
    }
    choices.push({
      choiceKey,
      kind: kindRaw,
      ...(fromRouteKey !== undefined ? { fromRouteKey } : {}),
      promptSummary,
      citedUnitIds,
      options,
    });
  }
  return { routes, choices };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    parsed.push(entry);
  }
  return parsed;
}

function isValidChoiceKind(value: string): value is ChoiceKind {
  return (ROUTE_CHOICE_KINDS as ReadonlyArray<string>).includes(value);
}
