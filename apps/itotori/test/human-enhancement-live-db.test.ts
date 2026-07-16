import { createHash } from "node:crypto";
import {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
  LlmHumanInputConflictError,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { persistWikiObject } from "../src/wiki/object-persistence.js";
import {
  HumanEnhancementService,
  type DecodedFact,
  type EnhancementProposal,
  type EnhancementRequest,
  type EnhancementRunner,
} from "../src/wiki/human-enhancement/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { wikiObjectExample } from "./contract-fixtures-core.js";
import { TestMemoCipher } from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

const CREATED_AT = "2026-07-15T12:00:00.000Z";
const H1 = `sha256:${"1".repeat(64)}`;
const OBJECT_ID = wikiObjectExample.objectId;
const WIKI_KIND = "source-object" as const;

/** A recorded proposal runner. It records how many times it ran and always
 * proposes DIFFERENT values than the human wrote, so preservation is a real
 * assertion rather than a coincidence. Offline: no live inference. */
function recordingRunner(spy: {
  count: number;
  last: EnhancementRequest | null;
}): EnhancementRunner {
  return async (request: EnhancementRequest): Promise<EnhancementProposal> => {
    spy.count += 1;
    spy.last = request;
    const proposalObject = structuredClone(request.humanAppliedJson) as Record<string, unknown>;
    const body = proposalObject.body as Record<string, unknown>;
    // A human-touched field: the model tries to overwrite it (must be ignored).
    body.registerPolicy = "MODEL-OVERWRITE";
    // A body field the general feedback implicates: the model may improve it.
    body.honorificPolicy = "Model-enhanced honorific guidance.";
    // An unaffected field outside the body: the model must not be able to touch it.
    proposalObject.subject = { kind: "game", id: "project:HACKED" };
    return { objectJson: proposalObject as never, authorMemoKey: H1 };
  };
}

postgresDescribe("RB-033 non-blocking human edit + bounded feedback enhancement", () => {
  it("PROOF (non-blocking): edit and feedback append an immutable HumanInput and return WITHOUT inference", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, humanInputs } = await setup(context, cipher);
      const spy = { count: 0, last: null as EnhancementRequest | null };
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);

      const editReceipt = await service.appendEdit(session, editInput(), CREATED_AT);
      const feedbackReceipt = await service.appendFeedback(session, feedbackInput(), CREATED_AT);

      // NON-BLOCKING: no enhancement ran during either append.
      expect(spy.count).toBe(0);

      // Both durable receipts advanced the head immediately (v1 -> v2 -> v3).
      expect(editReceipt.head.version).toBe(2);
      expect(feedbackReceipt.head.version).toBe(3);

      // The immutable HumanInputs are durable and encrypted at rest.
      const records = await humanInputs.list(`${WIKI_KIND}:${OBJECT_ID}`);
      expect(records.map((record) => record.inputKind)).toEqual(["edit", "feedback"]);
      const rows = await context.pool.query<{
        human_input_ciphertext: Uint8Array | null;
        human_input_content_hash: string;
      }>(
        "select human_input_ciphertext, human_input_content_hash from itotori_llm_human_inputs order by created_at, input_id",
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.human_input_ciphertext).not.toBeNull();
        expect(row.human_input_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }

      // The human-authored versions are recorded as human edits.
      const versions = await context.pool.query<{ provenance_edited_by: string }>(
        "select provenance_edited_by from itotori_llm_wiki_versions where object_version in (2, 3) order by object_version",
      );
      expect(versions.rows.map((row) => row.provenance_edited_by)).toEqual(["human", "human"]);

      // The runner only fires at the intentional apply boundary — exactly once.
      const enhancementRunner = recordingRunner(spy);
      const applyReceipt = await service.apply(session, {
        runner: enhancementRunner,
        decodedFacts: [],
        createdAt: CREATED_AT,
      });
      expect(spy.count).toBe(1);
      expect(applyReceipt.coalescedInputCount).toBe(2);
      expect(applyReceipt.head.version).toBe(4);
      // The enhancement was launched from the pre-session base plus the delta.
      expect(spy.last?.priorObjectJson).toMatchObject({ version: 1 });
      expect(spy.last?.delta.inputs).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("PROOF (human text preserved + unaffected fields preserved + non-provisional): the enhancement keeps exact human text when no decoded fact conflicts", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, wiki } = await setup(context, cipher);
      const spy = { count: 0, last: null as EnhancementRequest | null };
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);
      await service.appendEdit(session, editInput(), CREATED_AT);
      await service.appendFeedback(session, feedbackInput(), CREATED_AT);

      const applyReceipt = await service.apply(session, {
        runner: recordingRunner(spy),
        decodedFacts: [],
        createdAt: CREATED_AT,
      });

      const enhanced = await readHeadObject(wiki);
      expect(applyReceipt.head.version).toBe(4);
      const body = enhanced.body as Record<string, unknown>;

      // EXACT human text is preserved — the model's overwrite is discarded.
      expect(body.registerPolicy).toBe("Use a warm, direct register.");
      // A body field the general feedback implicates IS enhanced by the model.
      expect(body.honorificPolicy).toBe("Model-enhanced honorific guidance.");
      // An unaffected field outside the body is preserved verbatim.
      expect(enhanced.subject).toEqual({ kind: "game", id: "project:1" });
      // The human-touched version is marked NON-PROVISIONAL by the enhancement.
      expect(enhanced.provisional).toBe(false);
      const provenance = enhanced.provenance as Record<string, unknown>;
      expect(provenance.editedBy).toBe("enhancement");
      expect(provenance.authorMemoKey).toBe(H1);
      expect(applyReceipt.resolvedConflictCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("PROOF (decoded fact conflict): the enhancement overrides human text that contradicts a decoded fact", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, wiki } = await setup(context, cipher);
      const spy = { count: 0, last: null as EnhancementRequest | null };
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);
      // The human changes the decoded name order to an incorrect value.
      await service.appendEdit(session, nameOrderEditInput(), CREATED_AT);

      // A byte-derived decoded fact asserts the true name order.
      const decodedFacts: DecodedFact[] = [
        { fieldPath: ["body", "nameOrder"], value: "source-order" },
      ];
      const applyReceipt = await service.apply(session, {
        runner: recordingRunner(spy),
        decodedFacts,
        createdAt: CREATED_AT,
      });

      const enhanced = await readHeadObject(wiki);
      const body = enhanced.body as Record<string, unknown>;
      // The decoded fact wins: human "given-first" is corrected to "source-order".
      expect(body.nameOrder).toBe("source-order");
      expect(applyReceipt.resolvedConflictCount).toBe(1);
      expect(enhanced.provisional).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("PROOF (immutable): re-appending the same HumanInput id with different content is a loud conflict", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { humanInputs } = await setup(context, cipher);
      const subjectRef = `${WIKI_KIND}:${OBJECT_ID}`;
      await humanInputs.append({
        inputId: "human:edit:1",
        inputKind: "edit",
        subjectRef,
        inputJson: JSON.stringify({ kind: "edit", inputId: "human:edit:1" }),
        createdAt: CREATED_AT,
      });
      // Same id, different content — an immutable record is never overwritten.
      await expect(
        humanInputs.append({
          inputId: "human:edit:1",
          inputKind: "edit",
          subjectRef,
          inputJson: JSON.stringify({ kind: "edit", inputId: "human:edit:1", tampered: true }),
          createdAt: CREATED_AT,
        }),
      ).rejects.toBeInstanceOf(LlmHumanInputConflictError);
    } finally {
      await context.close();
    }
  });
});

