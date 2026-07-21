// A7-only web egress outside the ZDR envelope, mutation-falsifiable.
//
// Every clause below fails if its guarantee is removed. The disabled-mode proof
// intercepts the network: the web provider is backed by an injected fetch that
// THROWS if invoked, so a green run proves that in the default/disabled and
// qualifying postures NOTHING — query, content, prompt, or decode fact — crosses
// the boundary. Enabled results carry full web provenance at low confidence, and
// facts-dominate reconciliation proves a web claim can never override a same-game
// fact.

import { describe, expect, it } from "vitest";

import type { EntityRef } from "../src/contracts/index.js";
import { WebSearchResultSchema } from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { ALL_ROLES, TOOL_ROLE_ALLOWLIST } from "../src/read-tools/index.js";
import {
  EGRESS_DISABLED,
  EGRESS_TOOL_ROLE_ALLOWLIST,
  EgressDeniedError,
  WEB_SEARCH_EGRESS_ROLE,
  assertWebEgressAllowed,
  createWebSearchTool,
  reconcileWebEvidence,
  webEgressAllowed,
  type EgressPolicy,
  type RawWebHit,
  type SameGameFact,
  type WebClaim,
  type WebSearchProvider,
} from "../src/egress/index.js";

const SNAPSHOT_ID = `sha256:${"a".repeat(64)}`;
const ENABLED: EgressPolicy = { operatorEnabled: true, qualifyingRun: false };
const QUALIFYING: EgressPolicy = { operatorEnabled: true, qualifyingRun: true };

const RETRIEVED_CONTENT = "Rin is the childhood-friend heroine of the story.";
const RAW_HIT: RawWebHit = {
  url: "https://example.com/rin",
  title: "Rin — character profile",
  excerpt: "Rin is a childhood friend.",
  retrievedContent: RETRIEVED_CONTENT,
};

/** A provider backed by an injected fetch that THROWS if the network is touched.
 * Records every query it is asked to search so a disabled boundary can be proven
 * to have passed nothing outward. */
function interceptedProvider(): {
  provider: WebSearchProvider;
  fetchCalls: number;
  queries: string[];
} {
  const state = { fetchCalls: 0, queries: [] as string[] };
  const fetchTrap = async (): Promise<never> => {
    state.fetchCalls += 1;
    throw new Error("network egress attempted while the boundary was closed");
  };
  const provider: WebSearchProvider = {
    async search(query) {
      state.queries.push(query);
      // The only network-touching line. Disabled mode must never reach it.
      await fetchTrap();
      return [RAW_HIT];
    },
  };
  return {
    provider,
    get fetchCalls() {
      return state.fetchCalls;
    },
    get queries() {
      return state.queries;
    },
  };
}

/** A provider that never touches the network — for enabled-mode provenance. */
function staticProvider(hits: readonly RawWebHit[]): {
  provider: WebSearchProvider;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    provider: {
      async search() {
        state.calls += 1;
        return hits;
      },
    },
    get calls() {
      return state.calls;
    },
  };
}

const fixedNow = () => new Date("2026-07-15T12:00:00.000Z");

describe("RB-026 clause 1 — web_search is absent from every allowlist except A7", () => {
  it("grants web egress to exactly A7 across all 19 roles", () => {
    const allowed = ALL_ROLES.filter((role) => webEgressAllowed(role, ENABLED));
    expect(allowed).toEqual(["A7"]);
    expect(WEB_SEARCH_EGRESS_ROLE).toBe("A7");
    expect([...EGRESS_TOOL_ROLE_ALLOWLIST.web_search]).toEqual(["A7"]);
  });

  it("keeps web_search out of the local read-tool surface entirely", () => {
    // The local read surface never lists web_search for ANY role — it is an
    // egress tool, not a snapshot read. Union with the egress allowlist => A7 only.
    expect([...TOOL_ROLE_ALLOWLIST.web_search]).toEqual([]);
  });

  it("refuses every non-A7 role even with the operator switch on", () => {
    for (const role of ALL_ROLES) {
      if (role === "A7") continue;
      expect(() => assertWebEgressAllowed(role, ENABLED)).toThrowError(EgressDeniedError);
      try {
        assertWebEgressAllowed(role, ENABLED);
      } catch (error) {
        expect((error as EgressDeniedError).code).toBe("role-not-allowed");
      }
    }
  });
});

describe("RB-026 clause 2 — uncallable unless the operator explicitly enables egress", () => {
  it("DISABLED by default: A7's query fails closed with ZERO network egress", async () => {
    const spy = interceptedProvider();
    const tool = createWebSearchTool({
      roleId: "A7",
      policy: EGRESS_DISABLED, // operatorEnabled: false
      provider: spy.provider,
      snapshotId: SNAPSHOT_ID,
      now: fixedNow,
    });

    await expect(
      tool.execute({ query: "Rin biography", maxRows: 10, maxBytes: 1_000_000 }, undefined),
    ).rejects.toMatchObject({ name: "EgressDeniedError", code: "operator-egress-disabled" });

    // The boundary is intact: the provider was never asked, so no query reached
    // it and the network fetch trap never fired. Zero bytes left.
    expect(spy.queries).toEqual([]);
    expect(spy.fetchCalls).toBe(0);
  });

  it("A7 cannot call without the operator opt-in (bare gate)", () => {
    expect(() => assertWebEgressAllowed("A7", EGRESS_DISABLED)).toThrowError(
      /operator has not explicitly enabled/,
    );
    expect(webEgressAllowed("A7", EGRESS_DISABLED)).toBe(false);
    expect(webEgressAllowed("A7", ENABLED)).toBe(true);
  });
});

