// Read the verified final accepted-target heads that Q2/Q4 may ground against.
//
// This is intentionally separate from the metadata-only CAS adapter. Review
// prompts need decrypted target text, so every read is permission-gated, hash
// checked, and parsed at this composition boundary before a role can see it.

import { createHash } from "node:crypto";

import {
  ItotoriLlmWikiRepository,
  type LlmContentReadAuthorizer,
  type LlmMemoCipher,
} from "@itotori/db";

import { AcceptedOutputSchema } from "../../contracts/index.js";

/** The narrow, verified target-history shape a review binding consumes. */
export interface AcceptedTargetRecord {
  readonly outputId: string;
  readonly unitId: string;
  readonly sourceHash: `sha256:${string}`;
  readonly targetSkeleton: string;
}

/** Read only active, verified final unit heads for one localization snapshot. */
export interface AcceptedTargetHistoryReader {
  listFinalUnits(input: {
    readonly localizationSnapshotId: `sha256:${string}`;
  }): Promise<readonly AcceptedTargetRecord[]>;
}

type FinalAcceptedOutputRow = {
  readonly output_id: string;
  readonly subject_id: string;
  readonly source_hash: string;
  readonly output_ciphertext: Uint8Array;
  readonly output_key_ref: string;
  readonly output_content_hash: string;
};

/** Create the production accepted-target history reader. It mirrors the final
 * patchback loader's active-head and memo-verification predicates, then limits
 * the decrypted result to just the fields Q2/Q4 are allowed to read. */
export function createAcceptedTargetHistoryReader(input: {
  readonly pool: ConstructorParameters<typeof ItotoriLlmWikiRepository>[0];
  readonly cipher: LlmMemoCipher;
  readonly contentAccess: LlmContentReadAuthorizer;
}): AcceptedTargetHistoryReader {
  return {
    async listFinalUnits({ localizationSnapshotId }): Promise<readonly AcceptedTargetRecord[]> {
      const result = await input.pool.query<FinalAcceptedOutputRow>(
        `
          select
            output.output_id,
            head.subject_id,
            output.source_hash,
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
      return await Promise.all(
        result.rows.map(async (row) => {
          await input.contentAccess.requireContentRead({
            contentRef: row.output_id,
            purpose: "dispatch-input",
          });
          const plaintext = await input.cipher.open(row.output_ciphertext, row.output_key_ref);
          if (sha256(plaintext) !== row.output_content_hash) {
            throw new AcceptedTargetHistoryError(
              `final accepted output content hash mismatch for ${row.subject_id}`,
            );
          }
          return parseFinalUnit(row, plaintext, localizationSnapshotId);
        }),
      );
    },
  };
}

/** A history payload must remain a real, current, schema-valid accepted output. */
export class AcceptedTargetHistoryError extends Error {
  constructor(detail: string) {
    super(`accepted target history refused: ${detail}`);
    this.name = "AcceptedTargetHistoryError";
  }
}

function parseFinalUnit(
  row: FinalAcceptedOutputRow,
  plaintext: string,
  localizationSnapshotId: `sha256:${string}`,
): AcceptedTargetRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new AcceptedTargetHistoryError(`final accepted output is not JSON for ${row.subject_id}`);
  }
  const parsed = AcceptedOutputSchema.safeParse(raw);
  if (!parsed.success || parsed.data.subjectType !== "unit" || parsed.data.stage !== "final") {
    throw new AcceptedTargetHistoryError(
      `final accepted output is malformed for ${row.subject_id}`,
    );
  }
  const output = parsed.data;
  if (
    output.outputId !== row.output_id ||
    output.subjectId !== row.subject_id ||
    output.localizationSnapshotId !== localizationSnapshotId ||
    output.sourceHash !== row.source_hash
  ) {
    throw new AcceptedTargetHistoryError(
      `final accepted output identity mismatch for ${row.subject_id}`,
    );
  }
  if (sha256(output.value.targetSkeleton) !== output.value.targetHash) {
    throw new AcceptedTargetHistoryError(
      `final accepted target hash mismatch for ${row.subject_id}`,
    );
  }
  return {
    outputId: output.outputId,
    unitId: output.subjectId,
    sourceHash: requireSha256(
      output.sourceHash,
      `final accepted output source hash for ${row.subject_id}`,
    ),
    targetSkeleton: output.value.targetSkeleton,
  };
}

function requireSha256(value: string, label: string): `sha256:${string}` {
  if (!isSha256(value)) {
    throw new AcceptedTargetHistoryError(`${label} is not a SHA-256 hash`);
  }
  return value;
}

function isSha256(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
