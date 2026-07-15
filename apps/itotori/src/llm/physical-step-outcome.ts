import { EventType, type StreamChunk, type TokenUsage } from "@tanstack/ai";
import type { CallSpec, EncryptedPayloadRef, PhysicalStepMemo } from "../contracts/index.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import { terminalOutputSchema } from "./terminal-output.js";

export type PhysicalStepMemoOutcome = PhysicalStepMemo["value"]["outcome"];

export function streamMemoOutcome(
  spec: CallSpec,
  memoKey: string,
  chunks: readonly StreamChunk[],
): PhysicalStepMemoOutcome {
  const finished = chunks.findLast((chunk) => chunk.type === EventType.RUN_FINISHED);
  if (!finished) return invalidMemoOutcome("invalid-json", ["response did not finish"]);
  if (finished.finishReason === "length") return { kind: "truncation", reason: "output limit" };
  if (finished.finishReason === "content_filter") {
    return { kind: "refusal", reason: "content filter" };
  }
  const toolCalls = chunks.filter((chunk) => chunk.type === EventType.TOOL_CALL_END);
  if (finished.finishReason === "tool_calls" || toolCalls.length > 0) {
    const calls = toolCalls.flatMap((chunk) => {
      const name = chunk.toolCallName ?? chunk.toolName;
      const contract = spec.tools.find((tool) => tool.name === name);
      if (!name || !contract) return [];
      const inputJson = canonicalJson(chunk.input ?? {});
      return [
        {
          toolCallId: chunk.toolCallId,
          tool: contract.name,
          argumentsSchema: contract.input,
          argumentsEncrypted: memoEncryptedRef(memoKey, `tool:${chunk.toolCallId}`, inputJson),
          argumentsHash: sha256(inputJson),
        },
      ];
    });
    if (calls.length !== toolCalls.length || calls.length === 0) {
      return invalidMemoOutcome("invalid-tool-arguments", [
        "tool call did not match the allowlist",
      ]);
    }
    return { kind: "tool-calls", calls };
  }
  const raw = chunks
    .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((chunk) => chunk.delta)
    .join("");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return invalidMemoOutcome("invalid-json", ["terminal response was not valid JSON"]);
  }
  const parsed = terminalOutputSchema(spec.output).safeParse(decoded);
  if (!parsed.success) {
    return invalidMemoOutcome(
      "schema-failure",
      parsed.error.issues.map((issue) => issue.message),
    );
  }
  return { kind: "terminal", output: parsed.data };
}

export function invalidMemoOutcome(
  failureKind: "invalid-json" | "schema-failure" | "invalid-tool-arguments",
  messages: readonly string[],
): PhysicalStepMemoOutcome {
  return {
    kind: "invalid",
    failureKind,
    defects: messages.slice(0, 256).map((message) => ({
      path: [],
      code: failureKind === "schema-failure" ? "schema" : failureKind,
      message: message.slice(0, 2_048),
    })),
  };
}

export function usageFromChunks(chunks: readonly StreamChunk[]): TokenUsage {
  const finished = chunks.findLast((chunk) => chunk.type === EventType.RUN_FINISHED);
  return finished?.usage ?? emptyUsage();
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function memoEncryptedRef(
  memoKey: string,
  part: string,
  plaintext: string,
): EncryptedPayloadRef {
  return {
    storageRef: `postgres:itotori_llm_call_memos:${memoKey}:${part}`,
    contentHash: sha256(plaintext),
    encryption: "operator-managed",
  };
}
