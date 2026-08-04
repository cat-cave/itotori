import { expect, it } from "vitest";
import { terminalGenerationLookupAttempts } from "./llm-model-profile-live.support.js";

it("counts only lookups for the accepted terminal generation", () => {
  expect(
    terminalGenerationLookupAttempts(
      ["generation:tool-call", "generation:accepted-terminal"],
      "generation:accepted-terminal",
    ),
  ).toBe(1);
});

it("reports a terminal lookup retry rather than normalizing it", () => {
  expect(
    terminalGenerationLookupAttempts(
      ["generation:tool-call", "generation:accepted-terminal", "generation:accepted-terminal"],
      "generation:accepted-terminal",
    ),
  ).toBe(2);
});
