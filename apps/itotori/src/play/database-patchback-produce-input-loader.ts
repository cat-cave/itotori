import { createHash } from "node:crypto";

import {
  type AuthorizationActor,
  type DatabaseContext,
  type ItotoriDatabase,
  type LlmMemoCipher,
  permissionValues,
  requirePermission,
} from "@itotori/db";

import { AcceptedOutputSchema } from "../contracts/index.js";
import type { PatchbackEngineId } from "../patchback/adapters.js";
import { materializePatchbackProduceInput } from "../patchback/produce-input-materialization.js";
import { type NativePatchbackInput, type AcceptedUnitOutput } from "../patchback/types.js";
import { buildFactSnapshot } from "../prepass/index.js";
import type {
  PatchbackProduceInputLoaderPort,
  PatchbackProduceRequest,
} from "./patchback-produce-service.js";

type FinalizedRunRow = {
  snapshot_id: string;
  project_id: string;
  locale_branch_id: string;
  target_locale: string;
  source_locale: string;
  source_bundle_hash: string;
  data_root: string;
  game_id: string;
  game_version: string;
  source_profile_id: string;
  translation_scope: string | null;
};

type FinalAcceptedOutputRow = {
  subject_id: string;
  output_ciphertext: Uint8Array;
  output_key_ref: string;
  output_content_hash: string;
};

/**
 * Resolves the durable finalization boundary of the current localization
 * pipeline. A localization snapshot is the run identity; a run is finalized
 * only when its accepted-output CAS heads are at the final stage.
 *
 * Source game bytes are intentionally not copied into Postgres. The approved
 * pass-run configuration owns the source root, and we re-materialize the
 * matching native bridge/structure from that root before invoking the normal
 * patchback producer.
 */
export class DatabasePatchbackProduceInputLoader implements PatchbackProduceInputLoaderPort {
  readonly #database: ItotoriDatabase;
  readonly #pool: DatabaseContext["pool"];
  readonly #cipher: LlmMemoCipher;

  constructor(input: {
    database: ItotoriDatabase;
    pool: DatabaseContext["pool"];
    cipher: LlmMemoCipher;
  }) {
    this.#database = input.database;
    this.#pool = input.pool;
    this.#cipher = input.cipher;
  }