function editInput() {
  return {
    kind: "edit",
    inputId: "human:edit:1",
    operations: [
      {
        kind: "replace-text",
        fieldPath: ["body", "registerPolicy"],
        before: "Use a direct register.",
        after: "Use a warm, direct register.",
      },
    ],
    note: "Warmer tone requested by the play tester.",
  };
}

function nameOrderEditInput() {
  return {
    kind: "edit",
    inputId: "human:edit:name",
    operations: [
      {
        kind: "replace-text",
        fieldPath: ["body", "nameOrder"],
        before: "source-order",
        after: "given-first",
      },
    ],
  };
}

function feedbackInput() {
  return {
    kind: "feedback",
    inputId: "human:fb:1",
    text: "Make the honorific guidance warmer and more explicit.",
  };
}

async function setup(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
): Promise<{
  service: HumanEnhancementService;
  wiki: ItotoriLlmWikiRepository;
  humanInputs: ItotoriLlmHumanInputRepository;
}> {
  const contextId = await putContextSnapshot(context);
  const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
  const humanInputs = new ItotoriLlmHumanInputRepository(context.pool, cipher);
  const base = {
    ...wikiObjectExample,
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  };
  await persistWikiObject(wiki, base, { expectedHead: null, createdAt: CREATED_AT });
  const service = new HumanEnhancementService({ humanInputs, wiki });
  return { service, wiki, humanInputs };
}

/** Read the CURRENT head object through the repository projection (the wiki
 * body is encrypted at rest, so a raw row read cannot recover it). After an
 * apply, the head is exactly the enhanced version. */
async function readHeadObject(wiki: ItotoriLlmWikiRepository): Promise<Record<string, unknown>> {
  const json = await wiki.readProjectableObject({ wikiKind: WIKI_KIND, objectId: OBJECT_ID });
  if (json === null) throw new Error("wiki object head is not projectable");
  return JSON.parse(json) as Record<string, unknown>;
}

async function putContextSnapshot(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<string> {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const snapshot = await repository.putContext({
    sourceLanguage: "ja",
    decode: revision("decode:1"),
    sourceUnits: [{ unitId: "unit:1", sourceHash: hashOf("unit:1") }],
    facts: [{ factId: "scene:1", playOrderIndex: 0, routeScope: { kind: "global" } }],
    structure: revision("structure:1"),
    routeGraph: revision("route-graph:1"),
    glossary: revision("glossary:1"),
    style: revision("style:1"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("human-corrections:1"),
    externalSources: null,
    contextScope: "whole-game",
  });
  return snapshot.snapshotId;
}

function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
