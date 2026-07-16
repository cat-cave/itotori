import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DatabaseContext } from "../src/connection.js";
import type { LlmMemoCipher } from "../src/repositories/llm-call-memo-repository.js";
import {
  ItotoriLlmSnapshotRepository,
  namespacedFactId,
  type LlmContextSnapshotInput,
  type LlmLocalizationSnapshotInput,
} from "../src/repositories/llm-snapshot-repository.js";
import {
  ItotoriLlmWikiRepository,
  LlmWikiCasError,
  type LlmWikiHead,
  type PutLlmLocalizedRenderingInput,
  type PutLlmWikiObjectInput,
} from "../src/repositories/llm-wiki-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

class ProofCipher implements LlmMemoCipher {
  readonly #keys = new Map<string, Buffer>();
  #ordinal = 0;

  async seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }> {
    const key = randomBytes(32);
    const keyRef = `wiki-proof-key:${(this.#ordinal += 1)}`;
    this.#keys.set(keyRef, key);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), keyRef };
  }

  async open(ciphertext: Uint8Array, keyRef: string): Promise<string> {
    const key = this.#keys.get(keyRef);
    if (!key) throw new Error("proof envelope key does not exist");
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  async destroyKey(keyRef: string): Promise<void> {
    this.#keys.delete(keyRef);
  }
}

