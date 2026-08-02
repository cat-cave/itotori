// A small owned-file boundary for launch wrappers that must hand a credential
// file to another process. The path is intentionally callback-scoped: callers
// cannot accidentally retain it after the launch returns or throws.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TemporarySecretFileInput {
  readonly contents: string;
  readonly directoryPrefix: string;
  readonly fileName: string;
}

/**
 * Write one wrapper-owned private file, run the operation, then remove both
 * file and unique parent directory on every exit. It never logs contents.
 */
export function withTemporarySecretFile<T>(
  input: TemporarySecretFileInput,
  operation: (path: string) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), input.directoryPrefix));
  const path = join(directory, input.fileName);
  try {
    writeFileSync(path, input.contents, { mode: 0o600 });
    chmodSync(path, 0o600);
    return operation(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
