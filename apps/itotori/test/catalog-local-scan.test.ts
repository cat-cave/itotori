import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand } from "../src/cli-handlers.js";
import { scanCatalogLocalRoot } from "../src/services/catalog-local-scan.js";

const tempRoots: string[] = [];
const localHashKey = "catalog-local-test-hash-key";

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.splice(0, tempRoots.length);
});

describe("catalog local scanner", () => {
  it("emits a redacted sidecar with stable hashes and local catalog states", async () => {
    const root = await syntheticCatalogRoot();

    const report = await scanCatalogLocalRoot({
      rootPath: root,
      owned: true,
      rootLabel: "synthetic-private-fixture",
      hashKey: localHashKey,
      now: fixedClock(),
    });
    const serialized = JSON.stringify(report);

    expect(report.schemaVersion).toBe("catalog.local_corpus_sidecar.v0.1");
    expect(report.scannerName).toBe("itotori-local-corpus-scanner");
    expect(report.scanRoot).toEqual({
      labelHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      pathHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      pathRedactionClass: "private_path_hash",
    });
    expect(report.entries.every((entry) => entry.owned)).toBe(true);
    expect(report.entries.every((entry) => entry.pathHash.match(/^sha256:[a-f0-9]{64}$/u))).toBe(
      true,
    );
    expect(report.entries.every((entry) => entry.localId.startsWith("catalog-local-entry:"))).toBe(
      true,
    );
    expect(report.privacy).toEqual({
      hashMode: "hmac-sha256",
      hashKeyProvided: true,
      keyEmitted: false,
    });
    expect(report.summary.byEntryKind.source_archive).toBe(3);
    expect(report.summary.byEntryKind.installed_game).toBe(1);
    expect(report.summary.byEntryKind.collection_member).toBe(2);
    expect(report.summary.byEntryKind.edition).toBe(1);
    expect(report.summary.byEntryKind.sidecar_metadata).toBe(1);
    expect(report.summary.byInstallState.source_archive).toBe(3);
    expect(report.summary.byInstallState.installed).toBe(5);
    expect(report.summary.byArchiveState.archive_file).toBe(3);
    expect(report.summary.byArchiveState.mixed_archive_and_install).toBe(2);
    expect(report.summary.byEngine.rpg_maker_mv_mz).toBe(1);
    expect(report.summary.byEngine.renpy).toBe(2);
    expect(report.summary.byEngine.rpg_maker_vx_ace).toBe(1);
    expect(report.summary.byEngine.unknown).toBe(3);
    expect(report.summary.extensionCounts.unknown_extension).toBe(1);
    expect(report.summary.extensionCounts).not.toHaveProperty(".secrettitle");
    expect(
      report.entries.some(
        (entry) =>
          entry.entryKind === "source_archive" &&
          entry.archiveDetection.evidence.archiveExtension === ".zip",
      ),
    ).toBe(true);

    const installed = report.entries.find((entry) => entry.entryKind === "installed_game");
    expect(installed).toMatchObject({
      packageKind: "loose_files",
      installState: "installed",
      engineDetection: {
        schemaVersion: "catalog.local_corpus_detection.v0.1",
        schemaDialect: "itotori_local_corpus_detection",
        gameDir: "[redacted-local-game-dir]",
        status: "unknown",
        detections: [],
        warnings: [
          expect.stringContaining("no registered extraction adapter matched this directory"),
        ],
        archiveDetection: {
          schemaVersion: "catalog.local_corpus_archive_detection.v0.1",
          schemaDialect: "itotori_local_corpus_archive_detection",
          status: "matched",
          evidencePolicy: expect.stringContaining("aggregate-only"),
          rows: [
            {
              rowId: "rpg-maker-mv-mz-metadata",
              engineFamily: "rpg_maker_mv_mz",
              detected: true,
              detectedVariant: "mv-mz-system-json-layout",
              signals: ["engine_metadata"],
              evidence: [
                {
                  evidenceType: "metadata_field",
                  pattern: "www/data/System.json",
                  status: "matched",
                  count: 1,
                  detail: "aggregate marker count from redacted local corpus scan",
                },
              ],
              requirements: [],
              capabilities: [
                {
                  capability: "detection",
                  status: "limited",
                  limitation: expect.stringContaining("no adapter execution"),
                },
              ],
              diagnostics: [],
              supportBoundary: expect.stringContaining("no registered Kaifuu adapter execution"),
            },
          ],
        },
      },
      localEngineEvidence: {
        schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
        producer: "itotori-local-corpus-scanner",
        localDetectionSchemaVersion: "catalog.local_corpus_detection.v0.1",
        adapterId: "local-scan:rpg_maker_mv_mz",
        engineName: "rpg_maker_mv_mz",
        engineSource: "local_scan",
        engineConfidence: "high",
        readiness: {
          identify: "partial",
          inventory: "unknown",
          extract: "unknown",
          patch: "unknown",
        },
        evidence: {
          extensionCounts: expect.objectContaining({
            ".json": 1,
            unknown_extension: 1,
          }),
          fileKindCounts: expect.objectContaining({
            other: 1,
          }),
          markerKinds: expect.arrayContaining(["rpgmaker_mv_metadata"]),
        },
      },
      catalogLocalScanEntryInput: {
        pathRedactionClass: "private_path_hash",
        owned: true,
        engineName: "rpg_maker_mv_mz",
        engineSource: "local_scan",
        engineConfidence: "high",
      },
    });
    expect(installed?.extensionCounts.unknown_extension).toBe(1);
    expect(installed?.extensionCounts).not.toHaveProperty(".secrettitle");

    expect(serialized).not.toContain("kaifuu.rpgmaker_mv");
    expect(serialized).not.toContain("kaifuu.renpy");
    expect(serialized).not.toContain("kaifuu.rpgmaker_vx_ace");
    expect(serialized).not.toContain('"schemaVersion":"0.1.0"');
    expect(serialized).not.toContain("kaifuuDetectionSchemaVersion");
    expect(serialized).not.toContain(bareSha256(`root:${root}`));
    expect(serialized).not.toContain(bareSha256("root-label:synthetic-private-fixture"));
    expect(serialized).not.toContain(
      bareSha256(`path:${report.hashes.rootPathHash}:Vendor/Game.zip`),
    );
    expect(serialized).not.toContain(bareSha256("collection:sha256:fixture-collection"));
    expect(serialized).not.toContain(bareSha256("edition:sha256:fixture-original"));
    expect(serialized).not.toContain(hmacSha256("wrong-local-key", "root-path", root));
    expect(report.hashes.rootPathHash).toBe(hmacSha256(localHashKey, "root-path", root));
    expect(report.scanRoot.labelHash).toBe(
      hmacSha256(localHashKey, "root-label", "synthetic-private-fixture"),
    );
    expect(
      report.entries.some(
        (entry) =>
          entry.pathHash ===
          hmacSha256(localHashKey, "entry-path", `${report.hashes.rootPathHash}:Vendor/Game.zip`),
      ),
    ).toBe(true);
    expect(serialized).not.toContain(localHashKey);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("Private Story Vol 1");
    expect(serialized).not.toContain("Installed Secret Game");
    expect(serialized).not.toContain("Internal Secret Link");
    expect(serialized).not.toContain("script.rpy");
    expect(serialized).not.toContain("opening.txt");
    expect(serialized).not.toContain("SecretTitle");
    expect(serialized).not.toContain(".secrettitle");
    expect(serialized).not.toContain("SECRET_KEY");
    expect(serialized).not.toContain("screenshot");
    expect(serialized).not.toContain("Secret HD Edition");
    expect(serialized).not.toContain("fixture-collection");
    expect(serialized).not.toContain("fixture-original");
  });

  it("requires a local hash key instead of emitting bare deterministic private hashes", async () => {
    const root = await syntheticCatalogRoot();

    await expect(
      scanCatalogLocalRoot({
        rootPath: root,
        now: fixedClock(),
      }),
    ).rejects.toThrow(/requires --hash-key or ITOTORI_LOCAL_CORPUS_HASH_KEY/u);
  });

  it("labels local archive detection rows so canonical Kaifuu 0.1.0 consumers cannot accept them", async () => {
    const root = await syntheticCatalogRoot();

    const report = await scanCatalogLocalRoot({
      rootPath: root,
      owned: true,
      rootLabel: "synthetic-private-fixture",
      hashKey: localHashKey,
      now: fixedClock(),
    });

    const archiveDetection = report.entries
      .map((entry) => entry.engineDetection?.archiveDetection)
      .find((candidate) =>
        candidate?.rows.some(
          (row) =>
            row.engineFamily === "rpg_maker_vx_ace" ||
            row.signals.some((signal) => !canonicalKaifuuArchiveDetectionSignals.has(signal)),
        ),
      );

    expect(archiveDetection).toBeDefined();
    expect(archiveDetection?.schemaVersion).toBe("catalog.local_corpus_archive_detection.v0.1");
    expect(archiveDetection?.schemaDialect).toBe("itotori_local_corpus_archive_detection");
    expect(isCanonicalKaifuuArchiveDetectionV010(archiveDetection)).toBe(false);
    expect(
      isCanonicalKaifuuArchiveDetectionV010({
        ...archiveDetection,
        schemaVersion: "0.1.0",
      }),
    ).toBe(false);
  });

  it("rejects symlink scan roots while continuing to skip internal symlinks", async () => {
    const root = await syntheticCatalogRoot();
    const linkRoot = `${root}-link`;
    tempRoots.push(linkRoot);
    await symlink(root, linkRoot);

    await expect(
      scanCatalogLocalRoot({
        rootPath: linkRoot,
        hashKey: localHashKey,
        now: fixedClock(),
      }),
    ).rejects.toThrow(/must not be a symbolic link/u);
  });

  it("wires catalog-local-corpus-scan through the CLI JSON writer", async () => {
    const root = await syntheticCatalogRoot();
    const writes = new Map<string, unknown>();
    const withServices = vi.fn(async () => {
      throw new Error("catalog-local-corpus-scan should not require database services");
    });

    await runItotoriCliCommand(
      [
        "catalog-local-corpus-scan",
        "--root",
        root,
        "--output",
        "catalog-local.json",
        "--root-label",
        "synthetic-private-fixture",
        "--owned",
        "false",
        "--max-depth",
        "5",
        "--hash-key",
        localHashKey,
      ],
      {
        io: {
          readJson: vi.fn(),
          writeJson: vi.fn((path: string, value: unknown) => {
            writes.set(path, value);
          }),
        },
        migrateDatabase: vi.fn(async () => {}),
        withServices,
      },
    );

    expect(withServices).not.toHaveBeenCalled();
    expect(writes.get("catalog-local.json")).toMatchObject({
      schemaVersion: "catalog.local_corpus_sidecar.v0.1",
      scannerVersion: "0.1.0",
      scanRoot: {
        labelHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        pathHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      owned: false,
      summary: {
        entryCount: 8,
        byEntryKind: {
          source_archive: 3,
          installed_game: 1,
          collection_member: 2,
          edition: 1,
          sidecar_metadata: 1,
        },
      },
      hashes: {
        rootPathHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        reportFingerprintHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    const report = writes.get("catalog-local.json") as Awaited<
      ReturnType<typeof scanCatalogLocalRoot>
    >;
    expect(report.entries.every((entry) => entry.owned === false)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(localHashKey);
  });
});

async function syntheticCatalogRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "itotori-private-catalog-"));
  tempRoots.push(root);

  await writeFile(join(root, "Private Story Vol 1.zip"), "archive bytes");

  await mkdir(join(root, "Installed Secret Game", "www", "data"), { recursive: true });
  await writeFile(join(root, "Installed Secret Game", "www", "data", "System.json"), "{}");
  await writeFile(join(root, "Installed Secret Game", "www", "data", "opening.txt"), "raw text");
  await writeFile(join(root, "Installed Secret Game", "cg.SecretTitle"), "private image bytes");
  await writeFile(join(root, "Installed Secret Game", "SECRET_KEY.ini"), "SECRET_KEY=abc");
  await writeFile(join(root, "Installed Secret Game", "embedded.zip"), "embedded archive");
  await symlink(join(root, "Installed Secret Game"), join(root, "Internal Secret Link"), "dir");

  await mkdir(join(root, "Vendor"), { recursive: true });
  await writeFile(join(root, "Vendor", "Game.zip"), "nested archive bytes");

  await mkdir(join(root, "Private Collection", "Member A", "game"), { recursive: true });
  await writeSafeMetadata(join(root, "Private Collection", "Member A"), {
    entryKind: "collection_member",
    releaseKind: "collection_member",
    collectionMemberOf: "sha256:fixture-collection",
  });
  await writeFile(join(root, "Private Collection", "Member A", "game", "script.rpy"), "label a");
  await mkdir(join(root, "Private Collection", "Member B", "game"), { recursive: true });
  await writeSafeMetadata(join(root, "Private Collection", "Member B"), {
    entryKind: "collection_member",
    releaseKind: "collection_member",
    collectionMemberOf: "sha256:fixture-collection",
  });
  await writeFile(join(root, "Private Collection", "Member B", "game", "script.rpy"), "label b");
  await writeFile(join(root, "Private Collection", "Member C.zip"), "collection archive bytes");

  await mkdir(join(root, "Secret HD Edition"), { recursive: true });
  await writeSafeMetadata(join(root, "Secret HD Edition"), {
    entryKind: "edition",
    releaseKind: "edition",
    editionOf: "sha256:fixture-original",
  });
  await writeFile(join(root, "Secret HD Edition", "Game.rgss3a"), "vx ace archive");

  await mkdir(join(root, "Metadata Only"), { recursive: true });
  await writeSafeMetadata(join(root, "Metadata Only"), {
    releaseKind: "unknown",
  });
  return root;
}

async function writeSafeMetadata(dir: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(dir, ".itotori-local-corpus.json"),
    `${JSON.stringify({ schemaVersion: "catalog.local_corpus_hint.v0.1", ...value })}\n`,
  );
}

function fixedClock(): () => Date {
  const dates = [new Date("2026-06-26T12:00:00.000Z"), new Date("2026-06-26T12:00:01.000Z")];
  let index = 0;
  return () => dates[Math.min(index++, dates.length - 1)] ?? dates[dates.length - 1]!;
}

function bareSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hmacSha256(key: string, scope: string, value: string): string {
  return `sha256:${createHmac("sha256", key)
    .update(scope)
    .update("\0")
    .update(value)
    .digest("hex")}`;
}

const canonicalKaifuuArchiveEngineFamilies = new Set([
  "kiri_kiri_xp3",
  "siglus",
  "reallive",
  "rpg_maker_mv_mz",
  "wolf_rpg_editor",
  "bgi_ethornell",
  "renpy",
  "unknown",
]);

const canonicalKaifuuArchiveDetectionSignals = new Set([
  "compressed",
  "encrypted",
  "packed",
  "protected",
  "missing_key",
  "helper_required",
  "unknown_variant",
]);

function isCanonicalKaifuuArchiveDetectionV010(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "0.1.0" || !Array.isArray(record.rows)) {
    return false;
  }
  return record.rows.every(isCanonicalKaifuuArchiveDetectionRowV010);
}

function isCanonicalKaifuuArchiveDetectionRowV010(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.engineFamily === "string" &&
    canonicalKaifuuArchiveEngineFamilies.has(row.engineFamily) &&
    Array.isArray(row.signals) &&
    row.signals.every(
      (signal) => typeof signal === "string" && canonicalKaifuuArchiveDetectionSignals.has(signal),
    )
  );
}
