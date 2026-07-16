// Shared execution engine for the read tools: strict argument parsing, the
// visible-unit projection with explicit-id denials, and result finalization.

import type { z } from "zod";

import type { LlmJsonValue } from "@itotori/db";

import type { ToolName, UnitFact } from "../contracts/index.js";

import { ReadToolError, routeScopeVisible, withinHorizon, type ReadToolCaller } from "./access.js";
import type { ReadModel } from "./model.js";
import { projectUnitFact } from "./projection.js";
import { requestHashOf, resultHashOf, type ToolResultPage } from "./pagination.js";

/** Parse raw arguments strictly. An unknown property (or any shape violation)
 * fails loud; unrecognized keys are reported as an explicit unknown-argument. */
export function parseArgs<TSchema extends z.ZodType>(
  schema: TSchema,
  raw: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const unknownKey = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknownKey) {
    const keys = "keys" in unknownKey ? (unknownKey.keys as string[]).join(", ") : "";
    throw new ReadToolError("unknown-argument", `unexpected argument(s): ${keys}`);
  }
  throw new ReadToolError(
    "invalid-argument",
    parsed.error.issues[0]?.message ?? "invalid arguments",
  );
}

/** Normalized request identity (excludes the cursor so pages of one request
 * share a stable requestHash). */
export function callerIdentity(caller: ReadToolCaller): LlmJsonValue {
  return {
    roleId: caller.roleId,
    routeVisibility: caller.routeVisibility,
    localeBranchId: caller.localeBranchId,
  };
}

/** The full ordered set of unit facts a caller may see, in play order. Hidden
 * units (beyond the reveal horizon or out of the caller's route) are filtered. */
export function visibleUnitFacts(model: ReadModel, caller: ReadToolCaller): UnitFact[] {
  const facts: UnitFact[] = [];
  for (const unit of model.factSnapshot.orderedUnits) {
    if (!withinHorizon(unit.playReveal.playOrderIndex, model.revealHorizon)) continue;
    const bundleUnit = model.bundleUnits.get(unit.bridgeUnitId)!;
    const fact = projectUnitFact(unit, bundleUnit, model.snapshotId);
    if (!routeScopeVisible(fact.value.routeScopes[0]!, caller.routeVisibility)) continue;
    facts.push(fact);
  }
  return facts;
}

/** Resolve one explicitly requested unit id, throwing the precise denial when
 * the unit is hidden (never silently dropping an explicit lookup). */
export function resolveExplicitUnit(
  model: ReadModel,
  caller: ReadToolCaller,
  factId: string,
): UnitFact {
  const unit = model.factSnapshot.orderedUnits.find((candidate) => candidate.factId === factId);
  if (!unit) throw new ReadToolError("unknown-subject", `no unit ${factId} in this snapshot`);
  if (!withinHorizon(unit.playReveal.playOrderIndex, model.revealHorizon)) {
    throw new ReadToolError("beyond-reveal-horizon", `unit ${factId} is beyond the reveal horizon`);
  }
  const bundleUnit = model.bundleUnits.get(unit.bridgeUnitId)!;
  const fact = projectUnitFact(unit, bundleUnit, model.snapshotId);
  if (!routeScopeVisible(fact.value.routeScopes[0]!, caller.routeVisibility)) {
    throw new ReadToolError("out-of-route", `unit ${factId} is outside the caller's route`);
  }
  return fact;
}

export interface FinalizeInput<TSchema extends z.ZodType> {
  schema: TSchema;
  schemaVersion: string;
  tool: ToolName;
  snapshotId: string;
  requestHash: string;
  page: ToolResultPage;
  extra: Record<string, LlmJsonValue>;
}

/** Assemble, content-address, and contract-validate a result envelope. */
export function finalizeResult<TSchema extends z.ZodType>(
  input: FinalizeInput<TSchema>,
): z.infer<TSchema> {
  const resultHash = resultHashOf({
    snapshotId: input.snapshotId,
    tool: input.tool,
    schemaVersion: input.schemaVersion,
    requestHash: input.requestHash,
    payload: input.extra,
  });
  const envelope = {
    schemaVersion: input.schemaVersion,
    tool: input.tool,
    snapshotId: input.snapshotId,
    requestHash: input.requestHash,
    resultHash,
    page: input.page,
    ...input.extra,
  };
  const parsed = input.schema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(
      `read tool ${input.tool} produced an invalid result: ${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  return parsed.data;
}

export { requestHashOf };
