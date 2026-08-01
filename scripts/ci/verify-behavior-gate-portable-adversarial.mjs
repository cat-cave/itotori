import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { sign as signBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { productImplementationBinding } from "./behavior-proof-build.mjs";
import { verifyPublishedPortableEvidence } from "./portable-evidence-artifacts.mjs";
import {
  firstPortableCase,
  firstRestrictedCase,
  readJson,
  rebindPortableCase,
  replacingWithExternalSymlink,
  restoring,
  writeJson,
  sha256,
} from "./verify-behavior-gate-test-support.mjs";
import { verifyLocalCandidate } from "./verify-behavior-gate.mjs";

const EVALUATED_PRIVATE_KEY =
  "-----BEGIN " +
  "PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIGuDUTb7KlmdPC0FQ178bpyXGcqXwu58DoMqkfYZjEzK\n-----END PRIVATE KEY-----\n";

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
}

function resignEvaluated(record) {
  const { signature: ignored, ...unsigned } = record;
  assert.equal(typeof ignored, "string");
  return {
    ...unsigned,
    signature: signBytes(null, Buffer.from(stable(unsigned)), EVALUATED_PRIVATE_KEY).toString(
      "base64",
    ),
  };
}

export async function runPortableAdversarialTests(
  context,
  { root, outputRoot, artifactRoot, plan, caseResults },
) {
  await context.test("restricted case publishes no private direct hashes or artifacts", () => {
    const paths = firstRestrictedCase(outputRoot);
    const restrictedIndex = readJson(paths.index).cases.filter(
      ({ privacyClass }) => privacyClass === "restricted",
    );
    assert.deepEqual(restrictedIndex, paths.document.cases);
    assert.deepEqual(Object.keys(paths.entry).toSorted(), [
      "caseId",
      "conclusion",
      "privacyClass",
      "protectedAttestationPresent",
      "reason",
      "trustRole",
      "verifierRandomizedCommitment",
    ]);
    const content = JSON.stringify({ index: restrictedIndex, projection: paths.document });
    for (const field of [
      '"sourceRevision":',
      '"inputHash":',
      '"outputHash":',
      '"lineage":',
      '"scanClasses":',
      '"hash":',
      '"nonemptyCount":',
      '"totalCount":',
      '"path":',
      '"safe":',
      '"localChecks":',
      '"metadataComplete":',
      '"bundleDigest":',
      '"auditReceiptDigest":',
      "private-artifacts/",
      "census/",
    ]) {
      assert.equal(content.includes(field), false, field);
    }
  });

  await context.test("rejects a non-allowlisted restricted projection field", async () => {
    const paths = firstRestrictedCase(outputRoot);
    await restoring([paths.projection], async () => {
      const projection = readJson(paths.projection);
      projection.cases[0].metadataComplete = true;
      writeJson(paths.projection, projection);
      await assert.rejects(
        verifyLocalCandidate({ root, artifactRoot }),
        /restricted-projection-0-keys-mismatch/u,
      );
    });
  });

  await context.test("rejects a quoted Windows drive path in a public record", async () => {
    const paths = firstPortableCase(outputRoot);
    const manifest = readJson(paths.manifestPath);
    const recordPath = resolve(paths.bundle, manifest.main.evaluated);
    await restoring(
      [recordPath, paths.auditReceipt, paths.index, paths.receipt, paths.report],
      async () => {
        const record = readJson(recordPath);
        record.reference = "C:/private/file";
        writeJson(recordPath, record);
        rebindPortableCase(outputRoot, paths.entry.caseId);
        await assert.rejects(
          verifyLocalCandidate({ root, artifactRoot }),
          /portable-evidence-.*-bundle-artifact-path-invalid/u,
        );
      },
    );
  });

  await context.test("rejects symlinked bundle manifest and signed record", async () => {
    const paths = firstPortableCase(outputRoot);
    const manifest = readJson(paths.manifestPath);
    for (const [path, reason] of [
      [
        paths.manifestPath,
        /portable-evidence-.*-record|portable-evidence-.*-type-invalid|portable-evidence-.*-manifest/u,
      ],
      [resolve(paths.bundle, manifest.main.evaluated), /portable-evidence-.*-record-type-invalid/u],
    ]) {
      await restoring([paths.auditReceipt, paths.index, paths.receipt, paths.report], async () => {
        await replacingWithExternalSymlink(path, async () => {
          rebindPortableCase(outputRoot, paths.entry.caseId);
          await assert.rejects(verifyLocalCandidate({ root, artifactRoot }), reason);
        });
      });
    }
  });

  await context.test("rejects a recreated private census/input directory", async () => {
    const paths = firstRestrictedCase(outputRoot);
    const privateFile = resolve(outputRoot, "evidence", "private-inputs", "census", "extra.json");
    try {
      mkdirSync(resolve(privateFile, ".."), { recursive: true });
      writeFileSync(privateFile, "{}\n");
      await assert.rejects(
        verifyLocalCandidate({ root, artifactRoot }),
        /portable-evidence-root-layout-mismatch/u,
      );
    } finally {
      rmSync(resolve(outputRoot, "evidence", "private-inputs"), { force: true, recursive: true });
    }
  });

  await context.test("rejects swapped evaluated and expectation outputs after rehash", async () => {
    const paths = firstPortableCase(outputRoot);
    await restoring(
      [paths.manifestPath, paths.auditReceipt, paths.index, paths.receipt, paths.report],
      async () => {
        const manifest = readJson(paths.manifestPath);
        [manifest.main.evaluated, manifest.main.expectation] = [
          manifest.main.expectation,
          manifest.main.evaluated,
        ];
        writeJson(paths.manifestPath, manifest);
        rebindPortableCase(outputRoot, paths.entry.caseId);
        await assert.rejects(
          verifyLocalCandidate({ root, artifactRoot }),
          /portable-evidence-clean-audit-failed:.*main-evidence-unreadable:signature-invalid/u,
        );
      },
    );
  });

  await context.test("rejects unsigned fields nested in a signed product proof", async () => {
    const paths = firstPortableCase(outputRoot);
    const manifest = readJson(paths.manifestPath);
    const evaluatedPath = resolve(paths.bundle, manifest.main.evaluated);
    await restoring(
      [evaluatedPath, paths.auditReceipt, paths.index, paths.receipt, paths.report],
      async () => {
        const evaluated = readJson(evaluatedPath);
        evaluated.productProof.leak = "unsigned-public-content";
        writeJson(evaluatedPath, evaluated);
        rebindPortableCase(outputRoot, paths.entry.caseId);
        await assert.rejects(
          verifyLocalCandidate({ root, artifactRoot }),
          /portable-evidence-clean-audit-failed:.*main-evidence-unreadable:signature-invalid/u,
        );
      },
    );
  });

  await context.test(
    "rejects collapsed producer identity after every envelope is rehashed",
    async () => {
      const paths = firstPortableCase(outputRoot);
      const manifest = readJson(paths.manifestPath);
      const evaluatedPath = resolve(paths.bundle, manifest.main.evaluated);
      const expectationPath = resolve(paths.bundle, manifest.main.expectation);
      await restoring(
        [expectationPath, paths.auditReceipt, paths.index, paths.receipt, paths.report],
        async () => {
          const evaluated = readJson(evaluatedPath);
          const expectation = readJson(expectationPath);
          expectation.producer = evaluated.producer;
          writeJson(expectationPath, expectation);
          rebindPortableCase(outputRoot, paths.entry.caseId);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /portable-evidence-clean-audit-failed:.*signature-invalid/u,
          );
        },
      );
    },
  );

  await context.test(
    "rejects a rehashed and re-signed case-specific product disagreement",
    async () => {
      const paths = firstPortableCase(outputRoot);
      const manifest = readJson(paths.manifestPath);
      const evaluatedPath = resolve(paths.bundle, manifest.main.evaluated);
      await restoring(
        [
          paths.primary,
          evaluatedPath,
          paths.auditReceipt,
          paths.index,
          paths.receipt,
          paths.report,
        ],
        async () => {
          const artifact = readJson(paths.primary);
          const originalStatus =
            artifact.semanticOutput.projection.scenarioOutput.compatibilityReport.status;
          assert.equal(["compatible", "incompatible"].includes(originalStatus), true);
          artifact.semanticOutput.projection.scenarioOutput.compatibilityReport.status =
            originalStatus === "compatible" ? "incompatible" : "compatible";
          artifact.semanticOutput.projectionCommitment = sha256(
            Buffer.from(
              `itotori.evidence-observed-projection.v1\0${stable(artifact.semanticOutput.projection)}`,
            ),
          );
          artifact.semanticOutput.resultRevision = sha256(
            Buffer.from(
              `itotori.evidence-semantic-result.v2\0${artifact.semanticOutput.caseId}\0${artifact.semanticOutput.scope}\0${artifact.semanticOutput.sourceRevision}\0${artifact.semanticOutput.projectionCommitment}`,
            ),
          );
          const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
          writeFileSync(paths.primary, artifactBytes);
          const evaluated = readJson(evaluatedPath);
          evaluated.semanticCommitment = artifact.semanticOutput.projectionCommitment;
          evaluated.outputHash = sha256(artifactBytes);
          writeJson(evaluatedPath, resignEvaluated(evaluated));
          rebindPortableCase(outputRoot, paths.entry.caseId);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /portable-evidence-clean-audit-failed:.*main-evidence-semantic-output-mismatch/u,
          );
        },
      );
    },
  );

  await context.test("gut managed URI validation turns the product-backed proof red", async () => {
    const binding = productImplementationBinding(root);
    assert.doesNotThrow(() =>
      verifyPublishedPortableEvidence(
        outputRoot,
        plan,
        caseResults,
        resolve(root, ".tmp", "behavior-proof", "glue", "drivers"),
        binding,
      ),
    );
    await restoring([binding.modulePath], async () => {
      const original = readFileSync(binding.modulePath, "utf8");
      const gutted = original.replace(
        /export function assertManagedArtifactUri[\s\S]*?\n\}\nfunction managedArtifactHash/u,
        "export function assertManagedArtifactUri() {}\nfunction managedArtifactHash",
      );
      assert.notEqual(gutted, original);
      writeFileSync(binding.modulePath, gutted);
      const request = JSON.stringify({
        artifactClass: "corpus_sidecar",
        scopeId: "gut-proof",
        artifactId: "artifact",
        artifactKind: "scan_report",
        publicContent: false,
        evidenceKind: "compatibility proof",
        contentCase: "synthetic control",
        sourceRevision: "revision-source",
        currentRevision: "revision-current",
        anchorRevision: "revision-anchor",
        peerRevision: "revision-peer",
        alternateRevision: "revision-alternate",
        unaffectedRevision: "revision-unaffected",
        scanClasses: ["public-safe"],
      });
      const boundary = spawnSync(process.execPath, [binding.boundaryPath, request], {
        encoding: "utf8",
      });
      assert.notEqual(boundary.status, 0);
      assert.match(boundary.stderr, /managed-artifact-uri-control-survived/u);
      assert.throws(
        () =>
          verifyPublishedPortableEvidence(
            outputRoot,
            plan,
            caseResults,
            resolve(root, ".tmp", "behavior-proof", "glue", "drivers"),
            productImplementationBinding(root),
          ),
        /portable-evidence-clean-audit-failed/u,
      );
    });
  });

  await context.test(
    "gut revision-bound product bytes and both scenario producers fail",
    async () => {
      const binding = productImplementationBinding(root);
      const fixturePath = resolve(dirname(binding.boundaryPath), "evidence-product-fixture.js");
      const expectationPath = resolve(
        dirname(binding.boundaryPath),
        "evidence-expectation-scenario-boundary.js",
      );
      await restoring([fixturePath], async () => {
        const original = readFileSync(fixturePath, "utf8");
        const gutted = original.replace(
          "seed: `portable-evidence:${revision}`",
          'seed: "portable-evidence:constant"',
        );
        assert.notEqual(gutted, original);
        writeFileSync(fixturePath, gutted);
        for (const [evidenceKind, evaluatedError, expectationError] of [
          [
            "runtime observation",
            /scenario-runtime-revision-projection-contradiction/u,
            /expectation-runtime-revision-projection-contradiction/u,
          ],
          [
            "mixed evidence set",
            /scenario-mixed-lineage-projection-contradiction/u,
            /expectation-mixed-lineage-projection-contradiction/u,
          ],
          [
            "regenerated evidence set",
            /scenario-regeneration-projection-contradiction/u,
            /expectation-regeneration-projection-contradiction/u,
          ],
        ]) {
          const request = JSON.stringify({
            artifactClass: "benchmark",
            scopeId: "revision-mutation",
            artifactId: "scenario-proof",
            artifactKind: "benchmark_report",
            publicContent: false,
            evidenceKind,
            contentCase: "revision mutation control",
            sourceRevision: "1".repeat(64),
            currentRevision: "2".repeat(64),
            anchorRevision: "1".repeat(64),
            peerRevision: "3".repeat(64),
            alternateRevision: "4".repeat(64),
            unaffectedRevision: "5".repeat(64),
            scanClasses: [],
          });
          const evaluated = spawnSync(process.execPath, [binding.boundaryPath, request], {
            encoding: "utf8",
          });
          assert.notEqual(evaluated.status, 0);
          assert.match(evaluated.stderr, evaluatedError);
          const expectation = spawnSync(process.execPath, [expectationPath, request], {
            encoding: "utf8",
          });
          assert.notEqual(expectation.status, 0);
          assert.match(expectation.stderr, expectationError);
        }
      });
    },
  );
}
