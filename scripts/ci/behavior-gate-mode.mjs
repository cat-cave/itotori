const EXPECTED_APPLICABLE_CELL_COUNT = 687;

function count(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label}-invalid`);
  return value;
}

export function requireCompleteBehaviorMatrix(report) {
  const applicable = count(report?.summary?.applicableCellCount, "full-matrix-applicable-count");
  const passing = count(report?.summary?.passingCellCount, "full-matrix-passing-count");
  if (applicable !== EXPECTED_APPLICABLE_CELL_COUNT) {
    throw new Error(
      `full-matrix-applicable-count-mismatch:${applicable}/${EXPECTED_APPLICABLE_CELL_COUNT}`,
    );
  }
  if (passing !== applicable) throw new Error(`full-matrix-incomplete:${passing}/${applicable}`);
  return report;
}

export function parseBehaviorGateArgs(args) {
  if (args.length === 0) return { mode: "accepted", artifactRoot: "behavior-proof" };
  const modes = new Map([
    ["--accepted", "accepted"],
    ["--full-matrix", "full-matrix"],
    ["--local-candidate", "local"],
  ]);
  const mode = modes.get(args[0]);
  if (mode === undefined || args.length > 2) {
    throw new Error(
      "usage: verify-behavior-gate.mjs [--local-candidate|--accepted|--full-matrix] [directory]",
    );
  }
  return { mode, artifactRoot: args[1] ?? "behavior-proof" };
}
