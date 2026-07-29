import { describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync }));

import { collectGitProvenance } from "../src/provenance.js";

describe("collectGitProvenance", () => {
  it("reports an unverifiable working tree when git status cannot run", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("git executable unavailable");
    });

    expect(collectGitProvenance("/unreadable-repository").dirty).toBeNull();
  });
});
