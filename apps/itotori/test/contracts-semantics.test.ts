import { describe, expect, it } from "vitest";
import {
  AcceptedOutputSchema,
  BackTranslateResultSchema,
  CallResultSchema,
  CallSpecSchema,
  ContextSnapshotSchema,
  ConversationEventSchema,
  DRAFT_BATCH_SCHEMA_VERSION,
  DraftBatchSchema,
  LocalizedRenderingSchema,
  PhysicalStepMemoSchema,
  ReviewVerdictSchema,
  WIKI_OBJECT_SCHEMA_VERSION,
  WikiObjectSchema,
} from "../src/contracts/index.js";
import {
  H1,
  H2,
  acceptedOutputExample,
  contextSnapshotExample,
  draftBatchExample,
  localizedRenderingExample,
  reviewVerdictExample,
  wikiObjectExample,
} from "./contract-fixtures-core.js";
import {
  callResultExample,
  callSpecExample,
  conversationEventExample,
  memoExample,
} from "./contract-fixtures-calls.js";
import { backTranslateResultExample } from "./contract-fixtures-tools.js";

const schemaRef = {
  name: "tool-input",
  schemaVersion: "itotori.tool-input.v1",
  schemaHash: H1,
} as const;

const webTool = {
  name: "web_search",
  input: schemaRef,
  output: { ...schemaRef, name: "web-search-result" },
  implementationVersion: "implementation:v1",
} as const;

describe("call and memo contracts", () => {
  it("allows web search only for the biographer role", () => {
    expect(
      CallSpecSchema.safeParse({ ...callSpecExample, roleId: "A7", tools: [webTool] }).success,
    ).toBe(true);
    expect(
      CallSpecSchema.safeParse({ ...callSpecExample, roleId: "A8", tools: [webTool] }).success,
    ).toBe(false);
  });

  it("requires the exact private provider posture", () => {
    expect(
      CallSpecSchema.safeParse({
        ...callSpecExample,
        providerPolicy: { ...callSpecExample.providerPolicy, zdr: false },
      }).success,
    ).toBe(false);
    expect(
      CallSpecSchema.safeParse({
        ...callSpecExample,
        providerPolicy: {
          ...callSpecExample.providerPolicy,
          only: ["provider:primary", "provider:unrequested"],
        },
      }).success,
    ).toBe(false);
  });

  it("represents malformed output as a typed failure without a salvage value", () => {
    const failure = {
      ...callResultExample,
      status: "failure",
      failureKind: "schema-failure",
      responseEventId: H2,
      responseEncrypted: null,
      served: null,
      generationId: null,
      verification: "quarantined",
      usage: null,
      billing: { status: "billing-unknown" },
      defects: [{ path: ["drafts", 0], code: "schema", message: "Required field missing." }],
    };
    const { value: _value, ...failureWithoutValue } = failure;
    expect(CallResultSchema.safeParse(failureWithoutValue).success).toBe(true);
    expect(CallResultSchema.safeParse(failure).success).toBe(false);
    expect(CallResultSchema.safeParse({ ...failureWithoutValue, rawJson: "{}" }).success).toBe(
      false,
    );
  });

  it("binds a physical memo value to exactly its semantic memo key", () => {
    expect(PhysicalStepMemoSchema.safeParse(memoExample).success).toBe(true);
    expect(
      PhysicalStepMemoSchema.safeParse({
        ...memoExample,
        value: { ...memoExample.value, memoKey: H2 },
      }).success,
    ).toBe(false);
  });
});

