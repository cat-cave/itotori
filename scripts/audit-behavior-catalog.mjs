#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatBehaviorCatalogResult,
  validateBehaviorCatalog,
} from "./audit-behavior-catalog-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const rootIndex = process.argv.indexOf("--root");
const root =
  rootIndex >= 0 && process.argv[rootIndex + 1]
    ? resolve(process.argv[rootIndex + 1])
    : defaultRoot;

const result = validateBehaviorCatalog(root);
const output = `${formatBehaviorCatalogResult(result)}\n`;
if (result.ok) process.stdout.write(output);
else {
  process.stderr.write(output);
  process.exitCode = 1;
}
