// A7 dispatch boundary — the model-calling role routes deepseek-v4-flash through
// the SOLE ZDR dispatch boundary, proven offline on a recorded/memo path.
//
// No network and no Postgres: an in-memory memo store plus a recorded SSE
// response stand in for the provider. The proofs show the A7 call spec is the
// certified A7 route (no provider named, ZDR policy, wiki-object terminal), that
// it offers web_search ONLY when the operator opens egress, that it actually
// reaches `dispatch()`, and that the production caller maps the returned draft.

import { createHash } from "node:crypto";

import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

import { CallSpecSchema, type WikiObject } from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import {
  assembleCharacterBio,
  buildA7CallSpec,
  buildCharacterPortrait,
  characterIndex,
  dispatchA7,
  dispatchingA7Caller,
  readCharacterEvidence,
  type A7BioDraft,
  type A7CharacterRequest,
  type A7Context,
  type A7PortraitProvider,
} from "../src/roles/a7/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { buildClaimFixture, type FixtureCharacterSpec } from "./support/claim-fixture.js";
import {
  confirmedGenerationMetadataSource,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

const A7_PROFILE: MeasuredModelProfile = {
  name: "reasoning",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the recorded-transport proof, not a billed cost
};

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const CONTEXT: A7Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
];

const portraits: A7PortraitProvider = (characterId) => ({
  status: "available",
  facts: {
    artifactUri: `https://artifacts.example/artifact-store/portrait-${characterId}.png`,
    contentHash: `sha256:${"a".repeat(64)}`,
    mediaType: "image/png",
    dimensions: { width: 256, height: 256 },
    access: { redaction: "default-redacted", permission: "project-member" },
  },
});

/** In-memory memo store — the durable memoization seam, no Postgres. */
class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();
  readonly #attempts = new Map<string, number>();

  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash)
        throw new LlmMemoConflictError(input.memoKey);
      return { ...existing, memoHit: true };
    }
    const ordinal = (this.#attempts.get(input.memoKey) ?? 0) + 1;
    if (ordinal > 3) throw new LlmRetriesExhaustedError(input.memoKey);
    this.#attempts.set(input.memoKey, ordinal);
    const execution = await input.execute({ ordinal, startedAt: new Date().toISOString() });
    if (execution.kind === "incomplete") {
      return {
        kind: "incomplete",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        attemptOrdinal: ordinal,
        failure: execution.failure,
      };
    }
    const completed = {
      kind: "completed" as const,
      memoHit: false,
      memoKey: input.memoKey,
      semanticHash: input.semanticHash,
      responseJson: execution.responseJson,
      outcomeJson: execution.outcomeJson,
      responseEventId: execution.responseEvent.eventId,
    };
    this.#memos.set(input.memoKey, completed);
    return completed;
  }
}

function runtime(responses: Response[], onFetch?: () => void): DispatchRuntime {
  return {
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    tools: [],
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: A7_PROFILE,
      admission: {
        scope: "test:roles-a7",
        confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic admission cap for the recorded-transport proof, not a billed cost
      },
      generationMetadataSource: confirmedGenerationMetadataSource(),
      snapshots: {
        decodeRevisionHash: HASH_A,
        glossaryRevisionHash: HASH_B,
        styleRevisionHash: HASH_A,
        acceptedOutputHeadHash: HASH_B,
      },
    },
    readPayload: async () => {
      throw new Error("unexpected fallback payload read");
    },
    fetcher: async () => {
      onFetch?.();
      const response = responses.shift();
      if (!response) throw new Error("unexpected extra provider request");
      return response;
    },
  };
}

function bioRequest(webEnabled = false): {
  model: ReturnType<typeof buildClaimFixture>["model"];
  request: A7CharacterRequest;
} {
  const { model } = buildClaimFixture({ characters: CHARACTERS });
  const evidence = readCharacterEvidence(model, CONTEXT, characterIndex(model)[0]!);
  return {
    model,
    request: { character: evidence, sourceLanguage: model.sourceLanguage, webEnabled },
  };
}

function recordedBio(
  model: ReturnType<typeof buildClaimFixture>["model"],
  request: A7CharacterRequest,
): WikiObject {
  const anchor = request.character.notableUnitIds[0]!;
  const draft: A7BioDraft = {
    storyRole: "物語を動かす。",
    definingTraits: ["まっすぐ"],
    notableMomentEvidenceIds: [anchor],
    claims: [{ statement: "決断を促す。", confidence: "high", evidenceIds: [anchor] }],
  };
  return assembleCharacterBio(
    model,
    CONTEXT,
    request.character,
    draft,
    buildCharacterPortrait(request.character.characterId, portraits(request.character.characterId)),
  );
}

describe("A7 dispatches through the sole ZDR boundary", () => {
  it("PROOF: the A7 call spec is the certified, no-provider-named, wiki-object route", () => {
    const { model, request } = bioRequest();
    const { spec, prompts } = buildA7CallSpec(model, CONTEXT, request);
    expect(spec.roleId).toBe("A7");
    expect(spec.purpose).toBe("analysis");
    expect(spec.modelProfile).toBe("reasoning");
    expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(spec.providerPolicy.zdr).toBe(true);
    expect(spec.output.name).toBe("wiki-object");
    // Local-only: no tools are offered at all.
    expect(spec.tools).toHaveLength(0);
    expect(spec.contextSnapshotId).toBe(model.snapshotId);
    expect(prompts[0]!.ref.contentHash).toBe(
      `sha256:${createHash("sha256").update(prompts[0]!.text).digest("hex")}`,
    );
  });

  it("PROOF: web_search is offered ONLY when the operator opens egress, and the spec still parses for A7", () => {
    const { model, request } = bioRequest(true);
    const { spec } = buildA7CallSpec(model, CONTEXT, request);
    expect(spec.tools.map((tool) => tool.name)).toEqual(["web_search"]);
    // The contract independently binds web_search to A7; the A7 spec parses.
    expect(() => CallSpecSchema.parse(spec)).not.toThrow();
  });

  it("PROOF: a recorded character-bio draft returns through dispatch()", async () => {
    const { model, request } = bioRequest();
    const { spec, prompts } = buildA7CallSpec(model, CONTEXT, request);
    let fetches = 0;
    const configured = runtime([structuredProviderResponse(recordedBio(model, request))], () => {
      fetches += 1;
    });
    const result = await dispatchA7(spec, prompts, configured);
    expect(result.status).toBe("success");
    expect(result.status === "success" ? result.value.kind : null).toBe("character-bio");
    expect(fetches).toBe(1); // it really reached the transport boundary
  });

  it("PROOF: the production caller maps the dispatched draft", async () => {
    const { model, request } = bioRequest();
    const configured = runtime([structuredProviderResponse(recordedBio(model, request))]);
    const caller = dispatchingA7Caller(model, CONTEXT, configured);
    const draft = await caller(request);
    expect(draft.storyRole).toBe("物語を動かす。");
    expect(draft.definingTraits).toContain("まっすぐ");
    expect(
      draft.claims.some((claim) =>
        claim.evidenceIds.includes(request.character.notableUnitIds[0]!),
      ),
    ).toBe(true);
  });

  it("PROOF: raw dispatch() rejects when the ZDR operator assertions are absent", async () => {
    const { model, request } = bioRequest();
    const { spec } = buildA7CallSpec(model, CONTEXT, request);
    const configured = runtime([structuredProviderResponse(recordedBio(model, request))]);
    await expect(dispatch(spec, { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
  });
});
