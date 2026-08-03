import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Call {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: readonly string[], cwd: string): Call {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  return { status: result.status, signal: result.signal };
}

function sourceContents(): string {
  return JSON.stringify({
    gameTitle: "Clean Host Sample",
    currencyUnit: "C",
    hasEncryptedImages: true,
    hasEncryptedAudio: true,
    elements: ["", "Element"],
    equipTypes: ["", "Equipment"],
    skillTypes: ["", "Skill"],
    weaponTypes: ["", "Tool"],
    armorTypes: ["", "Covering"],
    terms: {
      basic: ["Level"],
      params: ["Health"],
      commands: ["Continue"],
      messages: { obtainGold: "Found %1" },
    },
  });
}

function addTranslatedTargets(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.units)) return false;
    let changed = false;
    const units: Record<string, unknown>[] = [];
    for (const candidate of parsed.units) {
      if (
        !isRecord(candidate) ||
        typeof candidate.sourceText !== "string" ||
        candidate.sourceText.length === 0
      ) {
        return false;
      }
      const targetText: string = changed
        ? candidate.sourceText
        : `Localized ${candidate.sourceText}`;
      changed ||= targetText !== candidate.sourceText;
      units.push({ ...candidate, target: { locale: "en-US", text: targetText } });
    }
    if (!changed) return false;
    parsed.units = units;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Drives an installed client through a real extraction and selected patch copy. */
export function patchBoundaryProof(binary: string, root: string, repositoryRoot: string): boolean {
  const source = join(root, "patch-source");
  const target = join(root, "patch-target");
  const extractedBundle = join(root, "extracted-bundle.json");
  const bundle = join(root, "translated-bundle.json");
  const sourceData = join(source, "data");
  const sourceSystem = join(sourceData, "System.json");
  mkdirSync(sourceData, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(sourceSystem, sourceContents(), "utf8");
  writeFileSync(join(target, "operator-owned.txt"), "do not copy or replace\n", "utf8");
  const sentinel = sha256(join(target, "operator-owned.txt"));
  const sourceDigest = sha256(sourceSystem);
  const extracted = run(
    process.execPath,
    [
      binary,
      "extract",
      "--engine",
      "rpg-maker",
      "--game-dir",
      source,
      "--game-id",
      "clean-host-proof",
      "--game-version",
      "1.0.0",
      "--source-profile-id",
      "clean-host",
      "--source-locale",
      "en-US",
      "--bundle-output",
      extractedBundle,
    ],
    repositoryRoot,
  );
  if (
    extracted.status !== 0 ||
    extracted.signal !== null ||
    !addTranslatedTargets(extractedBundle)
  ) {
    return false;
  }
  writeFileSync(bundle, readFileSync(extractedBundle));
  const applied = run(
    process.execPath,
    [
      binary,
      "patch",
      "--source",
      source,
      "--target",
      target,
      "--bundle",
      bundle,
      "--scope",
      "dialogue-only",
    ],
    repositoryRoot,
  );
  return (
    applied.status === 0 &&
    applied.signal === null &&
    existsSync(join(root, "patch-delta.kaifuu")) &&
    sha256(sourceSystem) === sourceDigest &&
    sha256(join(target, "operator-owned.txt")) === sentinel &&
    readdirSync(target).toSorted().join("\0") === "System.json\0operator-owned.txt" &&
    readFileSync(join(target, "System.json"), "utf8").includes("Localized ")
  );
}