describe("RB-026 clause 3 — enabled results carry full web provenance at confidence <= medium", () => {
  it("seals url, retrieval date, content hash, web provenance, and low confidence", async () => {
    const source = staticProvider([RAW_HIT]);
    const tool = createWebSearchTool({
      roleId: "A7",
      policy: ENABLED,
      provider: source.provider,
      snapshotId: SNAPSHOT_ID,
      now: fixedNow,
    });

    const result = await tool.execute(
      { query: "Rin biography", maxRows: 10, maxBytes: 1_000_000 },
      undefined,
    );
    expect(source.calls).toBe(1);

    // The result is contract-valid (schema pins confidence to low|medium and
    // provenance to "web") and authorizes only A7.
    const parsed = WebSearchResultSchema.parse(result);
    expect(parsed.egressAuthorizedForRole).toBe("A7");
    const hit = parsed.hits[0]!;
    expect(hit.url).toBe(RAW_HIT.url);
    expect(hit.retrievedOn).toBe("2026-07-15");
    expect(hit.contentHash).toBe(sha256(RETRIEVED_CONTENT));
    expect(hit.evidenceId).toBe(`web:sha256:${sha256(RETRIEVED_CONTENT).slice("sha256:".length)}`);
    expect(hit.provenance).toBe("web");
    expect(hit.confidence).toBe("low");
    expect(["low", "medium"]).toContain(hit.confidence);
    expect(hit.corroboratingSameGameFactIds).toEqual([]);
  });

  it("the schema rejects a fabricated above-medium confidence", () => {
    expect(
      WebSearchResultSchema.safeParse({
        schemaVersion: "itotori.tool.web-search-result.v1",
        tool: "web_search",
        snapshotId: SNAPSHOT_ID,
        requestHash: `sha256:${"b".repeat(64)}`,
        resultHash: `sha256:${"c".repeat(64)}`,
        page: {
          requestCursor: null,
          returnedRows: 0,
          returnedBytes: 0,
          maxRows: 1,
          maxBytes: 1,
          kind: "complete",
          nextCursor: null,
        },
        egressAuthorizedForRole: "A7",
        hits: [
          {
            evidenceId: `web:sha256:${"d".repeat(64)}`,
            url: "https://example.com",
            retrievedOn: "2026-07-15",
            contentHash: `sha256:${"d".repeat(64)}`,
            title: "x",
            excerpt: "x",
            provenance: "web",
            confidence: "high",
            corroboratingSameGameFactIds: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("RB-026 clause 3/RB-027 — web claims can never override decode/same-game facts", () => {
  const rinSubject: EntityRef = { kind: "character", id: "nam-17" };
  const rinFact: SameGameFact = {
    factId: "decode:character:nam-17:name",
    subject: rinSubject,
    value: "Rin",
  };

  it("suppresses a web claim that contradicts a same-game fact (fact dominates)", () => {
    const claim: WebClaim = {
      evidenceId: "web:sha256:1",
      subject: rinSubject,
      assertion: "Erin",
      confidence: "medium",
    };
    const out = reconcileWebEvidence([claim], [rinFact]);
    expect(out.usable).toEqual([]);
    expect(out.suppressed).toHaveLength(1);
    expect(out.suppressed[0]).toMatchObject({
      status: "contradicted",
      dominatingFactId: "decode:character:nam-17:name",
      confidence: null,
    });
  });

  it("raises a corroborated claim to medium and cites the same-game fact", () => {
    const claim: WebClaim = {
      evidenceId: "web:sha256:2",
      subject: rinSubject,
      assertion: "  rin  ",
      confidence: "low",
    };
    const out = reconcileWebEvidence([claim], [rinFact]);
    expect(out.suppressed).toEqual([]);
    expect(out.usable[0]).toMatchObject({
      confidence: "medium",
      corroboratingSameGameFactIds: ["decode:character:nam-17:name"],
    });
  });

  it("keeps an uncorroborated claim at low, never above medium", () => {
    const claim: WebClaim = {
      evidenceId: "web:sha256:3",
      subject: { kind: "character", id: "unknown-99" },
      assertion: "wears a red scarf",
      confidence: "medium", // even a medium input stays low without corroboration
    };
    const out = reconcileWebEvidence([claim], [rinFact]);
    expect(out.usable[0]).toMatchObject({
      confidence: "low",
      corroboratingSameGameFactIds: [],
    });
    for (const entry of out.reconciliations) {
      expect([null, "low", "medium"]).toContain(entry.confidence);
    }
  });
});

describe("RB-026 clause 4 — qualifying-run posture disables egress with no boundary crossing", () => {
  it("A7 web egress fails closed during a qualifying run with zero network egress", async () => {
    const spy = interceptedProvider();
    const tool = createWebSearchTool({
      roleId: "A7",
      policy: QUALIFYING, // operatorEnabled: true, qualifyingRun: true
      provider: spy.provider,
      snapshotId: SNAPSHOT_ID,
      now: fixedNow,
    });

    await expect(
      tool.execute({ query: "Rin biography", maxRows: 10, maxBytes: 1_000_000 }, undefined),
    ).rejects.toMatchObject({ name: "EgressDeniedError", code: "qualifying-run-disabled" });

    expect(spy.queries).toEqual([]);
    expect(spy.fetchCalls).toBe(0);
  });

  it("the bare gate also refuses A7 under the qualifying posture", () => {
    expect(() => assertWebEgressAllowed("A7", QUALIFYING)).toThrowError(
      /forbidden during a qualifying/,
    );
    expect(webEgressAllowed("A7", QUALIFYING)).toBe(false);
  });
});
