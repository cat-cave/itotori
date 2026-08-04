// DB-owned production composition proof for source-detected dashboard patchback.
// Clean-room sources sit below parent data roots; final CAS rows come from the
// real materializer before the installed endpoint regenerates and patches them.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import { createFieldMemoCipher } from "../src/composition/live/field-cipher.js";
import { sha256 } from "../src/llm/canonical-json.js";
import {
  materializePatchbackProduceInput,
  type AcceptedUnitOutput,
} from "../src/patchback/index.js";
import { buildFactSnapshot } from "../src/prepass/index.js";
import { createItotoriServer } from "../src/server.js";
import {
  withDatabaseItotoriServices,
  type ItotoriServiceFactory,
} from "../src/services/database-services.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { stageRealLiveQ5Fixture } from "./production-role-bindings-reallive-fixture.support.js";
type RawHttpResponse = { statusCode: number; body: Buffer };
type SourceFixture = {
  dataRoot: string;
  expectedSourceRoot: string;
  originalBytesPath: string;
  tarPath: string;
  targetTextIsRaw: boolean;
  dispose(): void;
};
type SeededRun = {
  runId: `sha256:${string}`;
  originalBytes: Buffer;
  tarPath: string;
  targets: string[];
  targetTextIsRaw: boolean;
};
describe("source-detected multi-engine dashboard patchback", () => {
  it("produces changed dashboard tar bytes for RealLive and RPG Maker parents without an engine parameter", async () => {
    const realLive = stageRealLiveQ5Fixture();
    const rpgMaker = stageRpgMakerFixture();
    const database = await isolatedMigratedContext();
    const previousFieldCipherKey = process.env.ITOTORI_FIELD_CIPHER_KEY;
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 29).toString("base64");
    try {
      const seededRuns = [
        await seedFinalizedRun({
          database,
          fixture: {
            dataRoot: realLive.root,
            expectedSourceRoot: realLive.sourceRoot,
            originalBytesPath: join(realLive.sourceRoot, "REALLIVEDATA", "Seen.txt"),
            tarPath: "REALLIVEDATA/Seen.txt",
            targetTextIsRaw: false,
          },
          fixtureId: "reallive",
          expectedEngineId: "reallive",
        }),
        await seedFinalizedRun({
          database,
          fixture: rpgMaker,
          fixtureId: "rpg-maker",
          expectedEngineId: "rpg-maker",
        }),
      ];

      const serviceFactory: ItotoriServiceFactory = async (callback, options) =>
        await withDatabaseItotoriServices(
          { databaseUrl: database.databaseUrl, sessionId: options?.sessionId },
          callback,
        );
      await withServer(serviceFactory, async (origin) => {
        for (const seeded of seededRuns) {
          const response = await requestProduce(origin, JSON.stringify({ runId: seeded.runId }));
          expect(response.statusCode).toBe(200);
          const patched = tarEntry(response.body, seeded.tarPath);
          expect(patched).not.toBeNull();
          expect(patched!.equals(seeded.originalBytes)).toBe(false);
          if (seeded.targetTextIsRaw) {
            for (const target of seeded.targets) {
              expect(patched!.includes(Buffer.from(target, "utf8")), seeded.tarPath).toBe(true);
              expect(seeded.originalBytes.includes(Buffer.from(target, "utf8"))).toBe(false);
            }
          }
        }
      });
    } finally {
      if (previousFieldCipherKey === undefined) {
        delete process.env.ITOTORI_FIELD_CIPHER_KEY;
      } else {
        process.env.ITOTORI_FIELD_CIPHER_KEY = previousFieldCipherKey;
      }
      await database.close();
      realLive.dispose();
      rpgMaker.dispose();
    }
  }, 600_000);
});
async function seedFinalizedRun(input: {
  database: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  fixture: SourceFixture;
  fixtureId: string;
  expectedEngineId: "reallive" | "rpg-maker";
}): Promise<SeededRun> {
  const materialized = materializePatchbackProduceInput({
    dataRoot: input.fixture.dataRoot,
    gameId: `dashboard-${input.fixtureId}`,
    gameVersion: "1.0.0",
    sourceProfileId: `dashboard-${input.fixtureId}`,
    sourceLocale: "ja-JP",
  });
  expect(materialized.engineId).toBe(input.expectedEngineId);
  expect(materialized.sourceRoot).toBe(input.fixture.expectedSourceRoot);

  const snapshot = buildFactSnapshot(materialized.structure, materialized.bridge);
  const scopedFacts = snapshot.orderedUnits.filter((fact) => fact.linkKind === "line");
  expect(scopedFacts.length).toBeGreaterThan(0);

  const runId = sha256(`dashboard-engine-detection-run:${input.fixtureId}`);
  const contextSnapshotId = sha256(`dashboard-engine-detection-context:${input.fixtureId}`);
  const memoKey = sha256(`dashboard-engine-detection-memo:${input.fixtureId}`);
  const cipher = createFieldMemoCipher(process.env);
  const targets = scopedFacts.map((fact, index) =>
    targetFor(materialized.bridge, fact.bridgeUnitId, input.fixtureId, index),
  );
  const ids = databaseIds(input.fixtureId);

  await input.database.pool.query("begin");
  try {
    await input.database.pool.query(
      "insert into itotori_workspaces (workspace_id, name) values ($1, $2)",
      [ids.workspaceId, `Dashboard detection ${input.fixtureId}`],
    );
    await input.database.pool.query(
      `
        insert into itotori_projects (
          project_id, workspace_id, project_key, name, source_locale, status,
          game_id, game_version, source_profile_id
        ) values ($1, $2, $3, $4, 'ja-JP', 'active', $5, '1.0.0', $6)
      `,
      [
        ids.projectId,
        ids.workspaceId,
        `dashboard-${input.fixtureId}`,
        `Dashboard detection ${input.fixtureId}`,
        `dashboard-${input.fixtureId}`,
        `dashboard-${input.fixtureId}`,
      ],
    );
    await input.database.pool.query(
      `
        insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
        values ($1, $2, 'content_hash', $3)
      `,
      [ids.revisionId, ids.projectId, materialized.bridge.sourceBundleHash],
    );
    await input.database.pool.query(
      `
        insert into itotori_source_bundles (
          source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
          schema_version, source_bundle_hash, source_locale, extractor_name,
          extractor_version, unit_count, asset_count
        ) values ($1, $2, $3, $4, $5, $6, 'ja-JP', 'kaifuu', 'dashboard', $7, 0)
      `,
      [
        ids.bundleId,
        ids.projectId,
        ids.revisionId,
        materialized.bridge.bridgeId,
        materialized.bridge.schemaVersion,
        materialized.bridge.sourceBundleHash,
        materialized.bridge.units.length,
      ],
    );
    await input.database.pool.query(
      `
        insert into itotori_locale_branches (
          locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
        ) values ($1, $2, $3, 'en-US', $4, 'active')
      `,
      [ids.localeBranchId, ids.projectId, ids.bundleId, `Dashboard detection ${input.fixtureId}`],
    );
    await input.database.pool.query(
      `
        insert into itotori_localization_pass_run_configs (
          project_id, locale_branch_id, config_path, data_root, pair_policy_path,
          model_id, provider_id, run_dir
        ) values ($1, $2, '/dev/null', $3, '/dev/null', 'dashboard', 'dashboard', '/tmp')
      `,
      [ids.projectId, ids.localeBranchId, input.fixture.dataRoot],
    );
    await input.database.pool.query(
      `
        insert into itotori_translation_scope_settings (locale_branch_id, project_id, scope)
        values ($1, $2, 'dialogue-only')
      `,
      [ids.localeBranchId, ids.projectId],
    );
    await input.database.pool.query(
      `
        insert into itotori_llm_context_snapshots (
          snapshot_id, schema_version, snapshot_content_hash, snapshot_identity, created_at
        ) values ($1, 'itotori.context-snapshot.v1', $1, '{}'::jsonb, now())
      `,
      [contextSnapshotId],
    );
    await input.database.pool.query(
      `
        insert into itotori_llm_localization_snapshots (
          snapshot_id, schema_version, snapshot_content_hash, context_snapshot_id,
          snapshot_identity, created_at
        ) values (
          $1, 'itotori.localization-snapshot.v1', $1, $2,
          jsonb_build_object('targetLanguage', 'en-US', 'localeBranchId', $3::text), now()
        )
      `,
      [runId, contextSnapshotId, ids.localeBranchId],
    );
    await insertMemo(input.database, cipher, memoKey, input.fixtureId);

    for (const [index, fact] of scopedFacts.entries()) {
      const output = acceptedOutput({
        factId: fact.factId,
        sourceHash: fact.sourceHash,
        target: targets[index]!,
        localizationSnapshotId: runId,
        memoKey,
      });
      await insertAcceptedOutput(input.database, cipher, output, runId);
    }
    await input.database.pool.query("commit");
  } catch (error: unknown) {
    await input.database.pool.query("rollback");
    throw error;
  }
  return {
    runId,
    originalBytes: readFileSync(input.fixture.originalBytesPath),
    tarPath: input.fixture.tarPath,
    targets,
    targetTextIsRaw: input.fixture.targetTextIsRaw,
  };
}
function databaseIds(fixtureId: string) {
  return {
    workspaceId: `workspace-dashboard-${fixtureId}`,
    projectId: `project-dashboard-${fixtureId}`,
    revisionId: `revision-dashboard-${fixtureId}`,
    bundleId: `bundle-dashboard-${fixtureId}`,
    localeBranchId: `branch-dashboard-${fixtureId}`,
  };
}
async function insertMemo(
  database: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: ReturnType<typeof createFieldMemoCipher>,
  memoKey: `sha256:${string}`,
  fixtureId: string,
): Promise<void> {
  const text = `dashboard engine detection memo ${fixtureId}`;
  const request = await cipher.seal(text);
  const response = await cipher.seal(text);
  const outcome = await cipher.seal(text);
  const contentHash = sha256(text);
  await database.pool.query(
    `
      insert into itotori_llm_call_memos (
        memo_key, semantic_hash, schema_version,
        request_ciphertext, request_key_ref, request_content_hash,
        response_ciphertext, response_key_ref, response_content_hash,
        outcome_ciphertext, outcome_key_ref, outcome_content_hash,
        outcome_kind, verification_status, requested_model, provider_policy,
        served_pair_status, billing_state, completed_at, retention_deadline
      ) values (
        $1, $2, 'itotori.llm-call-memo.v1',
        $3, $4, $5,
        $6, $7, $5,
        $8, $9, $5,
        'terminal', 'explicit-unknown', 'fixture-model', '{}'::jsonb,
        'unknown', 'billing_unknown', now(), now() + interval '30 days'
      )
    `,
    [
      memoKey,
      sha256(`dashboard-engine-detection-semantic:${fixtureId}`),
      Buffer.from(request.ciphertext),
      request.keyRef,
      contentHash,
      Buffer.from(response.ciphertext),
      response.keyRef,
      Buffer.from(outcome.ciphertext),
      outcome.keyRef,
    ],
  );
}
function acceptedOutput(input: {
  factId: string;
  sourceHash: `sha256:${string}`;
  target: string;
  localizationSnapshotId: `sha256:${string}`;
  memoKey: `sha256:${string}`;
}): AcceptedUnitOutput {
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `output:${input.factId}`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [input.memoKey],
    evidenceIds: [input.factId],
    acceptedAt: "2026-08-03T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "narrowed:dashboard-engine-detection",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId: input.factId,
    localizationSnapshotId: input.localizationSnapshotId,
    stage: "final",
    sourceHash: input.sourceHash,
    value: {
      targetSkeleton: input.target,
      targetHash: sha256(input.target),
      translationObjectId: `translation:${input.factId}`,
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:dashboard-engine-detection",
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:dashboard"] },
      gateReceipts: [
        {
          gate: "protected-spans",
          evidenceHash: sha256("dashboard-engine-detection-fixture"),
          status: "PASS",
        },
      ],
      reviewVerdictIds: [],
    },
  };
}
async function insertAcceptedOutput(
  database: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: ReturnType<typeof createFieldMemoCipher>,
  output: AcceptedUnitOutput,
  runId: `sha256:${string}`,
): Promise<void> {
  const outputJson = JSON.stringify(output);
  const sealed = await cipher.seal(outputJson);
  const outputHash = sha256(outputJson);
  await database.pool.query(
    `
      insert into itotori_llm_accepted_outputs (
        output_id, semantic_key, schema_version, output_version,
        parent_output_ids, memo_keys, snapshot_kind, snapshot_id,
        subject_type, subject_id, stage, source_hash, output_ciphertext,
        output_key_ref, output_content_hash, accepted_at, retention_deadline
      ) values (
        $1, $2, $3, 1, '{}', $4::text[], 'localization', $5,
        'unit', $6, 'final', $7, $8, $9, $10, now(), now() + interval '365 days'
      )
    `,
    [
      output.outputId,
      sha256(`semantic:${output.outputId}`),
      output.schemaVersion,
      output.memoKeys,
      runId,
      output.subjectId,
      output.sourceHash,
      Buffer.from(sealed.ciphertext),
      sealed.keyRef,
      outputHash,
    ],
  );
  await database.pool.query(
    `
      insert into itotori_llm_cas_heads (
        head_namespace, snapshot_id, subject_type, subject_id, head_stage,
        head_id, head_version, head_content_hash, updated_at
      ) values ('accepted-output', $1, 'unit', $2, 'final', $3, 1, $4, now())
    `,
    [runId, output.subjectId, output.outputId, outputHash],
  );
}