describe("snapshot and artifact boundaries", () => {
  it("pins external context when external augmentation is declared", () => {
    expect(
      ContextSnapshotSchema.safeParse({
        ...contextSnapshotExample,
        contextScope: "external-augmented",
      }).success,
    ).toBe(false);
    expect(
      ContextSnapshotSchema.safeParse({
        ...contextSnapshotExample,
        contextScope: "external-augmented",
        externalSources: { revisionId: "external:1", contentHash: H2 },
      }).success,
    ).toBe(true);
  });

  it("keeps target state out of the source context snapshot", () => {
    expect(
      ContextSnapshotSchema.safeParse({ ...contextSnapshotExample, targetLanguage: "en-US" })
        .success,
    ).toBe(false);
    expect(
      ContextSnapshotSchema.safeParse({ ...contextSnapshotExample, acceptedBibleHead: null })
        .success,
    ).toBe(false);
  });

  it("requires an event kind to match its encrypted body descriptor", () => {
    expect(ConversationEventSchema.safeParse(conversationEventExample).success).toBe(true);
    expect(
      ConversationEventSchema.safeParse({ ...conversationEventExample, kind: "defects" }).success,
    ).toBe(false);
  });

  it("stores bible renderings separately from source wiki objects", () => {
    expect(WikiObjectSchema.safeParse(wikiObjectExample).success).toBe(true);
    expect(WikiObjectSchema.safeParse({ ...wikiObjectExample, localizations: {} }).success).toBe(
      false,
    );
    expect(LocalizedRenderingSchema.safeParse(localizedRenderingExample).success).toBe(true);
    expect(
      LocalizedRenderingSchema.safeParse({
        ...localizedRenderingExample,
        sourceObjectKind: "term-ruling",
      }).success,
    ).toBe(false);
  });
});

describe("workflow output policy", () => {
  it("makes the pure-MTL basis explicit and artifact-only", () => {
    const pureMtlDraft = {
      ...draftBatchExample,
      schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
      drafts: [
        {
          ...draftBatchExample.drafts[0],
          basis: { kind: "pure-mtl-ablation", bibleRenderingIds: [] },
        },
      ],
    };
    expect(DraftBatchSchema.safeParse(pureMtlDraft).success).toBe(true);
    expect(
      AcceptedOutputSchema.safeParse({
        ...acceptedOutputExample,
        value: { ...acceptedOutputExample.value, basis: pureMtlDraft.drafts[0].basis },
      }).success,
    ).toBe(false);
    expect(
      AcceptedOutputSchema.safeParse({
        ...acceptedOutputExample,
        releaseEligibility: {
          kind: "artifact-only",
          runMode: "test-dev",
          contextScope: "narrowed:single-scene",
          reason: "pure-mtl-ablation",
        },
        value: { ...acceptedOutputExample.value, basis: pureMtlDraft.drafts[0].basis },
      }).success,
    ).toBe(true);
  });

  it("cannot encode CANNOT_ASSESS as a passing review", () => {
    expect(ReviewVerdictSchema.safeParse(reviewVerdictExample).success).toBe(true);
    expect(
      ReviewVerdictSchema.safeParse({ ...reviewVerdictExample, verdict: "CANNOT_ASSESS" }).success,
    ).toBe(false);
    expect(
      ReviewVerdictSchema.safeParse({
        ...reviewVerdictExample,
        verdict: "CANNOT_ASSESS",
        category: "insufficient-evidence",
        requestedEvidence: ["A wider source window."],
      }).success,
    ).toBe(true);
  });

  it("keeps back translation diagnostic-only and unable to emit verdicts", () => {
    expect(BackTranslateResultSchema.safeParse(backTranslateResultExample).success).toBe(true);
    expect(
      BackTranslateResultSchema.safeParse({ ...backTranslateResultExample, diagnosticOnly: false })
        .success,
    ).toBe(false);
    expect(
      BackTranslateResultSchema.safeParse({ ...backTranslateResultExample, verdict: "FAIL" })
        .success,
    ).toBe(false);
    expect(
      BackTranslateResultSchema.safeParse({ ...backTranslateResultExample, defects: [] }).success,
    ).toBe(false);
  });

  it("exposes only the canonical wiki schema version", () => {
    expect(wikiObjectExample.schemaVersion).toBe(WIKI_OBJECT_SCHEMA_VERSION);
    expect(
      WikiObjectSchema.safeParse({ ...wikiObjectExample, schemaVersion: "wiki.v0" }).success,
    ).toBe(false);
  });
});
