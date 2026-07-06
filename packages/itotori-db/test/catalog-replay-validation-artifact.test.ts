// CATALOG-076: durable catalog replay VALIDATION record.
//
// Proves the durable validation artifact emitted from a real replay run:
//   * carries the required identity metadata (source id, fixture id, stable
//     import key, import transaction id, fact count, fact identities);
//   * is DETERMINISTIC (two runs of the same replay serialize byte-identically);
//   * is REDACTED (no private local path or raw source payload can leak).
//
// The real-replay-run cases are DB-classified (they drive an isolated migrated
// Postgres via db-test-context), so a run without DATABASE_URL is SKIPPED at the
// @itotori/db runner level — a skip is not coverage.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerReplayValidationRecord,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  type CatalogRecordedImporterFact,
} from "../src/services/catalog-recorded-importers.js";
import {
  buildCatalogReplayValidationArtifact,
  catalogReplayValidationArtifactNode,
  catalogReplayValidationArtifactVersion,
  catalogReplayValidationRecordFields,
  serializeCatalogReplayValidationArtifact,
  writeCatalogReplayValidationArtifact,
  type CatalogReplayValidationArtifact,
} from "../src/services/catalog-replay-validation-artifact.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-recorded-importers/vndb-dump-replay.json", import.meta.url),
    "utf8",
  ),
) as RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Gitignored (.tmp/) durable artifact adapter acceptance can cite by path+digest.
const citeableArtifactPath = path.join(repoRoot, ".tmp/itotori-db/catalog-replay-validation.json");

async function replayValidationForFixture(): Promise<CatalogCrawlerReplayValidationRecord[]> {
  const context = await isolatedMigratedContext();
  try {
    const catalogRepository = new ItotoriCatalogRepository(context.db);
    const crawlerRepository = new ItotoriCatalogCrawlerRepository(context.db);
    const runner = new ItotoriCatalogCrawlerRunner();
    const result = await runner.run(createRecordedCatalogCrawlerAdapter(vndbFixture), {
      repository: crawlerRepository,
      actor,
      workerId: "worker-catalog-076",
      mode: "recorded_fixture",
      ingestStep: createCatalogRecordedImporterIngestStep({ catalogRepository, actor }),
      verifyFactImport: createCatalogRecordedImporterVerifier({ catalogRepository, actor }),
    });
    return [...result.replayValidation];
  } finally {
    await context.close();
  }
}