  async load(
    actor: AuthorizationActor,
    request: PatchbackProduceRequest,
  ): Promise<{
    input: NativePatchbackInput;
    sourceRoot: string;
    scope: "dialogue-only" | "dialogue+choices";
    engineId: PatchbackEngineId;
    runId: string;
  } | null> {
    await requirePermission(this.#database, actor, permissionValues.draftWrite);

    const run = await this.#loadFinalizedRun(request);
    if (run === null) {
      return null;
    }

    const { bridge, engineId, sourceRoot, structure } = materializePatchbackProduceInput({
      dataRoot: run.data_root,
      gameId: run.game_id,
      gameVersion: run.game_version,
      sourceProfileId: run.source_profile_id,
      sourceLocale: run.source_locale,
    });
    if (bridge.sourceBundleHash !== run.source_bundle_hash) {
      throw new Error("patchback source bytes no longer match finalized run " + run.snapshot_id);
    }

    const snapshot = buildFactSnapshot(structure, bridge);
    const accepted = await this.#loadAcceptedOutputs(run.snapshot_id);
    const scope = nativeScopeFor(run.translation_scope);
    assertFinalizedPatchbackInput({
      snapshot,
      accepted,
      localizationSnapshotId: run.snapshot_id,
      scope,
    });

    return {
      input: {
        snapshot,
        accepted,
        rawBridge: bridge,
        workScope: {
          inScopeUnitFactIds: snapshot.orderedUnits
            .filter((fact) => isFactInPatchbackScope(fact, scope))
            .map((fact) => fact.factId),
        },
        sourceLocale: run.source_locale,
        targetLocale: run.target_locale,
      },
      sourceRoot,
      scope,
      engineId,
      runId: run.snapshot_id,
    };
  }

  async #loadFinalizedRun(request: PatchbackProduceRequest): Promise<FinalizedRunRow | null> {
    const result = await this.#pool.query<FinalizedRunRow>(
      `
        select
          snapshot.snapshot_id,
          branch.project_id,
          branch.locale_branch_id,
          snapshot.snapshot_identity ->> 'targetLanguage' as target_locale,
          bundle.source_locale,
          bundle.source_bundle_hash,
          config.data_root,
          project.game_id,
          project.game_version,
          project.source_profile_id,
          scope.scope as translation_scope
        from itotori_llm_localization_snapshots snapshot
        join itotori_locale_branches branch
          on branch.locale_branch_id = snapshot.snapshot_identity ->> 'localeBranchId'
        join itotori_projects project
          on project.project_id = branch.project_id
        join itotori_source_bundles bundle
          on bundle.source_bundle_id = branch.source_bundle_id
        join itotori_localization_pass_run_configs config
          on config.project_id = branch.project_id
          and config.locale_branch_id = branch.locale_branch_id
        left join itotori_translation_scope_settings scope
          on scope.project_id = branch.project_id
          and scope.locale_branch_id = branch.locale_branch_id
        where ($1::text is null or snapshot.snapshot_id = $1)
          and ($2::text is null or branch.project_id = $2)
          and ($3::text is null or branch.locale_branch_id = $3)
          and project.game_id is not null
          and project.game_version is not null
          and project.source_profile_id is not null
          and exists (
            select 1
            from itotori_llm_cas_heads head
            join itotori_llm_accepted_outputs output
              on output.output_id = head.head_id
            where head.head_namespace = 'accepted-output'
              and head.snapshot_id = snapshot.snapshot_id
              and head.subject_type = 'unit'
              and head.head_stage = 'final'
              and output.deletion_state = 'active'
              and not exists (
                select 1
                from unnest(output.memo_keys) required_memo(memo_key)
                left join itotori_llm_call_memos memo
                  on memo.memo_key = required_memo.memo_key
                where memo.verification_status not in ('verified', 'explicit-unknown')
                  or memo.deletion_state is distinct from 'active'
              )
          )
        order by snapshot.created_at desc
        limit 1
      `,
      [request.runId ?? null, request.projectId ?? null, request.localeBranchId ?? null],
    );
    return result.rows[0] ?? null;
  }

  async #loadAcceptedOutputs(localizationSnapshotId: string): Promise<AcceptedUnitOutput[]> {
    const result = await this.#pool.query<FinalAcceptedOutputRow>(
      `
        select
          head.subject_id,
          output.output_ciphertext,
          output.output_key_ref,
          output.output_content_hash
        from itotori_llm_cas_heads head
        join itotori_llm_accepted_outputs output
          on output.output_id = head.head_id
        where head.head_namespace = 'accepted-output'
          and head.snapshot_id = $1
          and head.subject_type = 'unit'
          and head.head_stage = 'final'
          and output.deletion_state = 'active'
          and not exists (
            select 1
            from unnest(output.memo_keys) required_memo(memo_key)
            left join itotori_llm_call_memos memo
              on memo.memo_key = required_memo.memo_key
            where memo.verification_status not in ('verified', 'explicit-unknown')
              or memo.deletion_state is distinct from 'active'
          )
        order by head.subject_id
      `,
      [localizationSnapshotId],
    );

    return Promise.all(
      result.rows.map(async (row) => {
        const plaintext = await this.#cipher.open(row.output_ciphertext, row.output_key_ref);
        const hash = "sha256:" + createHash("sha256").update(plaintext).digest("hex");
        if (hash !== row.output_content_hash) {
          throw new Error("final accepted output content hash mismatch for " + row.subject_id);
        }

        const parsed = AcceptedOutputSchema.safeParse(JSON.parse(plaintext));
        if (
          !parsed.success ||
          parsed.data.subjectType !== "unit" ||
          parsed.data.stage !== "final"
        ) {
          throw new Error("final accepted output is malformed for " + row.subject_id);
        }
        if (parsed.data.subjectId !== row.subject_id) {
          throw new Error("final accepted output subject mismatch for " + row.subject_id);
        }
        return parsed.data;
      }),
    );
  }
}

function nativeScopeFor(translationScope: string | null): "dialogue-only" | "dialogue+choices" {
  return translationScope === "dialogue-only" || translationScope === null
    ? "dialogue-only"
    : "dialogue+choices";
}

function assertFinalizedPatchbackInput(input: {
  snapshot: NativePatchbackInput["snapshot"];
  accepted: AcceptedUnitOutput[];
  localizationSnapshotId: string;
  scope: "dialogue-only" | "dialogue+choices";
}): void {
  const acceptedById = new Map(input.accepted.map((output) => [output.subjectId, output]));
  const scopedFacts = input.snapshot.orderedUnits.filter((fact) =>
    isFactInPatchbackScope(fact, input.scope),
  );

  for (const fact of scopedFacts) {
    const output = acceptedById.get(fact.factId);
    if (output === undefined) {
      throw new Error("finalized run is missing final accepted output for " + fact.factId);
    }
    if (output.localizationSnapshotId !== input.localizationSnapshotId) {
      throw new Error(
        "final accepted output belongs to another localization snapshot: " + fact.factId,
      );
    }
    if (output.sourceHash !== fact.sourceHash) {
      throw new Error("final accepted output source hash is stale for " + fact.factId);
    }
  }

  for (const output of input.accepted) {
    const fact = input.snapshot.orderedUnits.find(
      (candidate) => candidate.factId === output.subjectId,
    );
    if (fact === undefined) {
      throw new Error(
        "final accepted output is not in the current source snapshot: " + output.subjectId,
      );
    }
    if (output.localizationSnapshotId !== input.localizationSnapshotId) {
      throw new Error(
        "final accepted output belongs to another localization snapshot: " + output.subjectId,
      );
    }
    if (output.sourceHash !== fact.sourceHash) {
      throw new Error("final accepted output source hash is stale for " + output.subjectId);
    }
  }
}

function isFactInPatchbackScope(
  fact: NativePatchbackInput["snapshot"]["orderedUnits"][number],
  scope: "dialogue-only" | "dialogue+choices",
): boolean {
  return fact.linkKind === "line" || (scope === "dialogue+choices" && fact.linkKind === "choice");
}
