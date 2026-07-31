import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { OWNED_CELLS, canonicalDigest } from "./build-cell-report.mjs";
import { portableEvidenceTreeDigest } from "./portable-evidence-artifacts.mjs";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function forgeCaseResultAttachment(bytes, select, mutate) {
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  let index = -1;
  let envelope;
  let attached;
  for (const [candidateIndex, line] of lines.entries()) {
    if (!line.includes("application/vnd.itotori.behavior-case-result+json")) continue;
    const candidate = JSON.parse(line);
    const candidateAttachment = JSON.parse(candidate.attachment.body);
    if (select(candidateAttachment.result)) {
      index = candidateIndex;
      envelope = candidate;
      attached = candidateAttachment;
      break;
    }
  }
  assert.notEqual(index, -1);
  mutate(attached.result);
  envelope.attachment.body = JSON.stringify(attached);
  lines[index] = JSON.stringify(envelope);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function bindReceipt(report, receipt) {
  const receiptDigest = canonicalDigest(receipt);
  for (const cell of report.cells) {
    if (OWNED_CELLS.includes(cell.cell)) cell.verifiedReceiptDigest = receiptDigest;
  }
}

export async function restoring(paths, action) {
  const originals = new Map(paths.map((path) => [path, readFileSync(path)]));
  try {
    await action();
  } finally {
    for (const [path, bytes] of originals) writeFileSync(path, bytes);
  }
}

export async function replacingWithExternalSymlink(path, action) {
  const scratch = mkdtempSync(join(tmpdir(), "behavior-artifact-symlink-"));
  const target = resolve(scratch, "target");
  const original = readFileSync(path);
  writeFileSync(target, original);
  rmSync(path);
  symlinkSync(target, path);
  try {
    await action();
  } finally {
    rmSync(path, { force: true });
    writeFileSync(path, original);
    rmSync(scratch, { force: true, recursive: true });
  }
}

export function portablePaths(outputRoot) {
  return {
    index: resolve(outputRoot, "evidence", "index.json"),
    projection: resolve(outputRoot, "evidence", "projection.json"),
    receipt: resolve(outputRoot, "receipts", "root-cells.json"),
    report: resolve(outputRoot, "cell-report.json"),
  };
}

export function firstPortableCase(outputRoot) {
  const paths = portablePaths(outputRoot);
  let selected;
  for (const candidate of readJson(paths.index).cases) {
    if (candidate.privacyClass !== "public-safe") continue;
    const candidateRoot = resolve(outputRoot, "evidence", candidate.path, "evidence-bundle");
    const candidateManifest = readJson(resolve(candidateRoot, "manifest.json"));
    const candidateEvaluated = readJson(resolve(candidateRoot, candidateManifest.main.evaluated));
    const candidateExpectation = readJson(
      resolve(candidateRoot, candidateManifest.main.expectation),
    );
    if (candidateEvaluated.published === true && candidateExpectation.published === true) {
      selected = { entry: candidate, bundle: candidateRoot, manifest: candidateManifest };
      break;
    }
  }
  assert.notEqual(selected, undefined);
  const entry = selected.entry;
  const caseRoot = resolve(outputRoot, "evidence", entry.path);
  const bundle = selected.bundle;
  const manifestPath = resolve(bundle, "manifest.json");
  const manifest = selected.manifest;
  const evaluated = readJson(resolve(bundle, manifest.main.evaluated));
  const expectation = readJson(resolve(bundle, manifest.main.expectation));
  return {
    ...paths,
    entry,
    bundle,
    manifestPath,
    primary: resolve(bundle, evaluated.reference),
    secondary: resolve(bundle, expectation.reference),
    auditReceipt: resolve(caseRoot, "audit-receipt.json"),
  };
}

export function firstRestrictedCase(outputRoot) {
  const paths = portablePaths(outputRoot);
  const projection = readJson(paths.projection);
  const entry = projection.cases[0];
  if (entry !== undefined) return { ...paths, entry, document: projection };
  throw new Error("restricted-portable-case-missing");
}

export function bindPortableIndex(outputRoot) {
  const paths = portablePaths(outputRoot);
  const index = readJson(paths.index);
  const receipt = readJson(paths.receipt);
  const report = readJson(paths.report);
  receipt.portableEvidenceDigest = canonicalDigest(index);
  receipt.portableAuditReceiptDigest = canonicalDigest(
    index.cases
      .filter(({ privacyClass }) => privacyClass === "public-safe")
      .map(({ caseId, auditReceiptDigest }) => ({ caseId, auditReceiptDigest })),
  );
  bindReceipt(report, receipt);
  writeJson(paths.receipt, receipt);
  writeJson(paths.report, report);
}

export function rebindPortableCase(outputRoot, caseId) {
  let paths = firstPortableCase(outputRoot);
  if (caseId !== undefined) {
    const base = portablePaths(outputRoot);
    const entry = readJson(base.index).cases.find((candidate) => candidate.caseId === caseId);
    if (entry === undefined) throw new Error("portable-case-missing");
    const caseRoot = resolve(outputRoot, "evidence", entry.path);
    paths = {
      ...base,
      entry,
      bundle: resolve(caseRoot, "evidence-bundle"),
      auditReceipt: resolve(caseRoot, "audit-receipt.json"),
    };
  }
  const wrapper = readJson(paths.auditReceipt);
  wrapper.receipt.bundleDigest = portableEvidenceTreeDigest(paths.bundle);
  wrapper.receiptDigest = sha256(JSON.stringify(wrapper.receipt));
  writeJson(paths.auditReceipt, wrapper);
  const index = readJson(paths.index);
  const entry = index.cases.find(({ caseId }) => caseId === paths.entry.caseId);
  entry.evidenceTreeDigest = wrapper.receipt.bundleDigest;
  entry.auditReceiptDigest = wrapper.receiptDigest;
  writeJson(paths.index, index);
  bindPortableIndex(outputRoot);
}
