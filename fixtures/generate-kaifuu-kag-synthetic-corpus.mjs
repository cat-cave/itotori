#!/usr/bin/env node
// KAIFUU-203: deterministic manifest generator for the CC0 synthetic KAG `.ks`
// corpus under `fixtures/public/kaifuu-kag-synthetic-corpus/`.
//
// The `.ks` files themselves are HAND-AUTHORED, original, CC0 KAG scenario
// scripts (they contain NO copyrighted game text). This generator does NOT
// author or rewrite them: it indexes the committed corpus deterministically —
// sha256, byte length, and the distinct KAG tag inventory scanned from each
// file's bytes — and emits `kaifuu-kag-synthetic-corpus.manifest.json`.
//
// Determinism: files are discovered and sorted by name; tags are sorted; no
// file-modification times are recorded. `--check` regenerates the manifest
// in-memory and fails (exit 1) on any byte drift from the committed manifest.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDirRel = "fixtures/public/kaifuu-kag-synthetic-corpus";
const corpusDir = resolve(repoRoot, corpusDirRel);
const manifestPath = resolve(repoRoot, "fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json");

// The canonical KAG "profile-B" tag inventory this corpus is built to exercise
// (KAIFUU-203 spec). Every tag scanned from the corpus that is one of these is
// reported as a profile-B tag; the corpus must cover >= 6 distinct ones.
const PROFILE_B_TAGS = [
  "r",
  "l",
  "p",
  "cm",
  "ct",
  "wait",
  "jump",
  "call",
  "return",
  "if",
  "endif",
  "macro",
  "endmacro",
  "eval",
  "image",
  "playbgm",
];

// Scan the distinct KAG inline `[tag …]` names from one `.ks` file's bytes.
// Mirrors the kaifuu-kirikiri KAG parser: `[[` is the literal-bracket escape
// (not a tag), and a tag name is `[A-Za-z_][A-Za-z0-9_]*` immediately after `[`.
function scanTags(text) {
  const tags = new Set();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "[") {
      continue;
    }
    if (text[i + 1] === "[") {
      i += 1; // `[[` literal escape — skip both brackets.
      continue;
    }
    const match = /^\[([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
    if (match) {
      tags.add(match[1]);
    }
  }
  return [...tags].sort();
}

function buildManifest() {
  const fileNames = readdirSync(corpusDir)
    .filter((name) => name.endsWith(".ks"))
    .sort();

  const files = fileNames.map((name) => {
    const abs = resolve(corpusDir, name);
    const content = readFileSync(abs);
    const text = content.toString("utf8");
    return {
      path: `${corpusDirRel}/${name}`,
      role: "source-game",
      mediaType: "text/plain; charset=utf-8",
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
      tagInventory: scanTags(text),
      redistributable: true,
    };
  });

  const tagInventory = [...new Set(files.flatMap((file) => file.tagInventory))].sort();
  const profileBTagInventory = tagInventory.filter((tag) => PROFILE_B_TAGS.includes(tag));

  return {
    $schema: "./kag-corpus.manifest.schema.json",
    schemaVersion: "0.1.0",
    "SPDX-License-Identifier": "CC0-1.0",
    fixture: {
      id: "kaifuu-kag-synthetic-corpus",
      title: "Kaifuu Synthetic KAG .ks Corpus (CC0)",
      kind: "synthetic",
      summary:
        "Hand-authored, original CC0 KiriKiri/TyranoScript KAG `.ks` scenario scripts covering dialogue, choices, labels, jumps, variables, comments, and the KAG profile-B tag inventory. Contains no copyrighted game text.",
      sourceLocale: "en-US",
      license: {
        spdx: "CC0-1.0",
        evidence:
          "All `.ks` scripts are original prose hand-authored in-repository for KAIFUU-203 and dedicated to the public domain (CC0-1.0); each file carries a `; SPDX-License-Identifier: CC0-1.0` header. No retail/game bytes.",
      },
      provenance: {
        author: "Itotori contributors",
        creationMethod:
          "Hand-authored original KAG `.ks` scenario scripts; this manifest is regenerated deterministically by fixtures/generate-kaifuu-kag-synthetic-corpus.mjs (sha256 + byte length + scanned tag inventory, no modification times).",
        rawAssetPolicy: "contains-no-copyrighted-game-assets",
      },
    },
    profileBTagInventory,
    tagInventory,
    files,
    aggregateStats: {
      files: files.length,
      sourceLocales: ["en-US"],
      notes:
        "Original CC0 KAG scenario scripts. tagInventory is the union of distinct inline KAG tags scanned across all files; profileBTagInventory is the subset drawn from the KAG profile-B inventory (r, l, p, cm, ct, wait, jump, call, return, if, endif, macro, endmacro, eval, image, playbgm). Includes at least one label/jump pair for control-flow replay.",
    },
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const rendered = stableJson(buildManifest());

  if (check) {
    let committed;
    try {
      committed = readFileSync(manifestPath, "utf8");
    } catch (error) {
      console.error(`kaifuu-kag-synthetic-corpus manifest missing: ${error.message}`);
      process.exit(1);
    }
    if (committed !== rendered) {
      console.error(
        "kaifuu-kag-synthetic-corpus.manifest.json is stale; re-run " +
          "`node fixtures/generate-kaifuu-kag-synthetic-corpus.mjs` to regenerate.",
      );
      process.exit(1);
    }
    console.log("kaifuu-kag-synthetic-corpus.manifest.json is up to date");
    return;
  }

  writeFileSync(manifestPath, rendered);
  console.log(`wrote ${resolve(manifestPath)}`);
}

main();
