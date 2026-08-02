import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Checks the host-facing current link against one complete retained payload. */
export function activePayloadMatches(
  stateRoot: string,
  version: string,
  contents: string,
): boolean {
  const current = join(stateRoot, "current");
  const expected = join(stateRoot, "releases", version, "payload");
  try {
    return (
      lstatSync(current).isSymbolicLink() &&
      realpathSync(current) === realpathSync(expected) &&
      readFileSync(join(current, "selected-output.txt"), "utf8") === contents
    );
  } catch {
    return false;
  }
}
