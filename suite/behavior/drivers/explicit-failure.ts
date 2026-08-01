import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { expectedBoundary, validateCandidate } from "./explicit-failure-validation.js";

export interface FailureRequest {
  operation: string;
  failureCase: string;
  entrypoint: string;
  repositoryRoot: string;
  workRoot: string;
}

export interface FailureObservation {
  disposition: "failed" | "paused" | "success";
  failureClass: string;
  diagnostic: string;
  effects: readonly string[];
  observedFields: number;
  boundaryProofCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function emptySuccess(effects: readonly string[]): FailureObservation {
  return {
    disposition: "success",
    failureClass: "",
    diagnostic: "",
    effects,
    observedFields: 0,
    boundaryProofCount: 0,
  };
}

function treeSnapshot(root: string): string {
  const entries: string[] = [];
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}`;
    if (stat.isSymbolicLink()) {
      entries.push(`link\0${relative}\0${identity}\0${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      entries.push(`directory\0${relative}\0${identity}`);
      for (const name of readdirSync(path).sort()) {
        visit(resolve(path, name), `${relative}/${name}`);
      }
      return;
    }
    if (stat.isFile()) {
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      entries.push(`file\0${relative}\0${identity}\0${digest}`);
      return;
    }
    entries.push(`other\0${relative}\0${identity}`);
  };
  visit(root, ".");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function observeFailure(request: FailureRequest, fixedSuccess: boolean): FailureObservation {
  if (fixedSuccess) return emptySuccess([]);
  const selected = expectedBoundary(request);
  if (selected === undefined) return emptySuccess([]);
  const identity = randomUUID();
  const operationOutputRoot = resolve(request.workRoot, "operation-output", identity);
  const scratchRoot = resolve(request.workRoot, "failure-scratch", identity);
  const candidate = resolve(
    request.repositoryRoot,
    ".tmp/behavior-proof/glue/failure-product/suite/behavior/product/explicit-failure-candidate.js",
  );
  mkdirSync(operationOutputRoot, { recursive: true });
  writeFileSync(resolve(operationOutputRoot, "parent-sentinel.txt"), identity, { flag: "wx" });
  const before = treeSnapshot(operationOutputRoot);
  let after = before;
  try {
    const result = spawnSync(
      process.execPath,
      [
        candidate,
        JSON.stringify({
          probe: selected.probe,
          repositoryRoot: request.repositoryRoot,
          scratchRoot,
          operationOutputRoot,
          httpBoundary: selected.entrypoint === "HTTP boundary",
        }),
      ],
      {
        cwd: request.repositoryRoot,
        encoding: "utf8",
        env: {},
        maxBuffer: 1024 * 1024,
        timeout: 45_000,
      },
    );
    after = treeSnapshot(operationOutputRoot);
    const effects = before === after ? [] : ["operation-output-tree-changed"];
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      parsed = error;
    }
    if (
      result.status !== 1 ||
      result.signal !== null ||
      result.stderr !== "" ||
      before !== after ||
      !isRecord(parsed)
    ) {
      return emptySuccess(effects);
    }
    const validation = validateCandidate(request, parsed, scratchRoot);
    return {
      disposition: selected.disposition,
      failureClass: selected.failureClass,
      diagnostic: selected.diagnostic,
      effects,
      observedFields: validation.observedFields,
      boundaryProofCount: validation.boundaryProofCount,
    };
  } finally {
    rmSync(operationOutputRoot, { force: true, recursive: true });
    rmSync(scratchRoot, { force: true, recursive: true });
  }
}

export function isExplicitNonSuccess(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { disposition, failureClass, diagnostic, effects, observedFields, boundaryProofCount } =
    value;
  return (
    (disposition === "failed" || disposition === "paused") &&
    typeof failureClass === "string" &&
    failureClass.length > 0 &&
    typeof diagnostic === "string" &&
    diagnostic.length > 0 &&
    Array.isArray(effects) &&
    effects.length === 0 &&
    typeof observedFields === "number" &&
    observedFields > 0 &&
    typeof boundaryProofCount === "number" &&
    boundaryProofCount > 0
  );
}
