import { describe, expect, it } from "vitest";

import { deriveProvenanceStatus, parseCommitsBehind, parseDirty } from "../src/provenance.js";
import type { Provenance } from "../src/types.js";

function prov(partial: Partial<Provenance>): Provenance {
  return {
    headShortSha: "abc1234",
    generatedAt: "2026-06-19T00:00:00.000Z",
    dirty: false,
    commitsBehind: 0,
    originMainKnown: true,
    ...partial,
  };
}

describe("parseCommitsBehind", () => {
  it("parses a trimmed integer", () => {
    expect(parseCommitsBehind("3\n")).toBe(3);
    expect(parseCommitsBehind("0")).toBe(0);
  });
  it("returns null for empty output", () => {
    expect(parseCommitsBehind("")).toBeNull();
    expect(parseCommitsBehind("   \n")).toBeNull();
  });
  it("returns null for non-numeric output", () => {
    expect(parseCommitsBehind("abc")).toBeNull();
    expect(parseCommitsBehind("3 4")).toBeNull();
  });
});

describe("parseDirty", () => {
  it("is false for empty porcelain", () => {
    expect(parseDirty("")).toBe(false);
    expect(parseDirty("\n")).toBe(false);
  });
  it("is true for any tracked change", () => {
    expect(parseDirty(" M file\n")).toBe(true);
    expect(parseDirty("?? new\n")).toBe(true);
  });
});

describe("deriveProvenanceStatus", () => {
  it("is unknown when origin/main is not known locally", () => {
    expect(deriveProvenanceStatus(prov({ originMainKnown: false, commitsBehind: null }))).toBe(
      "unknown",
    );
  });
  it("is current when up to date and clean", () => {
    expect(deriveProvenanceStatus(prov({ commitsBehind: 0, dirty: false }))).toBe("current");
  });
  it("is dirty when clean-behind but tree is dirty", () => {
    expect(deriveProvenanceStatus(prov({ commitsBehind: 0, dirty: true }))).toBe("dirty");
  });
  it("is behind when commits behind but clean", () => {
    expect(deriveProvenanceStatus(prov({ commitsBehind: 3, dirty: false }))).toBe("behind");
  });
  it("is behind-dirty when both behind and dirty", () => {
    expect(deriveProvenanceStatus(prov({ commitsBehind: 3, dirty: true }))).toBe("behind-dirty");
  });
});
