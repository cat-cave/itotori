// The deterministic structured diff between two versions of one upstream object.
//
// Field/claim-scoped invalidation begins by learning EXACTLY what changed
// between a prior and a next version of an upstream context object — never "the
// object changed". The diff is a pure function of the two immutable bodies: it
// keys claims by claim id and compares their canonical form, and it enumerates
// the leaf field paths whose value differs, excluding the version/provenance
// bookkeeping a plain re-version always bumps. No model is consulted; the same
// two bodies always yield the same change set, so the downstream impact set is
// reproducible and content-addressable.

import { canonicalLlmJson, type LlmWikiScope } from "@itotori/db";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FieldPath = readonly string[];

/** The route scope a change is confined to — a claim's own scope, or, for a
 * body field, the object's scope. Intersecting this with a consumer's consumed
 * scope is what keeps out-of-route consumers out of the work set. */
export type ChangeScope = LlmWikiScope;

/** One changed claim, addressed by its stable id, with the route/play window it
 * is visible under so a consumer that cited it out of scope is not swept in. */
export interface ClaimChange {
  claimId: string;
  changeKind: "added" | "removed" | "modified";
  scope: ChangeScope;
  fromPlayOrder: number | null;
  throughPlayOrder: number | null;
}

/** One changed leaf field, addressed by its path from the object root. A field
 * has no inherent play window, so it carries only the object's route scope. */
export interface FieldChange {
  fieldPath: FieldPath;
  scope: ChangeScope;
}

/** Everything that changed between two versions of one upstream object. */
export interface UpstreamChangeSet {
  upstreamObjectId: string;
  priorVersion: number;
  nextVersion: number;
  claimChanges: readonly ClaimChange[];
  fieldChanges: readonly FieldChange[];
}

// Top-level keys that are pure version bookkeeping: a plain re-version bumps
// them without changing any consumable content, so they never invalidate a
// consumer. `claims` is diffed separately (by claim id), not as a field.
const NON_CONTENT_ROOTS: ReadonlySet<string> = new Set([
  "version",
  "supersedesVersion",
  "provenance",
  "provisional",
  "schemaVersion",
  "claims",
  "dependencies",
]);

export class StructuredDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredDiffError";
  }
}

/** Diff a prior and next upstream object body. Both must be JSON objects for the
 * same object id; the result is deterministic in the two inputs. */
export function diffUpstreamObject(prior: JsonValue, next: JsonValue): UpstreamChangeSet {
  const priorObject = asObject(prior, "prior");
  const nextObject = asObject(next, "next");
  const upstreamObjectId = stringField(nextObject, "objectId");
  if (stringField(priorObject, "objectId") !== upstreamObjectId) {
    throw new StructuredDiffError("a structured diff compares two versions of ONE object");
  }
  const objectScope = scopeOf(nextObject);
  return {
    upstreamObjectId,
    priorVersion: integerField(priorObject, "version"),
    nextVersion: integerField(nextObject, "version"),
    claimChanges: diffClaims(priorObject, nextObject),
    fieldChanges: diffFields(priorObject, nextObject, objectScope),
  };
}

function diffClaims(
  prior: { [key: string]: JsonValue },
  next: { [key: string]: JsonValue },
): ClaimChange[] {
  const priorClaims = claimsById(prior);
  const nextClaims = claimsById(next);
  const claimIds = [...new Set([...priorClaims.keys(), ...nextClaims.keys()])].sort(compareStrings);
  const changes: ClaimChange[] = [];
  for (const claimId of claimIds) {
    const before = priorClaims.get(claimId);
    const after = nextClaims.get(claimId);
    const changeKind = classifyClaimChange(before, after);
    if (changeKind === null) continue;
    const carrier = after ?? before!;
    const window = playWindowOf([before, after]);
    changes.push({
      claimId,
      changeKind,
      scope: scopeOf(carrier),
      fromPlayOrder: window.from,
      throughPlayOrder: window.through,
    });
  }
  return changes;
}

function classifyClaimChange(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): ClaimChange["changeKind"] | null {
  if (before === undefined && after === undefined) return null;
  if (before === undefined) return "added";
  if (after === undefined) return "removed";
  return canonical(before) === canonical(after) ? null : "modified";
}