postgresDescribe("strict WikiObject and localized-rendering persistence", () => {
  it("PROOF: a source object persists the full strict shape, round-trips its body, and is target-agnostic", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const body = JSON.stringify({ beat: "PRIVATE_WIKI_SENTINEL", subtext: "quiet" });
      const head = await repository.putWikiObject(
        sourceObject(snapshots.context, { objectJson: body }),
      );

      expect(head.version).toBe(1);
      const stored = await context.pool.query(
        `select wiki_kind, snapshot_kind, object_language, subject_kind, subject_id, scope_kind,
                scope_route_ids, provisional, context_scope, run_mode, provenance_author_role,
                localization_snapshot_id, source_object_id, wiki_content_hash, wiki_ciphertext
         from itotori_llm_wiki_versions where wiki_version_id = $1`,
        [head.wikiVersionId],
      );
      const row = stored.rows[0];
      expect(row.wiki_kind).toBe("source-object");
      expect(row.snapshot_kind).toBe("context");
      expect(row.object_language).toBe("ja-JP");
      expect(row.subject_kind).toBe("scene");
      expect(row.scope_kind).toBe("route");
      expect(row.scope_route_ids).toEqual(["route:active"]);
      expect(row.provisional).toBe(false);
      expect(row.context_scope).toBe("whole-game");
      expect(row.run_mode).toBe("test-dev");
      expect(row.provenance_author_role).toBe("A3");
      // Target-agnostic: no target binding lives on a source object.
      expect(row.localization_snapshot_id).toBeNull();
      expect(row.source_object_id).toBeNull();
      // The body is encrypted at rest and never stored as plaintext.
      expect(Buffer.from(row.wiki_ciphertext).toString("utf8")).not.toContain(
        "PRIVATE_WIKI_SENTINEL",
      );
      expect(
        await repository.readProjectableObject({ wikiKind: "source-object", objectId: OBJECT_ID }),
      ).toBe(body);
    } finally {
      await context.close();
    }
  });

  it("PROOF: translation and localized rendering carry the target on a localization snapshot; a source object cannot bind to one", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      await repository.putWikiObject(sourceObject(snapshots.context));
      const translation = await repository.putWikiObject(translationObject(snapshots.localization));
      const rendering = await repository.putLocalizedRendering(
        localizedRendering(snapshots.localization),
      );

      const localizationRows = await context.pool.query(
        `select wiki_kind, object_language, localization_snapshot_id, source_object_id
         from itotori_llm_wiki_versions where snapshot_kind = 'localization'
         order by wiki_kind`,
      );
      expect(localizationRows.rows).toEqual([
        {
          wiki_kind: "localized-rendering",
          object_language: "en-US",
          localization_snapshot_id: snapshots.localization,
          source_object_id: OBJECT_ID,
        },
        {
          wiki_kind: "translation-object",
          object_language: "en-US",
          localization_snapshot_id: snapshots.localization,
          source_object_id: null,
        },
      ]);
      expect(translation.version).toBe(1);
      expect(rendering.version).toBe(1);

      // A forged source object bound to a localization snapshot is rejected at the write.
      await expect(
        rawInsert(context, {
          wiki_kind: "source-object",
          snapshot_kind: "context",
          snapshot_id: snapshots.localization,
          localization_snapshot_id: snapshots.localization,
        }),
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it("PROOF: wiki history is immutable", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const head = await repository.putWikiObject(sourceObject(snapshots.context));
      await expect(
        context.pool.query(
          "update itotori_llm_wiki_versions set object_language = $1 where wiki_version_id = $2",
          ["en-US", head.wikiVersionId],
        ),
      ).rejects.toThrow(/immutable/u);
    } finally {
      await context.close();
    }
  });

  it("PROOF: per-object CAS accept is independent and a stale expected head fails without projecting", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const first = await repository.putWikiObject(
        sourceObject(snapshots.context, { objectId: "wiki:scene:one" }),
      );
      const second = await repository.putWikiObject(
        sourceObject(snapshots.context, {
          objectId: "wiki:scene:two",
          subject: { kind: "scene", id: "scene:two" },
        }),
      );
      // Two objects each hold their own head; neither advance disturbs the other.
      expect(first.version).toBe(1);
      expect(second.version).toBe(1);
      expect(
        await repository.readHead({ wikiKind: "source-object", objectId: "wiki:scene:one" }),
      ).toEqual(first);
      expect(
        await repository.readHead({ wikiKind: "source-object", objectId: "wiki:scene:two" }),
      ).toEqual(second);

      // A supersede that cites a stale head loses and leaves nothing projecting.
      const stale: LlmWikiHead = { ...first, contentHash: hashOf("stale") };
      await expect(
        repository.putWikiObject(
          sourceObject(snapshots.context, {
            objectId: "wiki:scene:one",
            objectVersion: 2,
            supersedesVersion: 1,
            objectJson: JSON.stringify({ beat: "revised" }),
            expectedHead: stale,
          }),
        ),
      ).rejects.toBeInstanceOf(LlmWikiCasError);
      expect(
        await repository.readHead({ wikiKind: "source-object", objectId: "wiki:scene:one" }),
      ).toEqual(first);
      const orphan = await context.pool.query(
        "select 1 from itotori_llm_wiki_versions where object_id = 'wiki:scene:one' and object_version = 2",
      );
      expect(orphan.rowCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("PROOF: a superseded version never projects", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const v1 = await repository.putWikiObject(
        sourceObject(snapshots.context, { objectJson: JSON.stringify({ beat: "first" }) }),
      );
      const v2 = await repository.putWikiObject(
        sourceObject(snapshots.context, {
          objectVersion: 2,
          supersedesVersion: 1,
          objectJson: JSON.stringify({ beat: "second" }),
          expectedHead: v1,
        }),
      );
      const head = await repository.readHead({ wikiKind: "source-object", objectId: OBJECT_ID });
      expect(head).toEqual(v2);
      // v1 still exists in immutable history but is not the projecting head.
      expect(head?.wikiVersionId).not.toBe(v1.wikiVersionId);
      const projected = await repository.readProjectableObject({
        wikiKind: "source-object",
        objectId: OBJECT_ID,
      });
      expect(projected).toBe(JSON.stringify({ beat: "second" }));
    } finally {
      await context.close();
    }
  });

  it("PROOF: the version is content-addressed — identical re-put is idempotent, an unchanged new version is refused", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const body = JSON.stringify({ beat: "stable" });
      const v1 = await repository.putWikiObject(
        sourceObject(snapshots.context, { objectJson: body }),
      );
      const repeated = await repository.putWikiObject(
        sourceObject(snapshots.context, { objectJson: body }),
      );
      expect(repeated).toEqual(v1);
      // A second version with identical content cannot mint a new version.
      await expect(
        repository.putWikiObject(
          sourceObject(snapshots.context, {
            objectVersion: 2,
            supersedesVersion: 1,
            objectJson: body,
            expectedHead: v1,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it("PROOF: a forged category is rejected at the write", async () => {
    const context = await isolatedMigratedContext();
    try {
      const snapshots = await putSnapshots(context);
      // A translation object wearing a source object's category cannot be written.
      await expect(
        rawInsert(context, {
          wiki_kind: "translation-object",
          object_kind: "scene-summary",
          snapshot_kind: "localization",
          snapshot_id: snapshots.localization,
          localization_snapshot_id: snapshots.localization,
        }),
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });
});

const OBJECT_ID = "wiki:scene:current";

function sourceObject(
  contextSnapshotId: string,
  overrides: Partial<PutLlmWikiObjectInput> = {},
): PutLlmWikiObjectInput {
  return {
    wikiKind: "source-object",
    objectId: OBJECT_ID,
    objectVersion: 1,
    supersedesVersion: null,
    snapshotId: contextSnapshotId,
    localizationSnapshotId: null,
    objectKind: "scene-summary",
    language: "ja-JP",
    subject: { kind: "scene", id: "scene:current" },
    scope: { kind: "route", routeId: "route:active" },
    provisional: false,
    contextScope: "whole-game",
    runMode: "test-dev",
    editedBy: null,
    authorRole: "A3",
    objectJson: JSON.stringify({ beat: "default" }),
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedHead: null,
    ...overrides,
  };
}

function translationObject(localizationSnapshotId: string): PutLlmWikiObjectInput {
  return {
    wikiKind: "translation-object",
    objectId: "wiki:translation:batch",
    objectVersion: 1,
    supersedesVersion: null,
    snapshotId: localizationSnapshotId,
    localizationSnapshotId,
    objectKind: "translation",
    language: "en-US",
    subject: { kind: "scene", id: "scene:current" },
    scope: { kind: "route", routeId: "route:active" },
    provisional: true,
    contextScope: "whole-game",
    runMode: "test-dev",
    editedBy: "agent",
    authorRole: "P1",
    objectJson: JSON.stringify({ draft: "hello" }),
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedHead: null,
  };
}

function localizedRendering(localizationSnapshotId: string): PutLlmLocalizedRenderingInput {
  return {
    objectId: "rendering:scene:current",
    objectVersion: 1,
    supersedesVersion: null,
    snapshotId: localizationSnapshotId,
    localizationSnapshotId,
    objectKind: "scene-summary",
    language: "en-US",
    scope: { kind: "route", routeId: "route:active" },
    provisional: false,
    runMode: "test-dev",
    editedBy: "enhancement",
    sourceObjectId: OBJECT_ID,
    objectJson: JSON.stringify({ kind: "scene-summary", sections: [] }),
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedHead: null,
  };
}

async function rawInsert(
  context: DatabaseContext,
  overrides: Record<string, unknown>,
): Promise<void> {
  const columns: Record<string, unknown> = {
    wiki_version_id: hashOf(`raw:${JSON.stringify(overrides)}`),
    wiki_kind: "source-object",
    object_id: "wiki:raw",
    object_version: 1,
    snapshot_kind: "context",
    snapshot_id: overrides.snapshot_id,
    object_kind: "scene-summary",
    wiki_ciphertext: Buffer.from("x"),
    wiki_key_ref: "raw-key",
    wiki_content_hash: hashOf("raw-body"),
    created_at: "2026-01-01T00:00:00.000Z",
    retention_deadline: "2026-06-01T00:00:00.000Z",
    object_language: "ja-JP",
    subject_kind: "scene",
    subject_id: "scene:raw",
    scope_kind: "global",
    scope_route_ids: [],
    provisional: false,
    context_scope: "whole-game",
    run_mode: "test-dev",
    provenance_edited_by: null,
    provenance_author_role: null,
    localization_snapshot_id: null,
    source_object_id: null,
    ...overrides,
  };
  const keys = Object.keys(columns);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  await context.pool.query(
    `insert into itotori_llm_wiki_versions (${keys.join(", ")}) values (${placeholders})`,
    keys.map((key) => columns[key]),
  );
}

async function putSnapshots(context: DatabaseContext): Promise<{
  context: string;
  localization: string;
}> {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshot = await repository.putContext(contextInput());
  const localization = await repository.putLocalization(
    localizationInput(contextSnapshot.snapshotId),
  );
  return { context: contextSnapshot.snapshotId, localization: localization.snapshotId };
}

function contextInput(): LlmContextSnapshotInput {
  return {
    sourceLanguage: "ja-JP",
    decode: revision("decode:current"),
    sourceUnits: [{ unitId: "unit:alpha", sourceHash: hashOf("source:alpha") }],
    facts: [
      {
        factId: namespacedFactId("scene", "current"),
        playOrderIndex: 2,
        routeScope: { kind: "route", routeId: "route:active" },
      },
    ],
    structure: revision("structure:current"),
    routeGraph: revision("route-graph:current"),
    glossary: revision("glossary:current"),
    style: revision("style:current"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("corrections:current"),
    externalSources: null,
    contextScope: "whole-game",
  };
}

function localizationInput(contextSnapshotId: string): LlmLocalizationSnapshotInput {
  return {
    contextSnapshotId,
    targetLocale: "en-US",
    localeBranchId: "branch:primary",
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  };
}

function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
