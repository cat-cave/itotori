import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { createUuid7 } from "../src/repositories/event-queue-repository.js";
import { styleGuideVersionChangedPayloadSchemaVersion } from "../src/repositories/style-guide-repository.js";
import { eventOutbox, outboxEventTypeValues, outboxStatusValues } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

/**
 * ITOTORI-123: the StyleGuideVersionChanged outbox payload contract is enforced
 * at the DB persistence boundary (a CHECK constraint in migration 0054), so a
 * malformed payload cannot persist even via a RAW insert that bypasses the
 * TypeScript-level assertStyleGuideVersionChangedPayload guard. This is the
 * durable boundary: these tests insert directly into itotori_event_outbox with
 * `db.execute` — no repository helper in the path — to prove the DB itself
 * rejects an audit-incomplete StyleGuideVersionChanged payload.
 */

const localActor: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "project-test";
const LOCALE_BRANCH_ID = "locale-en-us";

function wellFormedCreatedPayload(): Record<string, unknown> {
  return {
    schemaVersion: styleGuideVersionChangedPayloadSchemaVersion,
    eventName: "StyleGuideVersionChanged",
    changeKind: "version_created",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    previousVersionId: null,
    newVersionId: "style-guide-version:new",
    sourceRevisionReference: {
      sourceRevisionId: "source-revision:new",
      revisionKind: "commit",
      value: "new-value",
    },
  };
}

async function rawInsertStyleGuideVersionChanged(
  db: ItotoriDatabase,
  payload: unknown,
): Promise<string> {
  const outboxEventId = createUuid7();
  await db.execute(sql`
    insert into ${eventOutbox} (
      outbox_event_id,
      project_id,
      locale_branch_id,
      event_type,
      status,
      idempotency_key,
      correlation_id,
      payload
    )
    values (
      ${outboxEventId},
      ${PROJECT_ID},
      ${LOCALE_BRANCH_ID},
      ${outboxEventTypeValues.styleGuideVersionChanged},
      ${outboxStatusValues.pending},
      ${`style-guide-payload-contract:${outboxEventId}`},
      ${outboxEventId},
      ${JSON.stringify(payload)}::jsonb
    )
  `);
  return outboxEventId;
}

async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは。",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  });
}

describe("StyleGuideVersionChanged outbox payload DB contract (ITOTORI-123)", () => {
  it("persists a well-formed StyleGuideVersionChanged payload via a raw insert", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);

      const createdId = await rawInsertStyleGuideVersionChanged(
        context.db,
        wellFormedCreatedPayload(),
      );

      const approvedId = await rawInsertStyleGuideVersionChanged(context.db, {
        ...wellFormedCreatedPayload(),
        changeKind: "version_approved",
        previousVersionId: "style-guide-version:prior",
        newVersionId: "style-guide-version:approved",
        approvalBoundary: {
          approverUserId: "approver",
          localeBranchId: LOCALE_BRANCH_ID,
          priorVersionId: "style-guide-version:prior",
          approvedVersionId: "style-guide-version:approved",
          sourceRevisionBoundary: {
            prior: {
              sourceRevisionId: "source-revision:prior",
              revisionKind: "commit",
              value: "prior-value",
            },
            approved: {
              sourceRevisionId: "source-revision:approved",
              revisionKind: "commit",
              value: "approved-value",
            },
          },
        },
      });

      const rows = await context.db.execute(sql`
        select outbox_event_id
        from ${eventOutbox}
        where event_type = ${outboxEventTypeValues.styleGuideVersionChanged}
        order by outbox_event_id
      `);
      const persistedIds = rows.rows.map(
        (row) => (row as { outbox_event_id: string }).outbox_event_id,
      );
      expect(persistedIds).toContain(createdId);
      expect(persistedIds).toContain(approvedId);
    } finally {
      await context.close();
    }
  });

  it.each([
    [
      "missing newVersionId",
      (() => {
        const { newVersionId, ...rest } = wellFormedCreatedPayload();
        void newVersionId;
        return rest;
      })(),
    ],
    [
      "missing previousVersionId key",
      (() => {
        const { previousVersionId, ...rest } = wellFormedCreatedPayload();
        void previousVersionId;
        return rest;
      })(),
    ],
    ["wrong schemaVersion", { ...wellFormedCreatedPayload(), schemaVersion: "itotori.bogus.v9" }],
    ["wrong eventName", { ...wellFormedCreatedPayload(), eventName: "SomethingElse" }],
    ["unknown changeKind", { ...wellFormedCreatedPayload(), changeKind: "version_deleted" }],
    ["non-string projectId", { ...wellFormedCreatedPayload(), projectId: 42 }],
    ["non-string localeBranchId", { ...wellFormedCreatedPayload(), localeBranchId: null }],
    ["non-string newVersionId", { ...wellFormedCreatedPayload(), newVersionId: 7 }],
    ["payload is not an object", ["not", "an", "object"]],
  ])(
    "rejects a malformed StyleGuideVersionChanged payload at persistence (%s)",
    async (_label, payload) => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);

        let caught: unknown;
        try {
          await rawInsertStyleGuideVersionChanged(context.db, payload);
        } catch (error) {
          caught = error;
        }
        expect(caught, "malformed payload must be rejected at persistence").toBeDefined();
        // Drizzle wraps the driver error; the pg error on `.cause` carries the
        // check-violation code (23514) and the specific constraint name, proving
        // the DB CHECK — not some incidental failure — rejected the row.
        const cause = (caught as { cause?: { code?: string; constraint?: string } }).cause;
        expect(cause?.code).toBe("23514");
        expect(cause?.constraint).toBe(
          "itotori_event_outbox_style_guide_version_changed_payload_check",
        );

        const remaining = await context.db.execute(sql`
        select count(*)::int as count
        from ${eventOutbox}
        where event_type = ${outboxEventTypeValues.styleGuideVersionChanged}
      `);
        expect((remaining.rows[0] as { count: number }).count).toBe(0);
      } finally {
        await context.close();
      }
    },
  );
});
