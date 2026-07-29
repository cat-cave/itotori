import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { branchReferenceContentHash } from "../src/repositories/branch-reference-repository.js";
import { contentHashForPolicy } from "../src/repositories/style-guide-repository-contracts.js";
import { stableCatalogId } from "../src/services/catalog-recorded-importer-utils.js";
import { stableJsonStringify } from "../src/stable-json.js";

describe("stable JSON canonicalization", () => {
  it("gives branch references and style-guide policies the same hash for the same object", () => {
    const value = {
      second: [undefined, { beta: 2, alpha: 1 }],
      first: { zeta: null, alpha: true },
    };

    expect(stableJsonStringify(value)).toBe(
      '{"first":{"alpha":true,"zeta":null},"second":[undefined,{"alpha":1,"beta":2}]}',
    );
    expect(branchReferenceContentHash(value)).toBe(contentHashForPolicy(value));
  });

  it("uses the shared canonical representation for recorded-import identity keys", () => {
    const parts = ["source", { zeta: 2, alpha: 1 }];
    const expectedDigest = createHash("sha256").update(stableJsonStringify(parts)).digest("hex");

    expect(stableCatalogId("catalog", parts)).toBe(`catalog:${expectedDigest.slice(0, 32)}`);
  });
});
