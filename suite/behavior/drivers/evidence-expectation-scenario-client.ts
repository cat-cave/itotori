import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import { isRecord, type ProductRequest } from "./evidence-contract.js";

export function independentlyEvaluateScenario(
  productBoundaryPath: string,
  request: ProductRequest,
): Record<string, unknown> {
  const path = resolve(dirname(productBoundaryPath), "evidence-expectation-scenario-boundary.js");
  const result = spawnSync(process.execPath, [path, JSON.stringify(request)], {
    cwd: dirname(path),
    encoding: "utf8",
  });
  if (
    result.status !== 0 ||
    result.stderr !== "" ||
    !result.stdout.endsWith("\n") ||
    result.stdout.trimEnd().split("\n").length !== 1
  )
    throw new Error(
      `expectation-scenario-boundary-failed:${result.status ?? "no-status"}:${result.stderr.trim()}`,
    );
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed)) throw new Error("expectation-scenario-output-invalid");
  return parsed;
}
