import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { isRecord, type ProducerRole, type SourceKind } from "./evidence-contract.js";
import { expectedReferenceKind } from "./evidence-portability.js";

export interface BundleBuildRequest {
  caseId: string;
  evidenceKind: string;
  sourceClass: string;
  privacyClass: string;
  contentCase: string;
  referenceKind: string;
  candidateRevision: string;
  repositoryRoot: string;
}

export interface EvidenceBuildDependencies {
  evaluatedProducerPath: string;
  expectationProducerPath: string;
  productBoundaryPath: string;
  productSourceDigest: string;
  productBuildDigest: string;
}

interface PairReference {
  evaluated: string;
  expectation: string;
}

interface ProducerInput {
  role: ProducerRole;
  caseId: string;
  scope: string;
  sourceLabel: string;
  sourceKind: SourceKind;
  inputReference: string;
  currentInputReference: string;
  pairAnchorReference: string;
  peerInputReference: string;
  alternateInputReference: string;
  unaffectedInputReference: string;
  artifactReference: string;
  privateArtifactReference: string;
  censusReference: string;
  recordReference: string;
  evidenceKind: string;
  contentCase: string;
  sourceClass: string;
  privacyClass: string;
  referenceKind: string;
  productBoundaryPath: string;
  productSourceDigest: string;
  productBuildDigest: string;
}

const PREFIXES: Readonly<Record<string, string>> = {
  "managed artifact handle": "managed",
  "relative public handle": "public",
  "changed artifact handle": "changed",
  "proof graph": "proof",
  "managed manifest handle": "manifests",
};

