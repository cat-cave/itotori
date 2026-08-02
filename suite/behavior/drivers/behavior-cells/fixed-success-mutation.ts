import { readFileSync } from "node:fs";

const SCHEMA = "itotori.behavior-fixed-success-mutation.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mutationId(cell: string): string {
  return `kill::${cell.slice("cell::".length)}`;
}

export function requireFixedSuccessMutationArtifact(path: string | null, cell: string): void {
  if (path === null) throw new Error(`fixed-success-mutation-artifact-missing:${cell}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`fixed-success-mutation-artifact-unreadable:${cell}`);
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== SCHEMA ||
    parsed.cell !== cell ||
    parsed.mutationId !== mutationId(cell)
  ) {
    throw new Error(`fixed-success-mutation-artifact-invalid:${cell}`);
  }
}

export function fixedSuccessEnabled(
  mode: "normal" | "fixed-success",
  mutationArtifactPath: string | null,
  cell: string,
): boolean {
  if (mode === "fixed-success") {
    requireFixedSuccessMutationArtifact(mutationArtifactPath, cell);
    return true;
  }
  if (mutationArtifactPath !== null) {
    throw new Error(`normal-execution-has-fixed-success-mutation:${cell}`);
  }
  return false;
}
