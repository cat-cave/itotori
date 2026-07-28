import type { StreamChunk } from "@tanstack/ai";

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isToolMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && "role" in value && value.role === "tool";
}

export function parseChunks(json: string | null): StreamChunk[] {
  if (json === null) return [];
  const parsed: unknown = JSON.parse(json);
  if (
    !Array.isArray(parsed) ||
    parsed.some((chunk) => typeof chunk !== "object" || chunk === null)
  ) {
    throw new Error("memoized physical response is not a stream chunk array");
  }
  return parsed as StreamChunk[];
}

export function asHash(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error("memo identity is not a SHA-256 hash");
  return value as `sha256:${string}`;
}
