// @itotori-meta-check
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_SOURCE_HASH,
  formatBehaviorCatalogResult,
  validateBehaviorCatalog,
} from "./audit-behavior-catalog-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function copyBehaviorDocs() {
  const root = mkdtempSync(join(tmpdir(), "behavior-catalog-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  cpSync(join(repoRoot, "docs", "behaviors"), join(root, "docs", "behaviors"), {
    recursive: true,
  });
  cpSync(join(repoRoot, "docs", "README.md"), join(root, "docs", "README.md"));
  cpSync(join(repoRoot, "docs", "action-plan.md"), join(root, "docs", "action-plan.md"));
  return root;
}

function jsonlPath(root, area, name) {
  return join(root, "docs", "behaviors", area, `${name}.jsonl`);
}

function rewriteJsonl(path, transform) {
  const rows = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  writeFileSync(
    path,
    `${transform(rows)
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
}

function rewriteFile(path, transform) {
  writeFileSync(path, transform(readFileSync(path, "utf8")));
}

test("the committed catalog accounts for every source through portable behavior outlines", () => {
  const result = validateBehaviorCatalog(repoRoot);
  assert.equal(result.ok, true, formatBehaviorCatalogResult(result));
  assert.deepEqual(result.summary, {
    sources: 582,
    mappings: 582,
    behaviors: 47,
    personas: 8,
    engineFamilies: 47,
    behaviorFiles: 25,
    dispositions: { split: 146, merged: 190, folded: 188, dropped: 58 },
    behaviorStates: { intended: 34, asserted: 5, built: 6, "proven-synthetic": 2 },
  });
});

test("removing one canonical mapping reports 581/582 and the missing capability", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(jsonlPath(root, "capability-map", "decode"), (rows) =>
    rows.filter((row) => row.capability !== "decode.engine.fixture-reference"),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /581\/582 capabilities/u);
  assert.match(formatBehaviorCatalogResult(result), /decode\.engine\.fixture-reference/u);
});

test("removing one source row reports the 581/582 source shortfall", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(jsonlPath(root, "source-inventory", "decode"), (rows) =>
    rows.filter((row) => row.c !== "decode.engine.fixture-reference"),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /source decode: expected 150, found 149/u);
  assert.match(formatBehaviorCatalogResult(result), /source coverage: 581\/582 capabilities/u);
});

test("a count-preserving duplicate cannot replace another capability", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(jsonlPath(root, "capability-map", "runtime"), (rows) => {
    rows[1] = structuredClone(rows[0]);
    return rows;
  });
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /duplicate mapped capabilities/u);
  assert.match(formatBehaviorCatalogResult(result), /missing mapped capabilities/u);
});

test("a mapping cannot fan out without an explicit split disposition", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(jsonlPath(root, "capability-map", "decode"), (rows) =>
    rows.map((row) =>
      row.capability === "decode.capability-level-model"
        ? { ...row, behaviors: [...row.behaviors, "privacy.govern-evidence-disclosure"] }
        : row,
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(
    formatBehaviorCatalogResult(result),
    /multiple behaviors require split disposition/u,
  );
});

test("a behavior cannot claim a stronger state than its weakest source", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(join(root, "docs", "behaviors", "catalog.jsonl"), (rows) =>
    rows.map((row) =>
      row.id === "quality.invalid-or-raced-actions-have-no-effects"
        ? { ...row, state: "proven-real" }
        : row,
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /stronger than derived proven-synthetic/u);
});

test("every behavior requires a persona, observable boundary, and concrete portability test", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(join(root, "docs", "behaviors", "catalog.jsonl"), (rows) =>
    rows.map((row) =>
      row.id === "catalog.select-owned-release"
        ? { ...row, personas: [], boundaries: [], portabilityTest: "" }
        : row,
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  const report = formatBehaviorCatalogResult(result);
  assert.match(report, /at least one persona/u);
  assert.match(report, /observable boundaries/u);
  assert.match(report, /portability test is missing/u);
});

test("behavior titles cannot name implementation internals", () => {
  const root = copyBehaviorDocs();
  const title = "Inspect private modules and registries";
  rewriteJsonl(join(root, "docs", "behaviors", "catalog.jsonl"), (rows) =>
    rows.map((row) => (row.id === "catalog.select-owned-release" ? { ...row, title } : row)),
  );
  rewriteFile(
    join(root, "docs", "behaviors", "features", "catalog-and-knowledge.feature"),
    (text) =>
      text.replace("Select an exact owned release and work scope without guessed identity", title),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /title names implementation internals/u);
});

test("boundary labels must name an admitted observable interface", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(join(root, "docs", "behaviors", "catalog.jsonl"), (rows) =>
    rows.map((row) =>
      row.id === "studio.find-authorized-work" ? { ...row, boundaries: ["database-table"] } : row,
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /unique observable values/u);
});

test("a Scenario Outline without Examples cannot enter the catalog", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) => contents.replace("    Examples:", "    Example rows:"));
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /has no Examples table/u);
});

test("an Examples column must have a matching scenario slot", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "catalog-and-knowledge.feature");
  rewriteFile(feature, (contents) =>
    contents
      .replace("expected_result", "unreferenced_result")
      .replace("complete and provenance-linked", "complete and provenance-linked"),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(
    formatBehaviorCatalogResult(result),
    /placeholders must exactly match Examples columns/u,
  );
});

test("an untagged Scenario Outline cannot bypass portability checks", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(
    feature,
    (contents) =>
      `Scenario Outline: Inspect a private helper\n` +
      `  Given crates/auth.rs contains a module registry\n` +
      `  When an internal call runs\n` +
      `  Then <result> is returned\n\n` +
      `  Examples:\n` +
      `    | result |\n` +
      `    | value  |\n\n` +
      contents,
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /every scenario must follow an @behavior tag/u);
});

test("a nested feature cannot bypass recursive portability checks", () => {
  const root = copyBehaviorDocs();
  const nested = join(root, "docs", "behaviors", "features", "hidden");
  mkdirSync(nested);
  writeFileSync(
    join(nested, "internal.feature"),
    "Feature: Hidden implementation behavior\n" +
      "  Scenario: Inspect internal registries\n" +
      "    Given private types cross module boundaries\n" +
      "    When an internal call runs\n" +
      "    Then a value is returned\n",
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /every scenario must follow an @behavior tag/u);
});

test("a non-English Gherkin dialect cannot bypass scenario checks", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "dialect.feature");
  writeFileSync(
    feature,
    "# language: fr\nFonctionnalité: Internes cachés\n" +
      "  Scénario: Inspecter les registres privés\n" +
      "    Soit des modules privés\n    Quand un appel interne s'exécute\n" +
      "    Alors un type interne est retourné\n",
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /catalog is English-only/u);
});

test("a Scenario Template alias cannot bypass the required Scenario Outline shape", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(
    feature,
    (contents) =>
      `Scenario Template: Inspect a private helper\n` +
      `  Given crates/auth.rs contains a module registry\n` +
      `  When an internal call runs\n` +
      `  Then <result> is returned\n\n` +
      `  Examples:\n` +
      `    | result |\n` +
      `    | value  |\n\n` +
      contents,
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /every scenario must follow an @behavior tag/u);
});

test("an Example scenario alias cannot bypass the required Scenario Outline shape", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(
    feature,
    (contents) =>
      `Example: Inspect a private type\n` +
      `  Given a crate registry calls an internal method\n` +
      `  When a value is returned\n` +
      `  Then it is accepted\n\n` +
      contents,
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /every scenario must follow an @behavior tag/u);
});

test("a Background cannot introduce untagged implementation steps", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(
    feature,
    (contents) =>
      `Background: Inspect a private type\n` +
      `  Given a crate registry calls an internal method\n\n` +
      contents,
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /Background is not allowed/u);
});

test("Examples values cannot smuggle implementation internals into instantiated steps", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) =>
    contents.replace("valid bound claims", "crates/auth.rs module registry"),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /Examples name implementation internals/u);
});

test("star-prefixed steps receive the same portability scan", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "    When the actor performs <protocol_action> for <session_target>",
      "    * a crate registry calls an internal method\n" +
        "    When the actor performs <protocol_action> for <session_target>",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /step names implementation internals/u);
});

test("a second Examples table cannot add unvalidated rows", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "\n  @behavior-account.administer-access",
      "\n    Examples:\n" +
        "      | identity_protocol | provider_case | claim_case | actor_kind | policy_case | protocol_action | session_target | authentication_outcome | group_outcome | session_outcome |\n" +
        "      | crate registry | private type | internal handler | person | value | action | session | accepted | accepted | accepted |\n\n" +
        "  @behavior-account.administer-access",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /must have exactly one Examples table/u);
});

test("step data tables cannot hide implementation internals", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "    When the actor performs <protocol_action> for <session_target>",
      "    When the actor performs <protocol_action> for <session_target>\n" +
        "      | crate registry | private type | internal method |",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /data tables are allowed only/u);
});

test("Examples values cannot name a private implementation type", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) =>
    contents.replace("valid bound claims", "private type UserRecord"),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /Examples name implementation internals/u);
});

test("plural implementation internals cannot bypass the step scan", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "identity-and-access.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "    Then authentication ends as <authentication_outcome>",
      "    Then authentication ends as <authentication_outcome>\n" +
        "    And implementation types call private methods across crates, modules, and registries",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /step names implementation internals/u);
});

test("engine literals are values in Examples and never scenario subjects", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "engine-and-content.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "Scenario Outline: Qualify an engine profile without inflating its support",
      "Scenario Outline: Qualify RealLive without inflating its support",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(
    formatBehaviorCatalogResult(result),
    /engine literal "RealLive" must be an Examples cell/u,
  );
});

test("engine roles cannot be promoted by changing the canonical row and every table together", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(join(root, "docs", "behaviors", "engine-families.jsonl"), (rows) =>
    rows.map((row) =>
      row.sourceCapability === "decode.engine.nscripter"
        ? { ...row, supportRole: "production-target" }
        : row,
    ),
  );
  for (const name of ["engine-and-content.feature", "play-and-runtime-evidence.feature"]) {
    const feature = join(root, "docs", "behaviors", "features", name);
    rewriteFile(feature, (contents) =>
      contents.replaceAll(
        "| NScripter                       | excluded profile              | explicit-exclusion ",
        "| NScripter                       | excluded profile              | production-target  ",
      ),
    );
  }
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /contradicts explicit-exclusion/u);
});

test("all five engine-shaped behaviors contain the exact 47 family slots", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "engine-and-content.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "      | Yeti/Regista Engine             | unqualified target profile    | production-target   | qualifies after required evidence   |\n",
      "",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /exact 47 engine slots/u);
});

test("production engine outcomes cannot be changed while retaining the slot matrix", () => {
  const root = copyBehaviorDocs();
  const feature = join(root, "docs", "behaviors", "features", "engine-and-content.feature");
  rewriteFile(feature, (contents) =>
    contents.replace(
      "| RealLive                        | registered production profile | production-target   | qualifies after required evidence   |",
      "| RealLive                        | registered production profile | production-target   | explicit exclusion                   |",
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /engine behavior outcome matrix hash/u);
});

test("the canonical source hash detects silent inventory replacement", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(jsonlPath(root, "source-inventory", "product"), (rows) =>
    rows.map((row) =>
      row.c === "product.catalog-work-model" ? { ...row, m: `${row.m} changed` } : row,
    ),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  const report = formatBehaviorCatalogResult(result);
  assert.match(report, /source inventory hash/u);
  assert.match(report, new RegExp(EXPECTED_SOURCE_HASH, "u"));
});

test("the canonical disposition totals cannot drift", () => {
  const root = copyBehaviorDocs();
  rewriteJsonl(jsonlPath(root, "capability-map", "runtime"), (rows) => {
    const row = rows.find((item) => item.capability === "runtime.deterministic-input-clock");
    row.disposition = "merged";
    row.reason = "Deliberate disposition mutation.";
    return rows;
  });
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /disposition merged: expected 190, found 191/u);
});

test("every behavior artifact extension obeys the absolute 500-line cap", () => {
  const root = copyBehaviorDocs();
  writeFileSync(join(root, "docs", "behaviors", "oversized.feature"), "row\n".repeat(501));
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /501 lines exceeds absolute 500-line cap/u);
});

test("the human drop ledger must enumerate the exact dropped mappings", () => {
  const root = copyBehaviorDocs();
  const ledger = join(root, "docs", "behaviors", "dropped-capabilities.md");
  rewriteFile(ledger, (contents) =>
    contents.replace(/- `product\.design-system-tokens`[^\n]*(?:\n  [^\n]*)*/u, ""),
  );
  const result = validateBehaviorCatalog(root);
  assert.equal(result.ok, false);
  assert.match(formatBehaviorCatalogResult(result), /drop ledger does not contain the exact/u);
});
