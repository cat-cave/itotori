/**
 * Explicit test seam for terminating a call substrate at a durable boundary.
 * Production composition never supplies an injector; the hook exists so the
 * live-Postgres recovery matrix can interrupt the real transition, not imitate
 * its outcome in a store double.
 */
export const llmDurabilityFaultBoundaries = [
  "before-dispatch",
  "in-flight",
  "after-remote-response",
  "after-memo-insert",
  "after-tool-result",
  "after-accepted-output-cas",
] as const;

export type LlmDurabilityFaultBoundary = (typeof llmDurabilityFaultBoundaries)[number];

export interface LlmDurabilityFaultInjector {
  /** Terminates the active caller at the named boundary when configured by a test. */
  killAt(boundary: LlmDurabilityFaultBoundary): Promise<void>;
}

export class LlmDurabilityFaultError extends Error {
  constructor(readonly boundary: LlmDurabilityFaultBoundary) {
    super(`durability fault injected at ${boundary}`);
    this.name = "LlmDurabilityFaultError";
  }
}

/** Recognizes an injected termination even when a transport adapts its error. */
export function isLlmDurabilityFault(error: unknown): boolean {
  const visited = new Set<object>();
  let candidate = error;
  while (typeof candidate === "object" && candidate !== null && !visited.has(candidate)) {
    if (candidate instanceof LlmDurabilityFaultError) return true;
    visited.add(candidate);
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return false;
}

export async function injectLlmDurabilityFault(
  injector: LlmDurabilityFaultInjector | undefined,
  boundary: LlmDurabilityFaultBoundary,
): Promise<void> {
  await injector?.killAt(boundary);
}
