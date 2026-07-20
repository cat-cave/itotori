import assert from "node:assert/strict";
import test from "node:test";
import { scanLegacyLlmResidue } from "./audit-no-legacy-llm-residue.mjs";

const SOURCE = "apps/itotori/src/llm/dispatch.ts";

test("rejects every retired JSON repair and raw drafting surface", () => {
  for (const text of [
    "export function repairJsonObject() {}",
    "parseWithBoundedRepair(raw, strict)",
    "const firstJson = extract(content)",
    "const balancedJson = extract(content)",
    "supervisor salvage retries malformed output",
    "raw 128 token draft",
    "const provider: ModelProvider = createProvider();",
    "const client = new OpenRouterClient();",
    "const registry = new AgentRegistry();",
    "const tools = new DeterministicToolRegistry();",
    "const loop: AgenticLoop = createLoop();",
    "const reservation: TerminalRunReservation = acquire();",
    "const brain = new ContextBrain();",
    "const judge = new BlindJudge();",
    "const proof = new ProviderProof();",
  ]) {
    const result = scanFixture({ [SOURCE]: text });
    assert.equal(result.violations.length, 1, text);
  }
});

test("rejects a retired loop or proof module that is restored", () => {
  const path = "packages/localization-bridge-schema/src/agentic-loop-bundle.ts";
  const result = scanFixture({ [SOURCE]: "export {};", [path]: "export {};" });
  assert.deepEqual(result.violations, [{ id: "retired-module-present", path }]);
});

test("permits the strict current dispatcher boundary", () => {
  const result = scanFixture({ [SOURCE]: "export const strict = true;" });
  assert.deepEqual(result.violations, []);
});

function scanFixture(files) {
  return scanLegacyLlmResidue({
    root: "/fixture",
    files: Object.keys(files),
    readFile: (path) => files[path],
    pathExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
  });
}