function targetFor(
  bridge: BridgeBundleV02,
  bridgeUnitId: string,
  fixtureId: string,
  index: number,
): string {
  const unit = bridge.units.find((candidate) => candidate.bridgeUnitId === bridgeUnitId);
  if (unit === undefined) throw new Error(`fixture bridge is missing '${bridgeUnitId}'`);
  const protectedText = unit.spans
    .filter((span) => span.outOfBand !== true)
    .map((span) => span.raw)
    .join("");
  return `Dashboard-${fixtureId}-${String(index)}${protectedText}`;
}

function stageRpgMakerFixture(): SourceFixture {
  const root = mkdtempSync(join(tmpdir(), "itotori-dashboard-rpg-maker-"));
  const sourceRoot = join(root, "mounted", "title", "www");
  const dataRoot = join(root, "mounted");
  const dataDir = join(sourceRoot, "data");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "System.json"),
      '{"gameTitle":"Dashboard fixture","currencyUnit":"G","hasEncryptedImages":true,"terms":{"basic":["Level"],"params":["Max HP"],"commands":[null,"Fight"],"messages":{"actorDamage":"%1 hit"}},"equipTypes":["","Weapon"],"elements":["","Fire"]}',
    );
    writeFileSync(
      join(dataDir, "Map001.json"),
      '{"displayName":"Route","events":[null,{"id":1,"pages":[{"list":[{"code":101,"indent":0,"parameters":["Face",0,0,2,"Guide"]},{"code":401,"indent":0,"parameters":["Dashboard source line"]},{"code":0,"indent":0,"parameters":[]}]}]}]}',
    );
    const originalBytesPath = join(dataDir, "Map001.json");
    if (!existsSync(originalBytesPath)) throw new Error("RPG Maker fixture did not stage Map001");
    return {
      dataRoot,
      expectedSourceRoot: sourceRoot,
      originalBytesPath,
      tarPath: "Map001.json",
      targetTextIsRaw: true,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function requestProduce(origin: string, body: string): Promise<RawHttpResponse> {
  const url = new URL(origin);
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: "POST",
        path: "/api/patchback/produce",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolveResponse({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", rejectResponse);
    request.end(body);
  });
}

async function withServer(
  serviceFactory: ItotoriServiceFactory,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createItotoriServer({ serviceFactory });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("dashboard patchback proof server has no TCP address");
    }
    await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    }
  }
}

function tarEntry(bytes: Buffer, wantedPath: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const nameField = bytes.subarray(offset, offset + 100);
    const nul = nameField.indexOf(0);
    const name = nameField.subarray(0, nul < 0 ? 100 : nul).toString("utf8");
    if (name.length === 0) return null;
    const sizeField = bytes.subarray(offset + 124, offset + 136).toString("ascii");
    const size = Number.parseInt(sizeField.trim(), 8) || 0;
    const contentStart = offset + 512;
    if (name === wantedPath) return bytes.subarray(contentStart, contentStart + size);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return null;
}
