import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { auditCopiedEvidenceBundle } from "./evidence-auditor-boundary.js";
import { isRecord } from "./evidence-contract.js";
import type { AuditOptions } from "./evidence-audit-types.js";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function boundaryOptions(value: string | undefined): AuditOptions {
  if (value === undefined) throw new Error("evidence-auditor-request-missing");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("evidence-auditor-request-invalid");
  const freshCopyNonce = text(parsed.freshCopyNonce, "auditor-fresh-copy-nonce");
  const freshCopyPath = resolve("fresh-copy-token");
  let stat;
  try {
    stat = lstatSync(freshCopyPath);
  } catch {
    throw new Error("auditor-fresh-copy-proof-missing");
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    readFileSync(freshCopyPath, "utf8") !== `${freshCopyNonce}\n`
  ) {
    throw new Error("auditor-fresh-copy-proof-invalid");
  }
  return {
    bundleRoot: resolve("..", "bundle"),
    evaluatedProducerImplementationPath: resolve("evidence-evaluated-producer-boundary.js"),
    expectationProducerImplementationPath: resolve("evidence-expectation-producer-boundary.js"),
    productBoundaryPath: resolve("product/suite/behavior/product/managed-artifact-boundary.js"),
    expectedProductSourceDigest: text(parsed.expectedProductSourceDigest, "auditor-product-source"),
    expectedProductBuildDigest: text(parsed.expectedProductBuildDigest, "auditor-product-build"),
    expectedBuildRevision: text(parsed.expectedBuildRevision, "auditor-build-revision"),
    caseId: text(parsed.caseId, "auditor-case-id"),
    evidenceKind: text(parsed.evidenceKind, "auditor-evidence-kind"),
    sourceClass: text(parsed.sourceClass, "auditor-source-class"),
    privacyClass: text(parsed.privacyClass, "auditor-privacy-class"),
    contentCase: text(parsed.contentCase, "auditor-content-case"),
    referenceKind: text(parsed.referenceKind, "auditor-reference-kind"),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = auditCopiedEvidenceBundle(boundaryOptions(process.argv[2]));
    process.stdout.write(`${JSON.stringify({ ...receipt, freshResolution: true })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
