#!/usr/bin/env node
// Deterministic metadata-only intake for the supplied read-only LustMemory RPG
// Maker MV/MZ English release. This script never copies source
// bytes into the repository: it emits only relative paths, byte counts,
// SHA-256 digests, command counts, and JSON-pointer samples.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  repoRoot,
  "fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json",
);
const sourceRoot =
  process.env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ ??
  "/scratch/itotori-research/rpg-maker-mv-mz/extracted/LustMemory";
const sourceDataDir = resolveDataDir(sourceRoot);
const SPDX_ID = "LicenseRef-LustMemory-English-Public-Release";

function resolveDataDir(root) {
  const direct = resolve(root, "data");
  const nested = resolve(root, "www/data");
  try {
    readdirSync(direct);
    return direct;
  } catch {
    readdirSync(nested);
    return nested;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pointer(tokens) {
  return `/${tokens.map((token) => String(token).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function sourceFileRole(name) {
  if (/^Map\d+\.json$/.test(name)) {
    return "map";
  }
  if (name === "CommonEvents.json") {
    return "common-events";
  }
  if (name === "System.json") {
    return "system";
  }
  if (
    /^(Actors|Animations|Armors|Classes|Enemies|Items|Skills|States|Tilesets|Troops|Weapons)\.json$/.test(
      name,
    )
  ) {
    return "database";
  }
  return "other-data";
}

function stringParameter(command, index) {
  const value = command?.parameters?.[index];
  return typeof value === "string" && value.length > 0;
}

function choiceParameter(command) {
  return Array.isArray(command?.parameters?.[0]);
}

function commandCode(command) {
  return Number.isInteger(command?.code) ? command.code : undefined;
}

function collectMapSurfaces(fileName, value, result) {
  const events = Array.isArray(value?.events) ? value.events : [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const pages = Array.isArray(events[eventIndex]?.pages) ? events[eventIndex].pages : [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const list = Array.isArray(pages[pageIndex]?.list) ? pages[pageIndex].list : [];
      for (let commandIndex = 0; commandIndex < list.length; commandIndex += 1) {
        const command = list[commandIndex];
        const code = commandCode(command);
        const commandPointer = pointer([
          "events",
          eventIndex,
          "pages",
          pageIndex,
          "list",
          commandIndex,
        ]);
        if (code === 401 && stringParameter(command, 0)) {
          result.showText += 1;
          if (result.samples.showText.length < 5) {
            result.samples.showText.push({
              path: `www/data/${fileName}`,
              pointer: `${commandPointer}/parameters/0`,
              code,
            });
          }
        }
        if (code === 102 && choiceParameter(command)) {
          result.showChoices += 1;
          if (result.samples.showChoices.length < 5) {
            result.samples.showChoices.push({
              path: `www/data/${fileName}`,
              pointer: `${commandPointer}/parameters/0`,
              code,
            });
          }
        }
      }
    }
  }
}

function collectCommonEventSurfaces(value, result) {
  const events = Array.isArray(value) ? value : [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const list = Array.isArray(events[eventIndex]?.list) ? events[eventIndex].list : [];
    for (let commandIndex = 0; commandIndex < list.length; commandIndex += 1) {
      const code = commandCode(list[commandIndex]);
      if (code === undefined) {
        continue;
      }
      result.commonEventCommands += 1;
      if (result.samples.commonEventCommands.length < 5) {
        result.samples.commonEventCommands.push({
          path: "www/data/CommonEvents.json",
          pointer: pointer([eventIndex, "list", commandIndex]),
          code,
        });
      }
    }
  }
}

function collectSystemTerms(value, result) {
  const terms = value?.terms;
  if (terms === null || typeof terms !== "object" || Array.isArray(terms)) {
    return;
  }
  for (const key of Object.keys(terms).sort()) {
    result.systemTermsFields += 1;
    if (result.samples.systemTermsFields.length < 5) {
      result.samples.systemTermsFields.push({
        path: "www/data/System.json",
        pointer: pointer(["terms", key]),
      });
    }
  }
}

function buildManifest() {
  const fileNames = readdirSync(sourceDataDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (fileNames.length === 0) {
    throw new Error("profile-A source has no data/*.json files");
  }

  const extractionSurfaces = {
    showText: 0,
    showChoices: 0,
    commonEventCommands: 0,
    systemTermsFields: 0,
    samples: {
      showText: [],
      showChoices: [],
      commonEventCommands: [],
      systemTermsFields: [],
    },
  };

  const sourceFiles = fileNames.map((name) => {
    const bytes = readFileSync(resolve(sourceDataDir, name));
    const value = JSON.parse(bytes.toString("utf8"));
    if (/^Map\d+\.json$/.test(name)) {
      collectMapSurfaces(name, value, extractionSurfaces);
    } else if (name === "CommonEvents.json") {
      collectCommonEventSurfaces(value, extractionSurfaces);
    } else if (name === "System.json") {
      collectSystemTerms(value, extractionSurfaces);
    }
    return {
      path: `www/data/${name}`,
      role: sourceFileRole(name),
      mediaType: "application/json",
      sha256: sha256(bytes),
      bytes: bytes.length,
    };
  });

  if (extractionSurfaces.showText < 5 || extractionSurfaces.showChoices < 1) {
    throw new Error(
      "profile-A source does not meet the required Show Text / Show Choices coverage",
    );
  }
  if (extractionSurfaces.commonEventCommands < 1 || extractionSurfaces.systemTermsFields < 1) {
    throw new Error("profile-A source lacks CommonEvents or System.terms coverage");
  }

  return {
    $schema: "./rpgmaker-profile-a.manifest.schema.json",
    schemaVersion: "0.1.0",
    "SPDX-License-Identifier": SPDX_ID,
    fixture: {
      id: "kaifuu-rpgmaker-mv-mz-profile-a",
      title: "Kaifuu RPG Maker MV/MZ Profile A Metadata Intake",
      kind: "metadata-only",
      summary:
        "Read-only metadata intake from the supplied public-licensed LustMemory English RPG Maker MV release. The repository contains hashes, byte counts, event-command counts, and structural samples only; it contains no game text, assets, or license copy.",
      sourceLocale: "en-US",
      license: {
        spdx: SPDX_ID,
        evidence:
          "The supplied LustMemory English release is the task-authorized public-licensed source. Its SPDX LicenseRef is preserved verbatim; this metadata-only intake intentionally does not copy the release license or any game bytes.",
      },
      provenance: {
        creationMethod:
          "fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs deterministically scans the supplied read-only source data JSON in bytewise filename order and emits only hashes, byte counts, counts, and JSON-pointer samples.",
        rawAssetPolicy: "contains-no-copyrighted-game-assets",
        sourcePath: "LustMemory/www/data",
      },
    },
    sourceFiles,
    extractionSurfaces,
    aggregateStats: {
      sourceFiles: sourceFiles.length,
      mapFiles: sourceFiles.filter((file) => file.role === "map").length,
      notes:
        "showText counts non-empty code-401 Show Text parameters in Map*.json; showChoices counts code-102 Show Choices commands with an option array; commonEventCommands counts numeric command records in CommonEvents.json, including code 0 terminators; systemTermsFields counts own fields of System.json terms. Samples are structural JSON pointers and command codes only.",
    },
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const rendered = stableJson(buildManifest());
  if (process.argv.includes("--check")) {
    let committed;
    try {
      committed = readFileSync(manifestPath, "utf8");
    } catch (error) {
      throw new Error(`profile-A manifest is missing: ${error.message}`);
    }
    if (committed !== rendered) {
      throw new Error(
        "profile-A manifest is stale; re-run `pnpm node fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs`",
      );
    }
    console.log("kaifuu-rpgmaker-mv-mz-profile-a.manifest.json is up to date");
    return;
  }
  writeFileSync(manifestPath, rendered);
  console.log("wrote fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json");
}

main();
