import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseOwnedJsonInput } from "./explicit-failure/command-boundary.js";

/** Production CLI reader also used by executable command-boundary probes. */
export function readOwnedJsonFile(path: string): unknown {
  return parseOwnedJsonInput(readFileSync(path, "utf8"));
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
