import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: node scripts/print-hello-summary.mjs <summary.json>");
}

const summary = JSON.parse(readFileSync(path, "utf8"));
console.log("Itotori hello world passed");
console.log(`bridgeId=${summary.bridgeId}`);
console.log(`localeBranchId=${summary.localeBranchId}`);
console.log(`patchExportId=${summary.patchExportId}`);
console.log(`patchResultId=${summary.patchResultId}`);
console.log(`runtimeReportId=${summary.runtimeReportId}`);
console.log(`status=${summary.status}`);
