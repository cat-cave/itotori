import { createHash } from "node:crypto";
import {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
  LlmHumanInputConflictError,
  LlmWikiProtectedHumanVersionError,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { WIKI_OBJECT_SCHEMA_VERSION, type WikiObject } from "../src/contracts/index.js";
import { canonicalJson, sha256 } from "../src/llm/canonical-json.js";
import { persistWikiObject } from "../src/wiki/object-persistence.js";
import {
  createDispatchEnhancementRunner,
  HumanEnhancementService,
  type DecodedFact,
  type EnhancementRequest,
  type EnhancementRunner,
} from "../src/wiki/human-enhancement/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { wikiObjectExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

const CREATED_AT = "2026-07-15T12:00:00.000Z";
const OBJECT_ID = wikiObjectExample.objectId;
const WIKI_KIND = "source-object" as const;

postgresDescribe("RB-033 non-blocking human edit + bounded feedback enhancement", () => {
  it("PROOF (non-blocking + memoized): edit and feedback append immutable non-provisional versions before one real child enhancement", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, humanInputs, base } = await setup(context, cipher);
      const enhancement = memoizedEnhancementRunner(context, cipher, modelProposal(base));
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);

      const editReceipt = await service.appendEdit(session, editInput(), CREATED_AT);
      const feedbackReceipt = await service.appendFeedback(session, feedbackInput(), CREATED_AT);

      // NON-BLOCKING: the direct writes are durable before a model transport is
      // even created by apply. They advance v1 -> v2 -> v3 immediately.
      expect(enhancement.transportCalls()).toBe(0);
      expect(editReceipt.head.version).toBe(2);
      expect(feedbackReceipt.head.version).toBe(3);

      const records = await humanInputs.list(`${WIKI_KIND}:${OBJECT_ID}`);
      expect(records.map((record) => record.inputKind)).toEqual(["edit", "feedback"]);
      const humanRows = await context.pool.query<{
        human_input_ciphertext: Uint8Array | null;
        human_input_content_hash: string;
      }>(
        "select human_input_ciphertext, human_input_content_hash from itotori_llm_human_inputs order by created_at, input_id",
      );
      expect(humanRows.rows).toHaveLength(2);
      for (const row of humanRows.rows) {
        expect(row.human_input_ciphertext).not.toBeNull();
        expect(row.human_input_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }

      // Both direct human versions outrank the provisional source version now,
      // rather than waiting for the later enhancement to mark them protected.
      const versions = await context.pool.query<{
        provenance_edited_by: string;
        provisional: boolean;
      }>(
        `
          select provenance_edited_by, provisional
          from itotori_llm_wiki_versions
          where object_version in (2, 3)
          order by object_version
        `,
      );
      expect(versions.rows).toEqual([
        { provenance_edited_by: "human", provisional: false },
        { provenance_edited_by: "human", provisional: false },
      ]);

      // Concurrent/retried apply calls share exactly ONE bounded child. The
      // child runs through the real dispatch -> physical-step memo -> Postgres
      // path; the only provider input is a recorded wire response.
      const applyOptions = {
        runner: enhancement.runner,
        decodedFacts: [] as DecodedFact[],
        createdAt: CREATED_AT,
      };
      const [firstApply, repeatedApply] = await Promise.all([
        service.apply(session, applyOptions),
        service.apply(session, applyOptions),
      ]);
      expect(firstApply).toEqual(repeatedApply);
      expect(firstApply.coalescedInputCount).toBe(2);
      expect(firstApply.head.version).toBe(4);
      expect(firstApply.enhancementLaunched).toBe(true);
      expect(enhancement.transportCalls()).toBe(1);

      // The planner received the immutable pre-session object and every human
      // input as one delta; it did not get a blind whole-object rewrite basis.
      expect(enhancement.request).toMatchObject({
        priorObjectJson: { version: 1 },
        delta: { inputs: [expect.anything(), expect.anything()] },
      });

      // Replaying the same child after a crash reads the durable memo instead
      // of sending another physical request. This is the dispatch primitive's
      // real idempotent seam.
      const request = enhancement.request;
      if (request === null) throw new Error("expected the bounded child request");
      await enhancement.runner(request);
      expect(enhancement.transportCalls()).toBe(1);
      const memoCount = await context.pool.query<{ count: string }>(
        "select count(*)::text as count from itotori_llm_call_memos",
      );
      expect(Number(memoCount.rows[0]?.count ?? 0)).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("PROOF (preservation): a real child preserves exact human text and byte-identical unaffected fields", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, wiki, base } = await setup(context, cipher);
      const enhancement = memoizedEnhancementRunner(context, cipher, modelProposal(base));
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);
      await service.appendEdit(session, editInput(), CREATED_AT);
      await service.appendFeedback(session, feedbackInput(), CREATED_AT);

      const applyReceipt = await service.apply(session, {
        runner: enhancement.runner,
        decodedFacts: [],
        createdAt: CREATED_AT,
      });
      const enhanced = await readHeadObject(wiki);
      const body = enhanced.body as Record<string, unknown>;

      expect(applyReceipt.head.version).toBe(4);
      // The model attempted to overwrite this edit; exact human text wins.
      expect(body.registerPolicy).toBe("Use a warm, direct register.");
      // General feedback permits the bounded body improvement.
      expect(body.honorificPolicy).toBe("Model-enhanced honorific guidance.");
      // The proposal changed these unrelated fields, but reconciliation kept
      // their canonical bytes exactly as they were before the session.
      expect(canonicalJson(enhanced.subject)).toBe(canonicalJson(base.subject));
      expect(canonicalJson(enhanced.claims)).toBe(canonicalJson(base.claims));
      expect(canonicalJson(enhanced.scope)).toBe(canonicalJson(base.scope));
      expect(enhanced.provisional).toBe(false);
      const provenance = enhanced.provenance as Record<string, unknown>;
      expect(provenance.editedBy).toBe("enhancement");
      expect(provenance.authorMemoKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(applyReceipt.resolvedConflictCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("PROOF (fact dominance): a decoded fact overrides only conflicting human text", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, wiki, base } = await setup(context, cipher);
      const enhancement = memoizedEnhancementRunner(context, cipher, modelProposal(base));
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);
      await service.appendEdit(session, nameOrderEditInput(), CREATED_AT);

      const decodedFacts: DecodedFact[] = [
        { fieldPath: ["body", "nameOrder"], value: "source-order" },
      ];
      const applyReceipt = await service.apply(session, {
        runner: enhancement.runner,
        decodedFacts,
        createdAt: CREATED_AT,
      });

      const enhanced = await readHeadObject(wiki);
      const body = enhanced.body as Record<string, unknown>;
      expect(body.nameOrder).toBe("source-order");
      expect(applyReceipt.resolvedConflictCount).toBe(1);
      expect(enhanced.provisional).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("PROOF (immutable): re-appending a HumanInput id to another subject is a loud conflict", async () => {
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
      await expect(
        humanInputs.append({
          inputId: "human:edit:1",
          inputKind: "edit",
          subjectRef: "source-object:wiki:other",
          inputJson: JSON.stringify({ kind: "edit", inputId: "human:edit:1" }),
          createdAt: CREATED_AT,
        }),
      ).rejects.toBeInstanceOf(LlmHumanInputConflictError);
    } finally {
      await context.close();
    }
  });

  it("PROOF (protection): an automated pass cannot silently supersede a human head", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, wiki, base } = await setup(context, cipher);
      const session = await service.openSession(OBJECT_ID, WIKI_KIND);
      const humanReceipt = await service.appendEdit(session, editInput(), CREATED_AT);
      const automatedCandidate = {
        ...base,
        version: 3,
        supersedesVersion: 2,
        provisional: true,
        provenance: {
          ...base.provenance,
          editedBy: "agent" as const,
        },
      };

      await expect(
        persistWikiObject(wiki, automatedCandidate, {
          expectedHead: humanReceipt.head,
          createdAt: CREATED_AT,
        }),
      ).rejects.toBeInstanceOf(LlmWikiProtectedHumanVersionError);
      expect(await wiki.readHead({ wikiKind: WIKI_KIND, objectId: OBJECT_ID })).toMatchObject({
        version: 2,
      });
    } finally {
      await context.close();
    }
  });
});

