import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import { canonicalDigest } from "./build-cell-report.mjs";
import { runBehaviorProof } from "./run-behavior-proof.mjs";
import {
  bindPortableIndex,
  bindReceipt,
  firstPortableCase,
  forgeCaseResultAttachment,
  portablePaths,
  readJson,
  rebindPortableCase,
  replacingWithExternalSymlink,
  restoring,
  sha256,
  writeJson,
} from "./verify-behavior-gate-test-support.mjs";
import {
  requireExternalVerifierReceipt,
  verifyLaneFragments,
  verifyLocalCandidate,
} from "./verify-behavior-gate.mjs";
import { runPortableAdversarialTests } from "./verify-behavior-gate-portable-adversarial.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const DECLARED_APPLICABLE_CELL_COUNT = 687;

function assertAcceptedReportInvariants(report) {
  const { summary } = report;
  const passingCells = report.cells.filter(({ status }) => status === "pass").length;
  assert.equal(summary.applicableCellCount, DECLARED_APPLICABLE_CELL_COUNT);
  assert.equal(Number.isInteger(summary.passingCellCount), true);
  assert.ok(summary.passingCellCount >= 0);
  assert.ok(summary.passingCellCount <= summary.applicableCellCount);
  assert.equal(summary.applicableCellCount, report.cells.length);
  assert.equal(summary.passingCellCount, passingCells);
  assert.equal(summary.failingCellCount, summary.applicableCellCount - summary.passingCellCount);
}

