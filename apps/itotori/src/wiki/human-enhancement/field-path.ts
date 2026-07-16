// Deterministic, immutable field-path access over a plain-JSON WikiObject.
//
// Human edits, decoded-fact conflicts, and enhancement reconciliation all
// address the object by a `fieldPath` — an ordered list of keys. A numeric
// segment indexes an array; any other segment keys an object. Every mutation
// returns a NEW value (structural clone of the touched spine only) so the prior
// object is never mutated in place — immutability is what lets the same base
// feed both the durable human version and the later enhancement.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FieldPath = readonly string[];

/** A stable string key for a field path, usable in Set/Map membership. */
export function pathKey(path: FieldPath): string {
  return JSON.stringify(path);
}

export class FieldPathError extends Error {
  constructor(path: FieldPath, detail: string) {
    super(`field path [${path.join(", ")}]: ${detail}`);
    this.name = "FieldPathError";
  }
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayIndex(segment: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return null;
  return Number.parseInt(segment, 10);
}

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

function headOf(path: FieldPath): { head: string; rest: FieldPath } {
  const head = path[0];
  if (head === undefined) throw new FieldPathError(path, "path segment is empty");
  return { head, rest: path.slice(1) };
}

/** Return a clone of `root` with `value` set at `path`. Intermediate segments
 * must already exist as the right container kind; a mismatch is loud. */
export function withValueAtPath(root: JsonValue, path: FieldPath, value: JsonValue): JsonValue {
  if (path.length === 0) return value;
  const { head, rest } = headOf(path);
  if (Array.isArray(root)) {
    const index = arrayIndex(head);
    if (index === null || index >= root.length) {
      throw new FieldPathError(path, "array index is out of range");
    }
    const next = root.slice();
    next[index] = withValueAtPath(root[index] ?? null, rest, value);
    return next;
  }
  if (isRecord(root)) {
    if (rest.length > 0 && !Object.prototype.hasOwnProperty.call(root, head)) {
      throw new FieldPathError(path, "intermediate field is absent");
    }
    return { ...root, [head]: withValueAtPath(root[head] ?? null, rest, value) };
  }
  throw new FieldPathError(path, "cannot descend into a scalar");
}

/** Return a clone of `root` with the field at `path` removed. */
export function withoutValueAtPath(root: JsonValue, path: FieldPath): JsonValue {
  if (path.length === 0) {
    throw new FieldPathError(path, "cannot remove the root");
  }
  const { head, rest } = headOf(path);
  if (rest.length === 0) {
    if (Array.isArray(root)) {
      const index = arrayIndex(head);
      if (index === null || index >= root.length) {
        throw new FieldPathError(path, "array index is out of range");
      }
      return root.filter((_item, position) => position !== index);
    }
    if (isRecord(root)) {
      if (!Object.prototype.hasOwnProperty.call(root, head)) {
        throw new FieldPathError(path, "field is absent");
      }
      const next: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(root)) {
        if (key !== head) next[key] = root[key] ?? null;
      }
      return next;
    }
    throw new FieldPathError(path, "cannot remove from a scalar");
  }
  const child = getAtPath(root, [head]);
  if (child === undefined) throw new FieldPathError(path, "intermediate field is absent");
  return withValueAtPath(root, [head], withoutValueAtPath(child, rest));
}

/** Enumerate every LEAF path of `value` (scalars, empty objects, empty arrays)
 * with `prefix` prepended. Deterministic key order. */
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

/** The set of leaf paths whose value differs between `before` and `after`
 * (present-vs-absent counts as a difference). Used to learn exactly which
 * fields an enhancement proposal changed. */
export function changedLeafPaths(before: JsonValue, after: JsonValue): FieldPath[] {
  const seen = new Set<string>();
  const changed: FieldPath[] = [];
  for (const path of [...leafPaths(before), ...leafPaths(after)]) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const left = getAtPath(before, path);
    const right = getAtPath(after, path);
    if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) changed.push(path);
  }
  return changed;
}

/** True when `candidate` is `ancestor` itself or nested beneath it. */
export function isPathWithin(candidate: FieldPath, ancestor: FieldPath): boolean {
  if (candidate.length < ancestor.length) return false;
  return ancestor.every((segment, index) => candidate[index] === segment);
}
