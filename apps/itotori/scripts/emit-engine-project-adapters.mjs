// Emit co-located engine-project adapter manifests into the tsc outDir.
//
// `adapter-catalog.ts` discovers engines with `readdirSync` beside the compiled
// module. `tsc` only emits TypeScript (and JSON that is imported as a module);
// these declarations are discovered, not imported, so they must be copied
// explicitly as part of the package build. Declared in package.json `build`
// after `tsc` so a clean build always ships the catalog the CLI loads from dist.

import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const sourceDirectory = join(packageRoot, "src", "engine-project", "adapters");
const outDirectory = join(packageRoot, "dist", "engine-project", "adapters");

rmSync(outDirectory, { recursive: true, force: true });
cpSync(sourceDirectory, outDirectory, { recursive: true });

const manifests = readdirSync(outDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();
if (manifests.length === 0) {
  throw new Error(`emit-engine-project-adapters: no adapter manifests found at ${sourceDirectory}`);
}

process.stdout.write(
  `emit-engine-project-adapters: ${manifests.length} manifest(s) -> dist/engine-project/adapters\n`,
);
