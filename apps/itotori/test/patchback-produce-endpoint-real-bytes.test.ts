// The production composition proof for POST /api/patchback/produce.
//
// Unlike patchback-produce-build.test.ts, this creates the finalized
// accepted-output CAS state in a real Postgres schema, asks
// withDatabaseItotoriServices for the installed port, and reaches it through
// the HTTP server. The only byte writer is the normal kaifuu patch seam.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import { createFieldMemoCipher } from "../src/composition/live/field-cipher.js";
import { runKaifuuExtract } from "../src/extract/kaifuu-extract-seam.js";
import { buildFactSnapshot } from "../src/prepass/index.js";
import { createItotoriServer } from "../src/server.js";
import {
  withDatabaseItotoriServices,
  type ItotoriServiceFactory,
} from "../src/services/database-services.js";
import { runUtsushiStructureExport } from "../src/structure-export/utsushi-structure-seam.js";
import type { NarrativeStructure } from "../src/structure/types.js";
import type { AcceptedUnitOutput } from "../src/patchback/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const realGameRoot = process.env.ITOTORI_REAL_GAME_ROOT;
const canRun = Boolean(process.env.DATABASE_URL && realGameRoot && existsSync(realGameRoot));

type RawHttpResponse = {
  statusCode: number;
  body: Buffer;
};

function findRealLiveRoot(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      existsSync(join(current, "REALLIVEDATA", "Seen.txt")) &&
      existsSync(join(current, "REALLIVEDATA", "Gameexe.ini"))
    ) {
      return current;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "REALLIVEDATA") continue;
      const child = join(current, entry);
      try {
        if (statSync(child).isDirectory()) pending.push(child);
      } catch {
        // Ignore unreadable retail-directory children.
      }
    }
  }
  return null;
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
    const port = (server.address() as AddressInfo).port;
    await run("http://127.0.0.1:" + port);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    }
  }
}

function sha256(value: string): `sha256:${string}` {
  return ("sha256:" + createHash("sha256").update(value).digest("hex")) as `sha256:${string}`;
}

function targetFor(bridge: BridgeBundleV02, bridgeUnitId: string, index: number): string {
  const unit = bridge.units.find((candidate) => candidate.bridgeUnitId === bridgeUnitId);
  const protectedSpans = (unit?.spans ?? [])
    .filter((span) => span.outOfBand !== true)
    .map((span) => span.raw);
  return "翻訳" + fullWidthDigits(index) + protectedSpans.join("");
}

function fullWidthDigits(value: number): string {
  return String(value)
    .split("")
    .map((digit) => String.fromCharCode(0xff10 + Number(digit)))
    .join("");
}

function acceptedOutput(input: {
  factId: string;
  sourceHash: string;
  target: string;
  localizationSnapshotId: `sha256:${string}`;
  memoKey: `sha256:${string}`;
}): AcceptedUnitOutput {
  const fixtureHash = sha256("patchback-produce-endpoint-fixture");
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: "output:" + input.factId,
    version: 1,
    parentOutputIds: [],
    memoKeys: [input.memoKey],
    evidenceIds: [input.factId],
    acceptedAt: "2026-07-19T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "narrowed:patchback-produce-endpoint",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId: input.factId,
    localizationSnapshotId: input.localizationSnapshotId,
    stage: "final",
    sourceHash: input.sourceHash as `sha256:${string}`,
    value: {
      targetSkeleton: input.target,
      targetHash: sha256(input.target),
      translationObjectId: "translation:" + input.factId,
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:patchback-produce-endpoint",
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:real"] },
      gateReceipts: [{ gate: "protected-spans", evidenceHash: fixtureHash, status: "PASS" }],
      reviewVerdictIds: [],
    },
  };
}

