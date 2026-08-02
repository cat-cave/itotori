import { readFileSync } from "node:fs";
import {
  assertBenchmarkReportV02,
  assertBridgeBundleV02,
  assertRuntimeEvidenceReportV02,
} from "@itotori/localization-bridge-schema";

const bridge: unknown = readJson(
  "../../../packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
);
assertBridgeBundleV02(bridge);
export const bridgeFixture = bridge;

const runtimeReport: unknown = readJson(
  "../../../packages/localization-bridge-schema/test/examples/runtime-evidence-v0.2.json",
);
assertRuntimeEvidenceReportV02(runtimeReport);
export const runtimeReportFixture = runtimeReport;

const benchmarkReport: unknown = readJson(
  "../../../packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json",
);
assertBenchmarkReportV02(benchmarkReport);
export const benchmarkReportFixture = benchmarkReport;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}