function diffFields(
  prior: { [key: string]: JsonValue },
  next: { [key: string]: JsonValue },
  objectScope: ChangeScope,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const path of changedLeafPaths(prior, next)) {
    const root = path[0];
    if (root !== undefined && NON_CONTENT_ROOTS.has(root)) continue;
    changes.push({ fieldPath: path, scope: objectScope });
  }
  return changes;
}

// ---- pure JSON path helpers ------------------------------------------------

/** Read the value at `path`, or `undefined` when any segment is absent. */
export function getAtPath(root: JsonValue, path: FieldPath): JsonValue | undefined {
  let cursor: JsonValue | undefined = root;
  for (const segment of path) {
    if (Array.isArray(cursor)) {
      const index = arrayIndex(segment);
      if (index === null || index >= cursor.length) return undefined;
      cursor = cursor[index] ?? null;
      continue;
    }
    if (isRecord(cursor)) {
      if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
      cursor = cursor[segment] ?? null;
      continue;
    }
    return undefined;
  }
  return cursor;
}

/** Enumerate every leaf path of `value` with `prefix` prepended, in a
 * deterministic key order (so the diff is stable). */
export function leafPaths(value: JsonValue, prefix: FieldPath = []): FieldPath[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix];
    return value.flatMap((item, index) => leafPaths(item, [...prefix, String(index)]));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [prefix];
    return keys.flatMap((key) => leafPaths(value[key] ?? null, [...prefix, key]));
  }
  return [prefix];
}

/** The leaf paths whose value differs between `before` and `after` (present vs
 * absent counts as a difference), each visited once, in stable order. */
export function changedLeafPaths(before: JsonValue, after: JsonValue): FieldPath[] {
  const seen = new Set<string>();
  const changed: FieldPath[] = [];
  for (const path of [...leafPaths(before), ...leafPaths(after)]) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (canonical(getAtPath(before, path) ?? null) !== canonical(getAtPath(after, path) ?? null)) {
      changed.push(path);
    }
  }
  return changed;
}

/** True when `candidate` is `ancestor` itself or nested beneath it. */
export function isPathWithin(candidate: FieldPath, ancestor: FieldPath): boolean {
  if (candidate.length < ancestor.length) return false;
  return ancestor.every((segment, index) => candidate[index] === segment);
}

/** A stable string key for a field path, usable in Set/Map membership. */
export function pathKey(path: FieldPath): string {
  return JSON.stringify(path);
}

// ---- small local utilities -------------------------------------------------

function claimsById(object: { [key: string]: JsonValue }): Map<string, JsonValue> {
  const claims = object.claims;
  const byId = new Map<string, JsonValue>();
  if (!Array.isArray(claims)) return byId;
  for (const claim of claims) {
    if (isRecord(claim) && typeof claim.claimId === "string") byId.set(claim.claimId, claim);
  }
  return byId;
}

function playWindowOf(claims: readonly (JsonValue | undefined)[]): {
  from: number | null;
  through: number | null;
} {
  const orders: number[] = [];
  for (const claim of claims) {
    if (!isRecord(claim) || !Array.isArray(claim.citations)) continue;
    for (const citation of claim.citations) {
      if (isRecord(citation) && typeof citation.playOrderIndex === "number") {
        orders.push(citation.playOrderIndex);
      }
    }
  }
  if (orders.length === 0) return { from: null, through: null };
  return { from: Math.min(...orders), through: Math.max(...orders) };
}

function scopeOf(object: JsonValue): ChangeScope {
  const scope = isRecord(object) ? object.scope : undefined;
  if (isRecord(scope)) {
    if (scope.kind === "route" && typeof scope.routeId === "string") {
      return { kind: "route", routeId: scope.routeId };
    }
    if (scope.kind === "route-set" && Array.isArray(scope.routeIds)) {
      return { kind: "route-set", routeIds: scope.routeIds.map((id) => String(id)) };
    }
  }
  return { kind: "global" };
}

function canonical(value: JsonValue): string {
  return canonicalLlmJson(value as never);
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayIndex(segment: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return null;
  return Number.parseInt(segment, 10);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asObject(value: JsonValue, label: string): { [key: string]: JsonValue } {
  if (!isRecord(value)) throw new StructuredDiffError(`${label} object body must be a JSON object`);
  return value;
}

function stringField(object: { [key: string]: JsonValue }, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new StructuredDiffError(`object is missing string ${key}`);
  return value;
}

function integerField(object: { [key: string]: JsonValue }, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new StructuredDiffError(`object is missing integer ${key}`);
  }
  return value;
}