describe("catalog replay validation artifact (CATALOG-076)", () => {
  it("emits a durable artifact from a real replay run with the required identity fields", async () => {
    const records = await replayValidationForFixture();
    expect(records.length).toBeGreaterThan(0);

    await rm(citeableArtifactPath, { force: true });
    const {
      path: emittedPath,
      artifact,
      json,
    } = await writeCatalogReplayValidationArtifact(records, citeableArtifactPath);

    // The on-disk artifact is the durable evidence; re-read it to prove it
    // persisted the same content adapter acceptance would cite.
    const persisted = JSON.parse(
      await readFile(emittedPath, "utf8"),
    ) as CatalogReplayValidationArtifact;
    expect(persisted).toEqual(artifact);

    expect(artifact.artifactVersion).toBe(catalogReplayValidationArtifactVersion);
    expect(artifact.node).toBe(catalogReplayValidationArtifactNode);
    expect(artifact.contractId).toBe("CATALOG-065");
    expect(artifact.recordCount).toBe(records.length);
    expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    for (const record of artifact.records) {
      // Every required field is present and non-empty identity metadata.
      expect(record.sourceId).toBeTruthy();
      expect(record.fixtureId).toBe("catalog-recorded-importer-vndb-dump-v0.1");
      expect(record.stableImportKey).toMatch(/^catalog-import:[0-9a-f]{64}$/u);
      expect(record.importTransactionId).toBe(record.stableImportKey);
      expect(record.factCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(record.factIdentities)).toBe(true);
      expect(record.factIdentities.length).toBe(record.factCount);
      // Only the whitelisted fields exist on the persisted record.
      expect(Object.keys(record).sort()).toEqual([...catalogReplayValidationRecordFields].sort());
    }

    // The specific fixture's known facts are represented verbatim.
    expect(artifact.records.map((record) => record.sourceId).sort()).toEqual(["v1001", "v1002"]);
    expect(artifact.records.flatMap((record) => record.factIdentities).sort()).toEqual([
      "catalogSource=vndb|sourceId=v1001",
      "catalogSource=vndb|sourceId=v1002",
    ]);
    expect(json.endsWith("\n")).toBe(true);
  });

  it("is deterministic: two independent replay runs serialize byte-identically", async () => {
    const [first, second] = await Promise.all([
      replayValidationForFixture(),
      replayValidationForFixture(),
    ]);

    const scratch = await mkdtemp(path.join(tmpdir(), "catalog-076-"));
    try {
      const a = await writeCatalogReplayValidationArtifact(first, path.join(scratch, "run-a.json"));
      const b = await writeCatalogReplayValidationArtifact(
        second,
        path.join(scratch, "run-b.json"),
      );
      const bytesA = await readFile(a.path);
      const bytesB = await readFile(b.path);
      // stableImportKey is derived from content (not per-job ids), and the
      // artifact carries no run-varying timestamp, so the two runs are byte-equal.
      expect(bytesA.equals(bytesB)).toBe(true);
      expect(a.artifact.digest).toBe(b.artifact.digest);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("catalog replay validation artifact redaction + determinism (pure)", () => {
  const baseRecords: CatalogCrawlerReplayValidationRecord[] = [
    {
      contractId: "CATALOG-065",
      catalogSource: "vndb",
      sourceId: "v1002",
      fixtureId: "fixture-x",
      stableImportKey: "catalog-import:bbbb",
      importTransactionId: "catalog-import:bbbb",
      stepKey: "step-2",
      factCount: 1,
      factIdentities: ["catalogSource=vndb|sourceId=v1002"],
      alreadyImported: false,
    },
    {
      contractId: "CATALOG-065",
      catalogSource: "vndb",
      sourceId: "v1001",
      fixtureId: "fixture-x",
      stableImportKey: "catalog-import:aaaa",
      importTransactionId: "catalog-import:aaaa",
      stepKey: "step-1",
      factCount: 1,
      factIdentities: ["catalogSource=vndb|sourceId=v1001"],
      alreadyImported: false,
    },
  ];

  it("redacts: raw payloads and private local paths never reach the artifact", () => {
    const secretPayload = { title: "SECRET_RAW_PAYLOAD", body: "do-not-persist" };
    const localPath = "/home/trevor/private/vault/secret-source.json";
    // Attach payload/path/rawResponse the way a careless upstream record might;
    // the whitelist projection must drop them.
    const contaminated = baseRecords.map(
      (record) =>
        ({
          ...record,
          payload: secretPayload,
          rawResponse: JSON.stringify(secretPayload),
          localPath,
          sourceFilePath: localPath,
        }) as unknown as CatalogCrawlerReplayValidationRecord,
    );

    const artifact = buildCatalogReplayValidationArtifact(contaminated);
    const serialized = serializeCatalogReplayValidationArtifact(artifact);

    expect(serialized).not.toContain("SECRET_RAW_PAYLOAD");
    expect(serialized).not.toContain("do-not-persist");
    expect(serialized).not.toContain("/home/trevor");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("rawResponse");
    expect(serialized).not.toContain("localPath");
    expect(serialized).not.toContain("sourceFilePath");

    for (const record of artifact.records) {
      expect(Object.keys(record).sort()).toEqual([...catalogReplayValidationRecordFields].sort());
    }
  });

  it("is deterministic regardless of input record order", () => {
    const forward = serializeCatalogReplayValidationArtifact(
      buildCatalogReplayValidationArtifact(baseRecords),
    );
    const reversed = serializeCatalogReplayValidationArtifact(
      buildCatalogReplayValidationArtifact([...baseRecords].reverse()),
    );
    expect(forward).toBe(reversed);

    // Records are sorted by stable content key, not collection order.
    const artifact = buildCatalogReplayValidationArtifact([...baseRecords].reverse());
    expect(artifact.records.map((record) => record.stableImportKey)).toEqual([
      "catalog-import:aaaa",
      "catalog-import:bbbb",
    ]);
  });
});
