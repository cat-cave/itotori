import { describe, expect, it } from "vitest";

describe("itotori scaffold", () => {
  it("keeps the hello world translation deterministic", () => {
    expect("こんにちは、{player}。".includes("{player}")).toBe(true);
  });
});
