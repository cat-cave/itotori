import { ItotoriLlmWikiRepository } from "@itotori/db";
import { expect, it } from "vitest";

import { computeImpactSet, diffUpstreamObject } from "../src/wiki/scoped-invalidation/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

import { TestMemoCipher } from "./llm-step-test-support.js";

import {
  postgresDescribe,
  UPSTREAM_ID,
  byObject,
  upstream,
  seed,
  seedUnrelatedArtifacts,
  artifactHashes,
  unrelatedPatchExportHash,
  consumerRow,
} from "./scoped-invalidation-live-db.support.js";

postgresDescribe("field/claim-scoped invalidation", () => {
  it("PROOF (minimal): a one-field change invalidates EXACTLY its in-scope citing consumers", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const impact = await service.planInvalidation({
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      });

      // EXACTLY the two register-policy consumers, in deterministic order. The
      // honorific-field consumer, the claim consumer, out-of-route consumer,
      // and a superseded historical field consumer are NOT swept in — this is
      // field/scope/head-precise, not object-wide.
      expect(impact.consumers.map((consumer) => consumer.downstreamObjectId)).toEqual([
        "wiki:consumer:field",
        "wiki:consumer:human",
      ]);

      const field = byObject(impact, "wiki:consumer:field");
      expect(field.workKind).toBe("enhancement");
      expect(field.protectedHuman).toBe(false);
      expect(field.matchedFieldPaths).toEqual([["body", "registerPolicy"]]);
      expect(impact.enhancementWork).toEqual([field.downstreamWikiVersionId]);

      // The excluded live consumers really exist as current candidate edges
      // (proving exclusion is selectivity, not an empty table). The historical
      // changed-mind v1 edge is deliberately absent: only a current head can
      // be invalidated.
      const allConsumers = await new ItotoriLlmWikiRepository(context.pool, cipher).queryDependents(
        {
          upstreamObjectId: UPSTREAM_ID,
        },
      );
      expect(new Set(allConsumers.map((edge) => edge.downstreamObjectId))).toEqual(
        new Set([
          "wiki:consumer:field",
          "wiki:consumer:human",
          "wiki:consumer:honorific",
          "wiki:consumer:claim",
          "wiki:consumer:outofscope",
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("PROOF (byte-identical): the one-field change leaves unrelated object/memo/accepted-unit/patch hashes untouched", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const transportCalls = await seedUnrelatedArtifacts(context, cipher, contextId);

      const before = await artifactHashes(context.pool);
      const beforePatchExport = unrelatedPatchExportHash();
      expect(transportCalls()).toBe(1);
      await service.planInvalidation({
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      });
      const after = await artifactHashes(context.pool);

      // The planner is READ-ONLY: EVERY stored content hash is byte-identical.
      expect(after).toEqual(before);
      // And spelled out per artifact class the guarantee names.
      expect(after.unrelatedObject).toBe(before.unrelatedObject);
      expect(after.memo).toBe(before.memo);
      expect(after.acceptedUnit).toBe(before.acceptedUnit);
      // The actual PatchExportV02 is reconstructed only from unaffected
      // accepted inputs, so its content address must remain byte-identical too.
      expect(unrelatedPatchExportHash()).toBe(beforePatchExport);
      // The only recorded provider response was needed to seed an unrelated
      // memo. Planning impact made NO model/provider call: invalidation is
      // exclusively structured diff + persisted dependency-edge intersection.
      expect(transportCalls()).toBe(1);
      // Neither the unrelated nor the human consumer was erased.
      expect(after.deletionStates).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("PROOF (protected human): a human-touched consumer is an ENHANCE target, never erased", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const humanBefore = await consumerRow(context.pool, "wiki:consumer:human");

      const impact = await service.planInvalidation({
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      });

      const human = byObject(impact, "wiki:consumer:human");
      // Enhanced, reviewed, protected — the impact set has NO erase/delete kind.
      expect(human.protectedHuman).toBe(true);
      expect(human.workKind).toBe("review");
      expect(impact.reviewerWork).toEqual([human.downstreamWikiVersionId]);

      // The human version survives byte-for-byte and stays active (not erased).
      const humanAfter = await consumerRow(context.pool, "wiki:consumer:human");
      expect(humanAfter).toEqual(humanBefore);
      expect(humanAfter.deletion_state).toBe("active");
    } finally {
      await context.close();
    }
  });

  it("PROOF (deterministic, model-free): the same diff + edges yield the same content-addressed set", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const request = {
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      };

      // No runner/model is accepted anywhere in the path — the service is
      // constructed with a repository alone and the impact set is a value.
      const first = await service.planInvalidation(request);
      const second = await service.planInvalidation(request);
      expect(second.impactSetHash).toBe(first.impactSetHash);
      expect(second).toEqual(first);

      // The core is a PURE synchronous function of (change set, edges): computed
      // twice off the same inputs it is identical, with no I/O in between.
      const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
      const changeSet = diffUpstreamObject(request.priorObjectJson, request.nextObjectJson);
      const edges = await wiki.queryDependents({ upstreamObjectId: UPSTREAM_ID });
      expect(computeImpactSet(changeSet, edges).impactSetHash).toBe(
        computeImpactSet(changeSet, edges).impactSetHash,
      );
      expect(computeImpactSet(changeSet, edges).impactSetHash).toBe(first.impactSetHash);
    } finally {
      await context.close();
    }
  });
});
