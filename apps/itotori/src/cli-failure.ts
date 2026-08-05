import { RequiredDeploymentInputError } from "./deployment-required-input.js";
import { ProductDatabaseNotRunningError } from "./database-unreachable.js";

/** Structured CLI failure codes that print `error.code` / `error.remediation` lines. */
type StructuredCliFailure = RequiredDeploymentInputError | ProductDatabaseNotRunningError;

/**
 * Report a CLI failure. Typed product-database failures print code + remediation
 * and keep the driver message as `error.detail` when present.
 */
export function reportCliFailure(
  error: unknown,
  write: (line: string) => void = (line) => console.error(line),
): number {
  if (isStructuredCliFailure(error)) {
    write(error.message);
    write(`error.code=${error.code}`);
    write(`error.remediation=${error.remediation}`);
    const detail = failureDetail(error);
    if (detail !== undefined) write(`error.detail=${detail}`);
    return error instanceof ProductDatabaseNotRunningError ? 3 : 1;
  }
  write(error instanceof Error ? error.message : String(error));
  return 1;
}

function isStructuredCliFailure(error: unknown): error is StructuredCliFailure {
  return (
    error instanceof RequiredDeploymentInputError || error instanceof ProductDatabaseNotRunningError
  );
}

/** Prefer the preserved driver / nested cause message; never invent one. */
function failureDetail(error: StructuredCliFailure): string | undefined {
  const cause = error.cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return undefined;
}