function write(root: string, reference: string, bytes: string | Uint8Array): void {
  const path = resolve(root, reference);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function prefix(referenceKind: string): string {
  const value = PREFIXES[referenceKind];
  if (value === undefined) throw new Error(`unknown-evidence-reference-kind:${referenceKind}`);
  return value;
}

function producerInput(
  role: ProducerRole,
  scope: string,
  source: string,
  current: string,
  anchor: string,
  peer: string,
  sourceKind: SourceKind,
  request: BundleBuildRequest,
  dependencies: EvidenceBuildDependencies,
): ProducerInput {
  return {
    role,
    caseId: request.caseId,
    scope,
    sourceLabel: `${scope}-${role}`,
    sourceKind,
    inputReference: source,
    currentInputReference: current,
    pairAnchorReference: anchor,
    peerInputReference: peer,
    alternateInputReference: source === "source-a.bin" ? "source-b.bin" : "source-a.bin",
    unaffectedInputReference: "source-unaffected.bin",
    artifactReference: `${prefix(request.referenceKind)}/${scope}/${role}.bin`,
    privateArtifactReference: `private-artifacts/${scope}-${role}.bin`,
    censusReference: `census/${scope}-${role}.json`,
    recordReference: `records/${scope}-${role}.json`,
    evidenceKind: request.evidenceKind,
    contentCase: request.contentCase,
    sourceClass: request.sourceClass,
    privacyClass: request.privacyClass,
    referenceKind: request.referenceKind,
    productBoundaryPath: dependencies.productBoundaryPath,
    productSourceDigest: dependencies.productSourceDigest,
    productBuildDigest: dependencies.productBuildDigest,
  };
}

function runProducer(
  script: string,
  bundleRoot: string,
  inputRoot: string,
  request: BundleBuildRequest,
  input: ProducerInput,
): void {
  const result = spawnSync(
    process.execPath,
    [
      script,
      JSON.stringify({
        ...input,
        bundleRoot,
        inputRoot,
        buildRevision: request.candidateRevision,
      }),
    ],
    { cwd: request.repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0 || result.stdout !== "" || result.stderr !== "") {
    throw new Error(
      `evidence-producer-failed:${result.status ?? "no-status"}:${result.stderr.trim()}`,
    );
  }
}

function pair(
  bundleRoot: string,
  inputRoot: string,
  request: BundleBuildRequest,
  dependencies: EvidenceBuildDependencies,
  scope: string,
  evaluatedSource: string,
  expectationSource: string,
  current: string,
  anchor: string,
  sourceKind: SourceKind,
  censuses: string[],
): PairReference {
  const evaluated = producerInput(
    "evaluated",
    scope,
    evaluatedSource,
    current,
    anchor,
    expectationSource,
    sourceKind,
    request,
    dependencies,
  );
  const expectation = producerInput(
    "expectation",
    scope,
    expectationSource,
    current,
    anchor,
    evaluatedSource,
    sourceKind,
    request,
    dependencies,
  );
  runProducer(dependencies.evaluatedProducerPath, bundleRoot, inputRoot, request, evaluated);
  runProducer(dependencies.expectationProducerPath, bundleRoot, inputRoot, request, expectation);
  censuses.push(evaluated.censusReference, expectation.censusReference);
  return { evaluated: evaluated.recordReference, expectation: expectation.recordReference };
}

function producedArtifact(root: string, inputRoot: string, input: ProducerInput): Buffer {
  const record: unknown = JSON.parse(readFileSync(resolve(root, input.recordReference), "utf8"));
  if (!isRecord(record) || typeof record.published !== "boolean")
    throw new Error("copied-control-record-invalid");
  const path =
    record.published || record.recordClass === "restricted-local-receipt"
      ? resolve(
          root,
          record.recordClass === "restricted-local-receipt"
            ? input.privateArtifactReference
            : input.artifactReference,
        )
      : resolve(inputRoot, input.privateArtifactReference);
  return readFileSync(path);
}

function copiedControl(
  bundleRoot: string,
  inputRoot: string,
  request: BundleBuildRequest,
  dependencies: EvidenceBuildDependencies,
  sourceKind: SourceKind,
  censuses: string[],
): PairReference {
  const scope = "controls/copied";
  const evaluated = producerInput(
    "evaluated",
    scope,
    "source-a.bin",
    "source-a.bin",
    "source-a.bin",
    "source-a.bin",
    sourceKind,
    request,
    dependencies,
  );
  runProducer(dependencies.evaluatedProducerPath, bundleRoot, inputRoot, request, evaluated);
  const copiedSource = "copied/evaluated-output.bin";
  write(inputRoot, copiedSource, producedArtifact(bundleRoot, inputRoot, evaluated));
  const expectation = producerInput(
    "expectation",
    scope,
    copiedSource,
    copiedSource,
    copiedSource,
    "source-a.bin",
    "evaluated-output-copy",
    request,
    dependencies,
  );
  runProducer(dependencies.expectationProducerPath, bundleRoot, inputRoot, request, expectation);
  censuses.push(evaluated.censusReference, expectation.censusReference);
  return { evaluated: evaluated.recordReference, expectation: expectation.recordReference };
}

function tamperRecord(bundleRoot: string, reference: string): void {
  const path = resolve(bundleRoot, reference);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || typeof parsed.outcome !== "string")
    throw new Error("tampered-control-record-invalid");
  writeFileSync(path, `${JSON.stringify({ ...parsed, outcome: `${parsed.outcome}-tampered` })}\n`);
}

function validateCensuses(inputRoot: string, references: readonly string[]): void {
  if (references.length !== 8 || new Set(references).size !== references.length)
    throw new Error("ephemeral-census-count-invalid");
  for (const reference of references) {
    const parsed: unknown = JSON.parse(readFileSync(resolve(inputRoot, reference), "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.schema !== "itotori.ephemeral-private-evidence-census.v1" ||
      !Array.isArray(parsed.fields) ||
      !isRecord(parsed.localChecks)
    ) {
      throw new Error("ephemeral-census-invalid");
    }
    if (
      parsed.fields.length !== 6 ||
      parsed.fields.some(
        (field) => !isRecord(field) || field.nonemptyCount !== 1 || field.totalCount !== 1,
      )
    ) {
      throw new Error("ephemeral-census-population-invalid");
    }
    for (const value of Object.values(parsed.localChecks))
      if (typeof value !== "boolean") throw new Error("ephemeral-census-check-invalid");
  }
}

export function buildEvidenceBundle(
  bundleRoot: string,
  inputRoot: string,
  dependencies: EvidenceBuildDependencies,
  request: BundleBuildRequest,
): void {
  mkdirSync(bundleRoot, { recursive: true });
  mkdirSync(inputRoot, { recursive: true });
  try {
    const synthetic = request.sourceClass === "synthetic input";
    const sourceKind: SourceKind = synthetic
      ? "synthetic-public-source"
      : "tracked-production-source";
    const sourcePath = synthetic
      ? resolve(request.repositoryRoot, "docs/behaviors/features/quality-and-safety.feature")
      : resolve(
          request.repositoryRoot,
          "packages/itotori-db/src/localization-artifact-integrity.ts",
        );
    const sourceA = readFileSync(sourcePath);
    const sourceB = Buffer.concat([
      sourceA,
      Buffer.from("\n// portable-evidence-source-change-v2\n"),
    ]);
    const forbidden = Buffer.concat([
      sourceA,
      Buffer.from(
        "\nRAW_KEY::seed\nRETAIL_CONTENT::seed\nCAPTURED_IMAGE::seed\nPRIVATE_FILENAME::seed\nPRIVATE_PATH::seed\n",
      ),
    ]);
    const unaffected = readFileSync(
      resolve(request.repositoryRoot, "packages/itotori-db/src/managed-artifact-refs.ts"),
    );
    write(inputRoot, "source-a.bin", sourceA);
    write(inputRoot, "source-b.bin", sourceB);
    write(inputRoot, "source-forbidden.bin", forbidden);
    write(inputRoot, "source-unaffected.bin", unaffected);

    const unsafe = request.contentCase.includes("raw key");
    const stale = request.contentCase === "a changed source revision";
    const mixed = request.evidenceKind === "mixed evidence set";
    const regenerated = request.evidenceKind === "regenerated evidence set";
    const mainEvaluated = unsafe
      ? "source-forbidden.bin"
      : regenerated
        ? "source-b.bin"
        : "source-a.bin";
    const mainExpectation = mixed ? "source-b.bin" : mainEvaluated;
    const current = stale || mixed || regenerated ? "source-b.bin" : mainEvaluated;
    const anchor = regenerated ? "source-b.bin" : mainEvaluated;
    const censuses: string[] = [];
    const main = pair(
      bundleRoot,
      inputRoot,
      request,
      dependencies,
      "case",
      mainEvaluated,
      mainExpectation,
      current,
      anchor,
      sourceKind,
      censuses,
    );
    const copied = copiedControl(
      bundleRoot,
      inputRoot,
      request,
      dependencies,
      sourceKind,
      censuses,
    );
    const tampered = pair(
      bundleRoot,
      inputRoot,
      request,
      dependencies,
      "controls/tampered",
      "source-a.bin",
      "source-a.bin",
      "source-a.bin",
      "source-a.bin",
      sourceKind,
      censuses,
    );
    tamperRecord(bundleRoot, tampered.evaluated);
    const staleControl = pair(
      bundleRoot,
      inputRoot,
      request,
      dependencies,
      "controls/stale",
      "source-a.bin",
      "source-a.bin",
      "source-b.bin",
      "source-a.bin",
      sourceKind,
      censuses,
    );
    validateCensuses(request.privacyClass === "restricted" ? bundleRoot : inputRoot, censuses);
    const expectedKind = expectedReferenceKind(request.evidenceKind);
    if (expectedKind === null || expectedKind !== request.referenceKind)
      throw new Error("scenario-reference-kind-mismatch");
    write(
      bundleRoot,
      "manifest.json",
      `${JSON.stringify({
        schema: "itotori.portable-evidence-bundle.v2",
        caseId: request.caseId,
        candidateRevision: request.candidateRevision,
        evidenceKind: request.evidenceKind,
        sourceClass: request.sourceClass,
        privacyClass: request.privacyClass,
        contentCase: request.contentCase,
        referenceKind: request.referenceKind,
        trustRole: "local-candidate-contract",
        protectedAttestationPresent: false,
        productSourceDigest: dependencies.productSourceDigest,
        productBuildDigest: dependencies.productBuildDigest,
        ephemeralFactsVerified: true,
        main,
        controls: {
          copied,
          tampered,
          stale: staleControl,
          localKinds: ["absolute", "scheme", "dot-segment", "backslash", "drive", "symlink"],
        },
      })}\n`,
    );
  } finally {
    rmSync(inputRoot, { force: true, recursive: true });
  }
}
