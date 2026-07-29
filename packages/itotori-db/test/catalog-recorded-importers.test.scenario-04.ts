import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { catalogExternalIdKindValues } from "../src/schema.js";

const egsFixture = readFixture("egs-recorded-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  readFixture,
  readFixtureText,
  record,
  requiredArray,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("guards CATALOG-011 EGS fixtures and spec text against Epic storefront semantics", () => {
    const fixtureText = readFixtureText("egs-recorded-replay.json");
    const platformLanguageConflictText = readFixtureText("platform-language-conflicts.json");
    const platformLanguageConflictFixture = JSON.parse(platformLanguageConflictText) as {
      cases: Array<{
        caseId: string;
        request: {
          candidateEvidence?: Array<{
            catalogSource?: string;
            sourceId?: string;
            externalIdKind?: string;
            statusScope?: string;
            platform?: string | null;
            evidenceRef?: string;
          }>;
        };
      }>;
    };
    const specDag = record(
      JSON.parse(readFileSync(new URL("../../../roadmap/spec-dag.json", import.meta.url), "utf8")),
      "spec DAG",
    );
    const catalog011Node = record(
      required(
        requiredArray(specDag.nodes, "spec DAG nodes").find(
          (node) => record(node, "spec DAG node").id === "CATALOG-011",
        ),
        "CATALOG-011 spec node",
      ),
      "CATALOG-011 spec node",
    );
    const catalog011AuditFocus = requiredArray(
      catalog011Node.audit_focus,
      "CATALOG-011 audit_focus",
    );
    const catalog011Text = [
      catalog011Node.title,
      catalog011Node.spec,
      catalog011Node.acceptance,
      ...catalog011AuditFocus,
    ].join("\n");

    const egsReleasePlatforms = egsFixture.steps.flatMap((step) =>
      step.facts.flatMap((fact) =>
        (fact.releases ?? [])
          .filter((release) => release.platform !== undefined)
          .map((release) => ({
            stepKey: step.stepKey,
            sourceReleaseId: release.sourceReleaseId,
            platform: release.platform,
          })),
      ),
    );
    expect(egsReleasePlatforms).toEqual([]);

    const egsConflictEvidence = platformLanguageConflictFixture.cases.flatMap((testCase) =>
      (testCase.request.candidateEvidence ?? [])
        .filter((evidence) => evidence.catalogSource === "egs")
        .map((evidence) => ({ caseId: testCase.caseId, ...evidence })),
    );
    expect(egsConflictEvidence.length).toBeGreaterThan(0);
    for (const evidence of egsConflictEvidence) {
      expect(evidence.sourceId).not.toMatch(/^prod-/u);
      expect(evidence.externalIdKind).toBe(catalogExternalIdKindValues.sourceRecord);
      expect(evidence.statusScope).toBe("work");
      expect(evidence.platform ?? null).toBeNull();
      expect(evidence.evidenceRef).not.toMatch(/product|locales/u);
    }

    for (const text of [fixtureText, platformLanguageConflictText, catalog011Text]) {
      expect(text).not.toContain("Epic Games Store");
      expect(text).not.toContain("GET /storefront/products");
      expect(text).not.toContain("catalogItemId");
      expect(text).not.toContain('"namespace"');
      expect(text).not.toContain('"slug"');
      expect(text).not.toContain("prod-moonlit-099");
      expect(text).not.toContain("egs.product.locales");
    }
    expect(fixtureText).not.toContain('"platform": "egs"');
    expect(fixtureText).toContain("sql_for_erogamer_form.php");
    expect(catalog011Text).toContain("ErogameScape");
  });
});