test("missing_lane_fragment_fails_aggregate", () => {
  const fixture = mkdtempSync(join(tmpdir(), "behavior-fragment-"));
  try {
    assert.throws(
      () =>
        verifyLaneFragments(
          {
            laneFragments: [
              {
                lane: "public-ts",
                shard: 1,
                shardCount: 1,
                messagePath: "behavior-proof/cucumber/missing.ndjson",
                messageDigest: "0".repeat(64),
                junitPath: "behavior-proof/cucumber/missing.xml",
                junitDigest: "0".repeat(64),
              },
            ],
          },
          fixture,
        ),
      /missing-lane-fragment:public-ts-1of1\/message/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("accepted gate fails closed without the external verifier App", () => {
  assert.throws(
    () => requireExternalVerifierReceipt(undefined),
    /external-verifier-app-unavailable/u,
  );
});

test("accepted gate rejects a relabeled local-candidate receipt", () => {
  assert.throws(
    () =>
      requireExternalVerifierReceipt({
        trustRole: "local-candidate-contract",
        protectedAttestationPresent: false,
      }),
    /external-verifier-local-candidate-rejected/u,
  );
});

test(
  "local gate rebuilds conclusions from raw Cucumber evidence",
  // Parent deadline covers every awaited clean-copy rebuild.
  { timeout: 900_000 },
  async (context) => {
    mkdirSync(resolve(root, ".tmp"), { recursive: true });
    const outputRoot = mkdtempSync(resolve(root, ".tmp", "behavior-gate-test-"));
    const artifactRoot = relative(root, outputRoot);
    try {
      await runBehaviorProof({ root, output: artifactRoot });
      const reportPath = resolve(outputRoot, "cell-report.json");
      const caseResultsPath = resolve(outputRoot, "case-results.json");
      const mutationsPath = resolve(outputRoot, "mutations.json");
      const receiptPath = resolve(outputRoot, "receipts", "root-cells.json");
      const planPath = resolve(outputRoot, "selection-plan.json");
      const messagePath = resolve(outputRoot, "cucumber", "public-ts-1of1.ndjson");

      await context.test("accepts the unmodified rebuilt report", async () => {
        const report = await verifyLocalCandidate({ root, artifactRoot });
        assertAcceptedReportInvariants(report);
        const mutationReport = readJson(
          resolve(outputRoot, "mutation", "fixed-success-cell-report.json"),
        );
        const mutationCases = readJson(resolve(outputRoot, "mutation", "case-results.json"));
        assert.equal(mutationReport.summary.passingCellCount, 0);
        assert.equal(mutationCases.length, 3_400);
        assert.equal(
          mutationCases.every(({ status }) => status === "fail"),
          true,
        );
      });

      await context.test("rebuilds candidate glue on a clean host", async () => {
        rmSync(resolve(root, ".tmp", "behavior-proof"), { force: true, recursive: true });
        const report = await verifyLocalCandidate({ root, artifactRoot });
        assertAcceptedReportInvariants(report);
      });

      await context.test("rejects symlinked report, lane, and root receipt artifacts", async () => {
        for (const [path, reason] of [
          [reportPath, /cell-report-type-invalid/u],
          [messagePath, /missing-lane-fragment:public-ts-1of1\/message-type-invalid/u],
          [receiptPath, /root-cell-receipt-type-invalid/u],
        ]) {
          await replacingWithExternalSymlink(path, async () => {
            await assert.rejects(verifyLocalCandidate({ root, artifactRoot }), reason);
          });
        }
      });

      await context.test("rejects an unreferenced root artifact", async () => {
        const extra = resolve(outputRoot, "unreferenced.txt");
        try {
          writeFileSync(extra, "not in the proof contract", "utf8");
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /behavior-proof-root-layout-mismatch/u,
          );
        } finally {
          rmSync(extra, { force: true });
        }
      });

      await context.test("rejects empty raw Messages even with matching self-digests", async () => {
        await restoring([messagePath, reportPath], async () => {
          const bytes = Buffer.alloc(0);
          const report = readJson(reportPath);
          report.laneFragments[0].messageDigest = sha256(bytes);
          for (const cell of report.cells) {
            if (cell.receivedLanes.includes("public-ts")) {
              cell.messageFragmentDigests = [sha256(bytes)];
            }
          }
          writeFileSync(messagePath, bytes);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /zero-byte-lane-fragment:public-ts-1of1\/message/u,
          );
        });
      });

      await context.test(
        "rejects meaningless raw Messages with matching self-digests",
        async () => {
          await restoring([messagePath, reportPath], async () => {
            const bytes = Buffer.from("{}\n", "utf8");
            const report = readJson(reportPath);
            report.laneFragments[0].messageDigest = sha256(bytes);
            for (const cell of report.cells) {
              if (cell.receivedLanes.includes("public-ts")) {
                cell.messageFragmentDigests = [sha256(bytes)];
              }
            }
            writeFileSync(messagePath, bytes);
            writeJson(reportPath, report);
            await assert.rejects(
              verifyLocalCandidate({ root, artifactRoot }),
              /cucumber-message-meta-count-mismatch/u,
            );
          });
        },
      );

      await context.test("rejects a forged CaseResult attachment", async () => {
        await restoring([messagePath, reportPath, receiptPath], async () => {
          const bytes = forgeCaseResultAttachment(
            readFileSync(messagePath),
            () => true,
            (result) => {
              result.assertionCount += 1;
            },
          );
          const messageDigest = sha256(bytes);
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          report.laneFragments[0].messageDigest = messageDigest;
          for (const cell of report.cells) {
            if (cell.receivedLanes.includes("public-ts")) {
              cell.messageFragmentDigests = [messageDigest];
            }
          }
          receipt.laneFragments[0].messageDigest = messageDigest;
          bindReceipt(report, receipt);
          writeFileSync(messagePath, bytes);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /cucumber-message-passed-outcome-count-mismatch/u,
          );
        });
      });

      await context.test("rejects zero observations in a passing attachment", async () => {
        await restoring([messagePath, reportPath, receiptPath], async () => {
          const bytes = forgeCaseResultAttachment(
            readFileSync(messagePath),
            (result) => result.status === "pass",
            (result) => {
              result.observationCount = 0;
            },
          );
          const messageDigest = sha256(bytes);
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          report.laneFragments[0].messageDigest = messageDigest;
          for (const cell of report.cells) {
            if (cell.receivedLanes.includes("public-ts")) {
              cell.messageFragmentDigests = [messageDigest];
            }
          }
          receipt.laneFragments[0].messageDigest = messageDigest;
          bindReceipt(report, receipt);
          writeFileSync(messagePath, bytes);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /cucumber-message-passing-case-evidence-incomplete/u,
          );
        });
      });

      await context.test("rejects forged empty case-results JSON", async () => {
        await restoring([caseResultsPath, reportPath, receiptPath], async () => {
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          report.caseResultsDigest = canonicalDigest([]);
          receipt.caseResultsDigest = report.caseResultsDigest;
          bindReceipt(report, receipt);
          writeJson(caseResultsPath, []);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /case-results-message-binding-mismatch/u,
          );
        });
      });

      await context.test("rejects forged empty mutation JSON", async () => {
        await restoring([mutationsPath, reportPath, receiptPath], async () => {
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          report.mutationResultsDigest = canonicalDigest([]);
          receipt.mutationResultsDigest = report.mutationResultsDigest;
          bindReceipt(report, receipt);
          writeJson(mutationsPath, []);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /mutation-results-raw-evidence-binding-mismatch/u,
          );
        });
      });

      await context.test("rejects a killed mutation record with a passing mutant", async () => {
        await restoring([mutationsPath], async () => {
          const mutations = readJson(mutationsPath);
          mutations[0].mutantStatus = "pass";
          writeJson(mutationsPath, mutations);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /mutation-results-raw-evidence-binding-mismatch/u,
          );
        });
      });

      await context.test("rejects a stale self-consistent candidate tree", async () => {
        await restoring([planPath, reportPath, receiptPath], async () => {
          const plan = readJson(planPath);
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          plan.candidateTreeDigest = "0".repeat(64);
          report.candidateTreeDigest = plan.candidateTreeDigest;
          report.selectionPlanDigest = canonicalDigest(plan);
          receipt.candidateTreeDigest = plan.candidateTreeDigest;
          receipt.selectionPlanDigest = report.selectionPlanDigest;
          bindReceipt(report, receipt);
          writeJson(planPath, plan);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /selection-plan-current-tree-binding-mismatch/u,
          );
        });
      });

      await context.test("rejects a stale self-consistent candidate build", async () => {
        await restoring([reportPath, receiptPath], async () => {
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          report.candidateBuildDigest = "1".repeat(64);
          receipt.candidateBuildDigest = report.candidateBuildDigest;
          bindReceipt(report, receipt);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /candidate-build-digest-mismatch/u,
          );
        });
      });

      await context.test("rejects a receipt whose message digest is stale", async () => {
        await restoring([reportPath, receiptPath], async () => {
          const report = readJson(reportPath);
          const receipt = readJson(receiptPath);
          receipt.laneFragments[0].messageDigest = "2".repeat(64);
          bindReceipt(report, receipt);
          writeJson(receiptPath, receipt);
          writeJson(reportPath, report);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /root-cell-receipt-rebuild-mismatch/u,
          );
        });
      });

      await context.test("rejects missing portable evidence after envelope rehash", async () => {
        const paths = firstPortableCase(outputRoot);
        await restoring(
          [paths.primary, paths.auditReceipt, paths.index, paths.receipt, paths.report],
          async () => {
            rmSync(paths.primary);
            rebindPortableCase(outputRoot);
            await assert.rejects(
              verifyLocalCandidate({ root, artifactRoot }),
              /portable-evidence-.*-artifact-missing/u,
            );
          },
        );
      });

      await context.test("rejects an unreferenced extra bundle file after rehash", async () => {
        const paths = firstPortableCase(outputRoot);
        const extra = resolve(paths.bundle, "unreferenced.bin");
        await restoring(
          [paths.auditReceipt, paths.index, paths.receipt, paths.report],
          async () => {
            try {
              writeFileSync(extra, "content-free extra", "utf8");
              rebindPortableCase(outputRoot);
              await assert.rejects(
                verifyLocalCandidate({ root, artifactRoot }),
                /portable-evidence-.*-bundle-files-mismatch/u,
              );
            } finally {
              rmSync(extra, { force: true });
            }
          },
        );
      });

      await context.test("rejects a symlinked bundle artifact after rehash", async () => {
        const paths = firstPortableCase(outputRoot);
        const original = readFileSync(paths.primary);
        await restoring(
          [paths.auditReceipt, paths.index, paths.receipt, paths.report],
          async () => {
            try {
              rmSync(paths.primary);
              symlinkSync(relative(dirname(paths.primary), paths.secondary), paths.primary);
              rebindPortableCase(outputRoot);
              await assert.rejects(
                verifyLocalCandidate({ root, artifactRoot }),
                /portable-evidence-.*-artifact-type-invalid/u,
              );
            } finally {
              rmSync(paths.primary, { force: true });
              writeFileSync(paths.primary, original);
            }
          },
        );
      });

      await context.test("rejects tampered evidence after every envelope is rehashed", async () => {
        const paths = firstPortableCase(outputRoot);
        await restoring(
          [paths.primary, paths.auditReceipt, paths.index, paths.receipt, paths.report],
          async () => {
            writeFileSync(paths.primary, "tampered-after-publication", "utf8");
            rebindPortableCase(outputRoot);
            await assert.rejects(
              verifyLocalCandidate({ root, artifactRoot }),
              /portable-evidence-clean-audit-failed:.*hash-mismatch/u,
            );
          },
        );
      });

      await context.test("rejects a stale bundle after every envelope is rehashed", async () => {
        const paths = firstPortableCase(outputRoot);
        await restoring(
          [paths.manifestPath, paths.auditReceipt, paths.index, paths.receipt, paths.report],
          async () => {
            const manifest = readJson(paths.manifestPath);
            manifest.candidateRevision = "0".repeat(64);
            writeJson(paths.manifestPath, manifest);
            rebindPortableCase(outputRoot);
            await assert.rejects(
              verifyLocalCandidate({ root, artifactRoot }),
              /portable-evidence-clean-audit-failed:.*evidence-bundle-binding-invalid/u,
            );
          },
        );
      });

      await context.test("rejects a self-rehashed portable evidence index", async () => {
        const paths = portablePaths(outputRoot);
        await restoring([paths.index, paths.receipt, paths.report], async () => {
          const index = readJson(paths.index);
          index.cases[0].requestDigest = "f".repeat(64);
          writeJson(paths.index, index);
          bindPortableIndex(outputRoot);
          await assert.rejects(
            verifyLocalCandidate({ root, artifactRoot }),
            /portable-evidence-index-rebuild-mismatch/u,
          );
        });
      });
      await runPortableAdversarialTests(context, {
        root,
        outputRoot,
        artifactRoot,
        plan: readJson(planPath),
        caseResults: readJson(caseResultsPath),
      });
    } finally {
      rmSync(outputRoot, { force: true, recursive: true });
    }
  },
);
