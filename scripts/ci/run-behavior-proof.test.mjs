import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolve } from "node:path";

import { runMutationProof } from "./run-behavior-proof.mjs";

test("cell_transition_kills_an_unsupported-version-acceptance_mutation", async () => {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const { mutant, baseline, baselinePlan } = await runMutationProof({ root });
  assert.equal(mutant.caseResults.length, 32);
  assert.equal(baseline.caseResults.length, 32);
  assert.deepEqual(new Set(mutant.caseResults.map(({ status }) => status)), new Set(["fail"]));
  assert.equal(baseline.caseResults.filter(({ status }) => status === "pass").length, 32);
  assert.equal(baseline.caseResults.filter(({ status }) => status === "fail").length, 0);
  assert.ok(
    baseline.caseResults
      .filter(
        ({ behavior }) => behavior === "platform.artifacts-are-immutable-and-retained-by-policy",
      )
      .every(({ status }) => status === "pass"),
  );
  assert.ok(
    mutant.caseResults
      .filter(
        ({ behavior }) => behavior === "platform.artifacts-are-immutable-and-retained-by-policy",
      )
      .every(
        ({ status, observationCount, reasonCodes }) =>
          status === "fail" &&
          observationCount > 0 &&
          reasonCodes.includes("artifact-incompatible-version-not-typed"),
      ),
  );

  const driver = await import(
    pathToFileURL(resolve(root, ".tmp/behavior-proof/glue/drivers/explicit-failure.js")).href
  );
  for (const hollow of [undefined, {}, { exitCode: 0 }, { status: "skipped" }, { success: true }]) {
    assert.equal(driver.isExplicitNonSuccess(hollow), false);
  }

  const effectCase = baselinePlan.cases.find(
    ({ behavior, values }) =>
      behavior === "quality.failures-stay-explicit" &&
      values.failure_case === "missing required input",
  );
  assert.ok(effectCase);
  const effectRequest = {
    operation: effectCase.values.operation,
    failureCase: effectCase.values.failure_case,
    entrypoint: effectCase.values.entrypoint,
    repositoryRoot: root,
    workRoot: resolve(root, ".tmp/behavior-proof/effect-mutation"),
  };
  const candidatePath = resolve(
    root,
    ".tmp/behavior-proof/glue/failure-product/suite/behavior/product/explicit-failure-candidate.js",
  );
  const candidateSource = readFileSync(candidatePath, "utf8");
  const marker = "async function run(input) {";
  const mutatedSource = candidateSource.replace(
    marker,
    `${marker}\n  if (input.probe === "missing-input") writeFileSync(resolve(input.operationOutputRoot, "missing-input-output.json"), "mutant-success");`,
  );
  assert.notEqual(mutatedSource, candidateSource, "effect mutation marker was not found");
  try {
    writeFileSync(candidatePath, mutatedSource, "utf8");
    const mutatedObservation = driver.observeFailure(effectRequest, false);
    assert.equal(effectCase.cell, "cell::quality.failures-stay-explicit::all");
    assert.deepEqual(mutatedObservation.effects, ["operation-output-tree-changed"]);
    assert.equal(
      driver.isExplicitNonSuccess(mutatedObservation),
      false,
      "success-artifact mutation survived the explicit cell",
    );
  } finally {
    writeFileSync(candidatePath, candidateSource, "utf8");
  }
  const restoredObservation = driver.observeFailure(effectRequest, false);
  assert.equal(
    driver.isExplicitNonSuccess(restoredObservation),
    true,
    "restored explicit boundary did not pass",
  );

  const missingRoot = "/definitely/nonexistent-behavior-boundary";
  for (const selected of baselinePlan.cases.filter(
    ({ behavior }) => behavior === "quality.failures-stay-explicit",
  )) {
    const observation = driver.observeFailure(
      {
        operation: selected.values.operation,
        failureCase: selected.values.failure_case,
        entrypoint: selected.values.entrypoint,
        repositoryRoot: missingRoot,
        workRoot: resolve(root, ".tmp/behavior-proof/missing-root"),
      },
      false,
    );
    assert.equal(driver.isExplicitNonSuccess(observation), false, selected.id);
  }

  const evidenceDriver = await import(
    pathToFileURL(resolve(root, ".tmp/behavior-proof/glue/drivers/portable-evidence.js")).href
  );
  for (const selected of baselinePlan.cases.filter(
    ({ behavior }) => behavior === "quality.evidence-is-traceable-and-portable",
  )) {
    assert.throws(
      () =>
        evidenceDriver.observeEvidence(
          {
            caseId: selected.id,
            evidenceKind: selected.values.evidence_kind,
            sourceClass: selected.values.source_class,
            privacyClass: selected.values.privacy_class,
            contentCase: selected.values.content_case,
            referenceKind: selected.values.reference_kind,
            candidateRevision: baselinePlan.candidateTreeDigest,
            repositoryRoot: missingRoot,
            workRoot: resolve(root, ".tmp/behavior-proof/missing-root"),
          },
          false,
        ),
      /evidence-producer-failed|ENOENT/u,
      selected.id,
    );
  }
});
