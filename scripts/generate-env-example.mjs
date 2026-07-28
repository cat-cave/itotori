#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "config", "environment-registry.json");
const examplePath = path.join(root, ".env.example");

export function renderEnvironmentExample(values) {
  const header = [
    "# Generated from config/environment-registry.json; do not edit by hand.",
    "# These are deployment inputs only. Translator and per-title settings belong in product configuration.",
  ];
  const entries = values.flatMap((value) => [
    "",
    `# ${value.required ? "required" : `optional; default: ${value.default ?? "none"}`} | ${value.description}`,
    `# Why environmental: ${value.whyEnvironmental}`,
    `${value.name}=`,
  ]);
  return [...header, ...entries, ""].join("\n");
}

export function readEnvironmentRegistry() {
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(examplePath, renderEnvironmentExample(readEnvironmentRegistry()));
}
