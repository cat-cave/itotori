import type { UsageInfo } from "@tanstack/ai";

export type UsageAccumulator = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  sawUsage: boolean;
};

export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];
  constructor(limit: number) {
    this.#limit = limit;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit)
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

export function addUsage(target: UsageAccumulator, usage: UsageInfo): void {
  target.sawUsage = true;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.reasoningTokens += usage.completionTokensDetails?.reasoningTokens ?? 0;
  target.cachedTokens += usage.promptTokensDetails?.cachedTokens ?? 0;
}

export function finishReason(
  value: string | null | undefined,
): "stop" | "length" | "content-filter" | "unknown" {
  if (value === "stop" || value === "length") return value;
  return value === "content_filter" ? "content-filter" : "unknown";
}
