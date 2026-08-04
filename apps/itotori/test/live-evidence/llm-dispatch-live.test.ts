import { expect, it } from "vitest";

import { dispatch } from "../../src/llm/dispatch.js";
import { REVIEW_VERDICT_SCHEMA_VERSION } from "../../src/contracts/index.js";
import { reviewVerdictExample } from "../contract-fixtures-core.js";
import { HASH_A, HASH_B, MemoryMemoStore, callSpec } from "../llm-dispatch.support.js";
import { TEST_MODEL_PROFILE } from "../llm-step-test-support.js";

it("accepts a real structured response with an explicitly unknown served pair", async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("live dispatch proof requires OPENROUTER_API_KEY");
  }
  const prompt = `Return exactly one PASS review verdict for synthetic unit unit:1. Use schemaVersion ${REVIEW_VERDICT_SCHEMA_VERSION}, reviewId review:live:1, localizationSnapshotId ${HASH_B}, roleId Q1, rubric meaning, unitId unit:1, wiki-first basis with bibleRenderingIds [rendering:1], severity none, null span/category/repairConstraint, and evidenceIds [fact:unit:1].`;
  const spec = callSpec(prompt, {
    providerPolicy: {
      allowFallbacks: true,
      zdr: true,
      dataCollection: "deny",
      requireParameters: true,
    },
  });
  const result = await dispatch(spec, {
    env: process.env,
    tools: [],
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: TEST_MODEL_PROFILE,
      admission: {
        scope: "test:llm-dispatch-live",
        confirmedCostCapUsd: "10", // cost-audit-allow: synthetic live-test cap, not a billed model cost
      },
      snapshots: {
        decodeRevisionHash: HASH_A,
        glossaryRevisionHash: HASH_B,
        styleRevisionHash: HASH_A,
        acceptedOutputHeadHash: HASH_B,
      },
    },
    readPayload: async () => prompt,
  });

  expect(result).toMatchObject({
    status: "success",
    verification: "explicit-unknown",
    generationId: null,
    served: { status: "unknown" },
  });
}, 360_000);