function tarEntry(bytes: Buffer, wantedPath: string): Buffer | null {
  let offset = 0;
  const nullByte = String.fromCharCode(0);
  while (offset + 512 <= bytes.length) {
    const nameField = bytes.subarray(offset, offset + 100);
    const nul = nameField.indexOf(0);
    const name = nameField.subarray(0, nul < 0 ? 100 : nul).toString("utf8");
    if (name.length === 0) return null;
    const sizeText =
      bytes
        .subarray(offset + 124, offset + 136)
        .toString("ascii")
        .split(nullByte, 1)[0] ?? "".trim();
    const size = parseInt(sizeText, 8) || 0;
    const contentStart = offset + 512;
    if (name === wantedPath) return bytes.subarray(contentStart, contentStart + size);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

describe("POST /api/patchback/produce — finalized CAS run, real Sweetie bytes", () => {
  it.skipIf(!canRun)(
    "loads final accepted outputs and returns a real patched tar through production composition",
    async () => {
      const root = findRealLiveRoot(realGameRoot!);
      expect(root).not.toBeNull();
      const workRoot = mkdtempSync(join(tmpdir(), "itotori-patchback-endpoint-"));
      const bridgePath = join(workRoot, "bridge.json");
      const structurePath = join(workRoot, "structure.json");
      const sourceSeen = readFileSync(join(root!, "REALLIVEDATA", "Seen.txt"));
      const database = await isolatedMigratedContext();
      const previousFieldCipherKey = process.env.ITOTORI_FIELD_CIPHER_KEY;
      process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
      try {
        runKaifuuExtract({
          gameRoot: root!,
          gameId: "sweetie-hd",
          gameVersion: "real",
          sourceProfileId: "sweetie-hd",
          sourceLocale: "ja-JP",
          wholeSeen: true,
          bundleOutputPath: bridgePath,
        });
        runUtsushiStructureExport({
          gameexePath: join(root!, "REALLIVEDATA", "Gameexe.ini"),
          seenPath: join(root!, "REALLIVEDATA", "Seen.txt"),
          outputPath: structurePath,
          bridgePath,
        });
        const bridge = JSON.parse(readFileSync(bridgePath, "utf8")) as BridgeBundleV02;
        const structure = JSON.parse(readFileSync(structurePath, "utf8")) as NarrativeStructure;
        const snapshot = buildFactSnapshot(structure, bridge);
        const projectId = "project-patchback-real";
        const localeBranchId = "branch-patchback-real";
        const contextSnapshotId = sha256("patchback-produce-context");
        const localizationSnapshotId = sha256("patchback-produce-finalized-run");
        const cipher = createFieldMemoCipher(process.env);
        const memoKey = sha256("patchback-produce-memo");

        await database.pool.query(
          `
            insert into itotori_workspaces (workspace_id, name)
            values ('workspace-patchback-real', 'Patchback real bytes')
          `,
        );
        await database.pool.query(
          `
            insert into itotori_projects (
              project_id, workspace_id, project_key, name, source_locale, status,
              game_id, game_version, source_profile_id
            ) values ($1, 'workspace-patchback-real', 'patchback-real', 'Patchback real', 'ja-JP',
              'active', 'sweetie-hd', 'real', 'sweetie-hd')
          `,
          [projectId],
        );
        await database.pool.query(
          `
            insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
            values ('revision-patchback-real', $1, 'content_hash', $2)
          `,
          [projectId, bridge.sourceBundleHash],
        );
        await database.pool.query(
          `
            insert into itotori_source_bundles (
              source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
              schema_version, source_bundle_hash, source_locale, extractor_name,
              extractor_version, unit_count, asset_count
            ) values (
              'bundle-patchback-real', $1, 'revision-patchback-real', $2,
              $3, $4, 'ja-JP', 'kaifuu', 'real', $5, 0
            )
          `,
          [
            projectId,
            bridge.bridgeId,
            bridge.schemaVersion,
            bridge.sourceBundleHash,
            bridge.units.length,
          ],
        );
        await database.pool.query(
          `
            insert into itotori_locale_branches (
              locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
            ) values ($1, $2, 'bundle-patchback-real', 'en-US', 'Patchback real', 'active')
          `,
          [localeBranchId, projectId],
        );
        await database.pool.query(
          `
            insert into itotori_localization_pass_run_configs (
              project_id, locale_branch_id, config_path, data_root, pair_policy_path,
              model_id, provider_id, run_dir
            ) values ($1, $2, '/dev/null', $3, '/dev/null', 'real', 'real', '/tmp')
          `,
          [projectId, localeBranchId, realGameRoot],
        );
        await database.pool.query(
          `
            insert into itotori_translation_scope_settings (locale_branch_id, project_id, scope)
            values ($1, $2, 'dialogue-and-choices')
          `,
          [localeBranchId, projectId],
        );
        await database.pool.query(
          `
            insert into itotori_llm_context_snapshots (
              snapshot_id, schema_version, snapshot_content_hash, snapshot_identity, created_at
            ) values ($1, 'itotori.context-snapshot.v1', $1, '{}'::jsonb, now())
          `,
          [contextSnapshotId],
        );
        await database.pool.query(
          `
            insert into itotori_llm_localization_snapshots (
              snapshot_id, schema_version, snapshot_content_hash, context_snapshot_id,
              snapshot_identity, created_at
            ) values (
              $1, 'itotori.localization-snapshot.v1', $1, $2,
              jsonb_build_object('targetLanguage', 'en-US', 'localeBranchId', $3::text), now()
            )
          `,
          [localizationSnapshotId, contextSnapshotId, localeBranchId],
        );
        await database.pool.query("begin");
        const memoText = "patchback produce endpoint fixture memo";
        const memoRequest = await cipher.seal(memoText);
        const memoResponse = await cipher.seal(memoText);
        const memoOutcome = await cipher.seal(memoText);
        const memoContentHash = sha256(memoText);
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
            sha256("patchback-produce-memo-semantic"),
            Buffer.from(memoRequest.ciphertext),
            memoRequest.keyRef,
            memoContentHash,
            Buffer.from(memoResponse.ciphertext),
            memoResponse.keyRef,
            Buffer.from(memoOutcome.ciphertext),
            memoOutcome.keyRef,
          ],
        );

        for (const [index, fact] of snapshot.orderedUnits.entries()) {
          const output = acceptedOutput({
            factId: fact.factId,
            sourceHash: fact.sourceHash,
            target: targetFor(bridge, fact.bridgeUnitId, index),
            localizationSnapshotId,
            memoKey,
          });
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
              sha256("semantic:" + output.outputId),
              output.schemaVersion,
              [memoKey],
              localizationSnapshotId,
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
            [localizationSnapshotId, output.subjectId, output.outputId, outputHash],
          );
        }

        await database.pool.query("commit");

        const serviceFactory: ItotoriServiceFactory = async (callback, options) =>
          await withDatabaseItotoriServices(
            { databaseUrl: database.databaseUrl, sessionId: options?.sessionId },
            callback,
          );
        await withServer(serviceFactory, async (origin) => {
          const response = await requestProduce(
            origin,
            JSON.stringify({ runId: localizationSnapshotId }),
          );
          expect(response.statusCode).toBe(200);
          expect(response.body.byteLength).toBeGreaterThan(1024);
          const patchedSeen = tarEntry(response.body, "REALLIVEDATA/Seen.txt");
          expect(patchedSeen).not.toBeNull();
          expect(patchedSeen!.equals(sourceSeen)).toBe(false);
        });
      } finally {
        if (previousFieldCipherKey === undefined) {
          delete process.env.ITOTORI_FIELD_CIPHER_KEY;
        } else {
          process.env.ITOTORI_FIELD_CIPHER_KEY = previousFieldCipherKey;
        }
        await database.close();
        rmSync(workRoot, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