/** The production dispatch runner wired to the real dispatch/memo store. Its
 * planner seals the exact prior-object + delta payload into the physical call
 * identity, while the recorded provider response keeps the proof offline. */
function memoizedEnhancementRunner(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
  proposal: WikiObject,
): {
  readonly runner: EnhancementRunner;
  readonly transportCalls: () => number;
  readonly request: EnhancementRequest | null;
} {
  let request: EnhancementRequest | null = null;
  const harness = dispatchHarness({
    pool: context.pool,
    cipher,
    prompt: "unused: enhancement planner replaces this payload",
    responses: [structuredProviderResponse(proposal)],
  });
  const runner = createDispatchEnhancementRunner({
    plan: (nextRequest) => {
      request = nextRequest;
      const payload = canonicalJson({
        priorObjectJson: nextRequest.priorObjectJson,
        humanDelta: nextRequest.delta,
      });
      return {
        spec: physicalCallSpec(payload, {
          output: {
            name: "wiki-object",
            schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
            schemaHash: sha256(WIKI_OBJECT_SCHEMA_VERSION),
          },
        }),
        runtime: {
          ...harness.runtime,
          readPayload: async () => payload,
        },
      };
    },
  });
  return {
    runner,
    transportCalls: harness.transportCalls,
    get request() {
      return request;
    },
  };
}

/** Valid terminal output whose changes deliberately test reconciliation: it
 * attempts to overwrite a human field and to change unrelated fields. */
function modelProposal(base: WikiObject): WikiObject {
  const proposal = structuredClone(base) as Record<string, unknown>;
  proposal.body = {
    ...(proposal.body as Record<string, unknown>),
    registerPolicy: "MODEL-OVERWRITE",
    honorificPolicy: "Model-enhanced honorific guidance.",
  };
  proposal.subject = { kind: "game", id: "project:hacked" };
  proposal.claims = [];
  return proposal as unknown as WikiObject;
}

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
  base: WikiObject;
}> {
  const contextId = await putContextSnapshot(context);
  const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
  const humanInputs = new ItotoriLlmHumanInputRepository(context.pool, cipher);
  const base = {
    ...wikiObjectExample,
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  } as WikiObject;
  await persistWikiObject(wiki, base, { expectedHead: null, createdAt: CREATED_AT });
  const service = new HumanEnhancementService({ humanInputs, wiki });
  return { service, wiki, humanInputs, base };
}

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
