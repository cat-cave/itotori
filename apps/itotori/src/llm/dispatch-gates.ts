export function gateRejectionDiagnostic(error: unknown): string | null {
  if (!(error instanceof Error) || !["FinalizeError", "RepairFinalizeError"].includes(error.name))
    return null;
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string }).code
      : "unspecified";
  if (
    !/^(?:protected-span|scope-kind-mismatch|segment-batch-mismatch|double-finalize|unit-cardinality|unit-order|source-hash|encoding|choice-encoding|basis-mismatch|resolving-evidence|parent-batch-mismatch|parent-mismatch|bundle-mismatch|unaffected-mutated|failed-ids-mismatch|passing-id-patch|patch-order|not-grounded|forbidden-key|invalid-target|missing-output)$/u.test(
      code,
    )
  )
    return null;
  return code === "protected-span"
    ? "content gate rejected output: protected placeholder preservation failed"
    : `content gate rejected output: ${error.name} (${code})`;
}
