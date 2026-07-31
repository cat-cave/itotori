import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { portableFile } from "./evidence-portability.js";

export function verifyIsolatedLocalControls(): boolean {
  const root = mkdtempSync(join(tmpdir(), "evidence-local-controls-"));
  try {
    const safeReference = "managed/controls/safe.bin";
    const safePath = resolve(root, safeReference);
    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, "content-free-local-control\n", "utf8");
    const invalidReferences = [
      resolve(root, safeReference),
      "file:///private/evidence.bin",
      "managed/controls/../safe.bin",
      "managed\\private\\evidence.bin",
      "C:/private/evidence.bin",
    ];
    if (
      portableFile(root, safeReference) === null ||
      invalidReferences.some((reference) => portableFile(root, reference) !== null)
    ) {
      return false;
    }
    const symlinkReference = "managed/controls/link.bin";
    symlinkSync("safe.bin", resolve(root, symlinkReference));
    return portableFile(root, symlinkReference) === null;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
