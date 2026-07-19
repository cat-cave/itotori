// Shared execution engine for the read tools: strict argument parsing, the
// visible-unit projection with explicit-id denials, and result finalization.

import type { z } from "zod";

import type { LlmJsonValue } from "@itotori/db";

import type { RouteScope, ToolName, UnitFact } from "../contracts/index.js";
import type { FactRouteScope, OrderedUnitFact, SceneFactCard } from "../prepass/index.js";

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

/** The visibility boundary carried by every projected snapshot fact. */
export interface ReadFactVisibility {
  routeScope: RouteScope;
  fromPlayOrder: number;
}

/** Convert the pre-pass's immutable scope representation into the contract
 * representation used by the tool envelopes. */
export function routeScopeOf(scope: FactRouteScope): RouteScope {
  if (scope.kind === "global") return { kind: "global" };
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  return { kind: "route-set", routeIds: [...scope.routeIds] };
}

/** The exact visibility of a unit before its fact is projected. */
export function unitVisibility(unit: OrderedUnitFact): ReadFactVisibility {
  return {
    routeScope: routeScopeOf(unit.routeScope),
    fromPlayOrder: unit.playReveal.playOrderIndex,
  };
}

/** Whether a fact boundary is readable by this caller in this snapshot. */
export function isVisibleToCaller(
  model: ReadModel,
  caller: ReadToolCaller,
  visibility: ReadFactVisibility,
): boolean {
  return (
    withinHorizon(visibility.fromPlayOrder, model.revealHorizon) &&
    routeScopeVisible(visibility.routeScope, caller.routeVisibility)
  );
}

/** Refuse an explicit subject that sits outside the caller's read boundary. */
export function assertVisibleToCaller(
  model: ReadModel,
  caller: ReadToolCaller,
  visibility: ReadFactVisibility,
  subject: string,
): void {
  if (!withinHorizon(visibility.fromPlayOrder, model.revealHorizon)) {
    throw new ReadToolError("beyond-reveal-horizon", `${subject} is beyond the reveal horizon`);
  }
  if (!routeScopeVisible(visibility.routeScope, caller.routeVisibility)) {
    throw new ReadToolError("out-of-route", `${subject} is outside the caller's route`);
  }
}

/** A scene's route scope is the deterministic union of its bound unit scopes.
 * A unit-less scene is globally visible when its own play coordinate allows it. */
export function sceneVisibility(model: ReadModel, scene: SceneFactCard): ReadFactVisibility {
  const units = model.factSnapshot.orderedUnits.filter((unit) => unit.sceneId === scene.sceneId);
  const routeScope = routeScopeUnion(units.map((unit) => routeScopeOf(unit.routeScope)));
  const unitPlayOrder = units.reduce<number | null>(
    (minimum, unit) =>
      minimum === null
        ? unit.playReveal.playOrderIndex
        : Math.min(minimum, unit.playReveal.playOrderIndex),
    null,
  );
  return {
    routeScope,
    fromPlayOrder: scene.playOrderIndex ?? unitPlayOrder ?? 0,
  };
}

/** A stable least-restrictive scope covering every supplied scope. */
export function routeScopeUnion(scopes: readonly RouteScope[]): RouteScope {
  if (scopes.length === 0 || scopes.some((scope) => scope.kind === "global")) {
    return { kind: "global" };
  }
  const routeIds = [...new Set(scopes.flatMap(routeIdsOf))].sort(compareCodeUnits);
  if (routeIds.length === 1) return { kind: "route", routeId: routeIds[0]! };
  return { kind: "route-set", routeIds };
}

/** The routes on which both endpoints of an edge are visible.  A null
 * intersection can occur only on a cross-route edge, which only a global
 * caller can observe after both endpoints independently pass visibility. */
export function routeScopeIntersection(left: RouteScope, right: RouteScope): RouteScope | null {
  if (left.kind === "global") return right;
  if (right.kind === "global") return left;
  const rightIds = new Set(routeIdsOf(right));
  const routeIds = routeIdsOf(left).filter((routeId) => rightIds.has(routeId));
  if (routeIds.length === 0) return null;
  if (routeIds.length === 1) return { kind: "route", routeId: routeIds[0]! };
  return { kind: "route-set", routeIds };
}

function routeIdsOf(scope: RouteScope): readonly string[] {
  if (scope.kind === "global") return [];
  if (scope.kind === "route") return [scope.routeId];
  return scope.routeIds;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The full ordered set of unit facts a caller may see, in play order. Hidden
 * units (beyond the reveal horizon or out of the caller's route) are filtered. */
export function visibleUnitFacts(model: ReadModel, caller: ReadToolCaller): UnitFact[] {
  const facts: UnitFact[] = [];
  for (const unit of model.factSnapshot.orderedUnits) {
    if (!isVisibleToCaller(model, caller, unitVisibility(unit))) continue;
    const bundleUnit = model.bundleUnits.get(unit.bridgeUnitId)!;
    const fact = projectUnitFact(unit, bundleUnit, model.snapshotId);
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
  assertVisibleToCaller(model, caller, unitVisibility(unit), `unit ${factId}`);
  const bundleUnit = model.bundleUnits.get(unit.bridgeUnitId)!;
  return projectUnitFact(unit, bundleUnit, model.snapshotId);
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
    payload: { page: input.page as unknown as LlmJsonValue, ...input.extra },
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
