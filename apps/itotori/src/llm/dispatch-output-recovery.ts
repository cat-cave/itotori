import type { LlmStepUsage } from "@itotori/db";
import type { PhysicalStepMemo, TerminalOutput } from "../contracts/index.js";

export function hasRequiredUsage(
  middlewareSawUsage: boolean,
  durableUsage: LlmStepUsage | null,
): boolean {
  return middlewareSawUsage || durableUsage !== null;
}

export function terminalOutputFromReceipt(
  receipt: { readonly outcome: PhysicalStepMemo["value"]["outcome"] } | undefined,
): TerminalOutput | null {
  return receipt?.outcome.kind === "terminal" ? receipt.outcome.output : null;
}
