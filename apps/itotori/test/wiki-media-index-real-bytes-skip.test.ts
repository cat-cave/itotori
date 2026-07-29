import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("registers a framework skip, not a passing placeholder, when the private corpus is absent", () => {
  const suite = readFileSync(
    fileURLToPath(new URL("./wiki-media-index-real-bytes.test.ts", import.meta.url)),
    "utf8",
  );

  expect(suite).toContain('it.skip("real corpus not staged in the private inventory")');
  expect(suite).not.toContain("expect(true).toBe(true)");
});
