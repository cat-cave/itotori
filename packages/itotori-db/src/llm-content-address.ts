import { createHash } from "node:crypto";

export type LlmJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LlmJsonValue[]
  | { readonly [key: string]: LlmJsonValue };

export interface ConversationEventIdentityInput {
  parentIds: readonly string[];
  kind: "instruction" | "input" | "assistant" | "tool" | "artifact" | "defects";
  snapshotId: string;
  role: string;
  body: LlmJsonValue;
  memoKey?: string;
}

export interface ConversationEventContentHashIdentityInput {
  parentIds: readonly string[];
  kind: ConversationEventIdentityInput["kind"];
  snapshotId: string;
  role: string;
  bodyContentHash: string;
  memoKey?: string;
}

export function canonicalLlmJson(value: LlmJsonValue): string {
  assertJsonValue(value, "value");
  return serialize(value);
}

export function llmSha256(value: string | LlmJsonValue): `sha256:${string}` {
  const bytes = typeof value === "string" ? value : canonicalLlmJson(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalParentIds(parentIds: readonly string[]): readonly string[] {
  for (const parentId of parentIds) assertLlmSha256(parentId, "conversation parent event ID");
  const canonical = [...new Set(parentIds)].sort(compareCodeUnits);
  if (canonical.length !== parentIds.length) {
    throw new Error("conversation parent event IDs must be unique");
  }
  if (canonical.length > 32) throw new Error("a conversation event may have at most 32 parents");
  return canonical;
}

export function conversationEventId(input: ConversationEventIdentityInput): `sha256:${string}` {
  return conversationEventIdFromContentHash({
    parentIds: input.parentIds,
    kind: input.kind,
    snapshotId: input.snapshotId,
    role: input.role,
    bodyContentHash: llmSha256(input.body),
    ...(input.memoKey === undefined ? {} : { memoKey: input.memoKey }),
  });
}

export function conversationEventIdFromContentHash(
  input: ConversationEventContentHashIdentityInput,
): `sha256:${string}` {
  const parentIds = canonicalParentIds(input.parentIds);
  assertLlmSha256(input.snapshotId, "conversation snapshot ID");
  assertLlmSha256(input.bodyContentHash, "conversation event body content hash");
  if (input.memoKey !== undefined) assertLlmSha256(input.memoKey, "conversation memo key");
  return llmSha256({
    bodyContentHash: input.bodyContentHash,
    kind: input.kind,
    memoKey: input.memoKey ?? null,
    parentIds,
    role: input.role,
    snapshotId: input.snapshotId,
  });
}

export function parseLlmJson(value: string): LlmJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("value is not valid JSON");
  }
  assertJsonValue(parsed, "value");
  return parsed;
}

export function assertLlmSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function serialize(value: LlmJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((child) => serialize(child)).join(",")}]`;

  const record = value as Readonly<Record<string, LlmJsonValue>>;
  const entries = Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key]!)}`);
  return `{${entries.join(",")}}`;
}

function assertJsonValue(value: unknown, path: string): asserts value is LlmJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error(`${path} contains a sparse array slot`);
      assertJsonValue(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be a plain JSON object`);
    }
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} is not canonically serializable JSON`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
