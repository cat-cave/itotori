import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { translationMemoryReuseEvents } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import { modelLedgerFixture, projectFixture } from "./model-ledger-repository.test.support.js";

describe("ItotoriModelLedgerRepository", () => {
  it("keeps the project cost report available when a tm reuse event has a malformed cost_impact JSON", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      // Seed a translation-memory segment for the well-formed reuse event.
      await context.db.execute(sql`
        insert into itotori_translation_memory_segments
          (memory_segment_id, project_id, locale_branch_id, source_revision_id,
           source_unit_key, source_occurrence_id, source_hash, source_fingerprint,
           source_text, target_locale, target_text, status, provenance)
        values
          ('tm-segment-good', 'project-test', 'locale-en-us', ${modelLedgerFixture.sourceRevisionId},
           ${modelLedgerFixture.sourceUnitKey}, ${modelLedgerFixture.sourceOccurrenceId}, ${modelLedgerFixture.sourceHash}, 'fingerprint-good',
           'こんにちは、{player}。', 'en-US', 'Hello, {player}.', 'reusable', '{}'::jsonb)
      `);

      // WELL-FORMED reuse event: every numeric / boolean field is the
      // expected scalar shape.
      await context.db.execute(sql`
        insert into itotori_translation_memory_reuse_events
          (reuse_event_id, project_id, locale_branch_id, target_bridge_unit_id,
           source_revision_id, memory_segment_id, match_kind, match_score,
           reuse_status, source_hash, candidate_source_hash, target_text,
           cost_impact, provenance)
        values
          ('reuse-good', 'project-test', 'locale-en-us', ${modelLedgerFixture.unitId},
           ${modelLedgerFixture.sourceRevisionId}, 'tm-segment-good', 'exact', 1000,
           'applied', ${modelLedgerFixture.sourceHash}, ${modelLedgerFixture.sourceHash}, 'Hello, {player}.',
           ${sql.raw(`'{"providerCallAvoided":true,"estimatedPromptTokensSaved":40,"estimatedCompletionTokensSaved":20,"estimatedTotalTokensSaved":60,"estimatedCostUsdSaved":"0.00012","calculation":"deterministic_character_estimate_v1"}'::jsonb`)},
           '{}'::jsonb)
      `);

      // MALFORMED reuse event: inserted OUTSIDE the repository API via raw
      // SQL. `estimatedPromptTokensSaved` is a string ("abc") where the
      // aggregation expects an integer — this is the exact shape that
      // aborted the pre-fix aggregation with `invalid input syntax for
      // type integer: "abc"`. We also slip in a non-bool
      // `providerCallAvoided` and a non-numeric `estimatedCostUsdSaved` to
      // prove the defensive predicate covers every field the aggregation
      // reads.
      await context.db.execute(sql`
        insert into itotori_translation_memory_reuse_events
          (reuse_event_id, project_id, locale_branch_id, target_bridge_unit_id,
           source_revision_id, memory_segment_id, match_kind, match_score,
           reuse_status, source_hash, candidate_source_hash, target_text,
           cost_impact, provenance)
        values
          ('reuse-malformed', 'project-test', 'locale-en-us', ${modelLedgerFixture.unitId},
           ${modelLedgerFixture.sourceRevisionId}, 'tm-segment-good', 'exact', 1000,
           'applied', ${modelLedgerFixture.sourceHash}, ${modelLedgerFixture.sourceHash}, 'Hello, {player}.',
           ${sql.raw(`'{"providerCallAvoided":"yes","estimatedPromptTokensSaved":"abc","estimatedCompletionTokensSaved":20,"estimatedTotalTokensSaved":60,"estimatedCostUsdSaved":"cheap"}'::jsonb`)},
           '{}'::jsonb)
      `);

      // Sanity: both rows are present.
      const rawCount = await context.db.execute(sql`
        select count(*)::int as n from ${translationMemoryReuseEvents} where project_id = 'project-test'
      `);
      expect(rawCount.rows[0]).toMatchObject({ n: 2 });

      // The aggregation MUST succeed (no throw). The malformed row is
      // skipped from the numeric sums but counted in
      // `malformedCostImpactCount` and surfaced via a diagnostic.
      const report = await ledger.getProjectCostReport(localActor, "project-test");
      const reuse = report.translationMemoryReuse;

      expect(reuse.reuseEventCount).toBe(2);
      expect(reuse.appliedCount).toBe(2);
      expect(reuse.suggestedCount).toBe(0);
      // Malformed row is skipped, so `providerCallAvoidedCount` only counts
      // the well-formed row's `providerCallAvoided: true`.
      expect(reuse.providerCallAvoidedCount).toBe(1);
      // The malformed row's non-numeric fields are NOT summed; only the
      // well-formed row contributes.
      expect(reuse.estimatedPromptTokensSaved).toBe(40);
      expect(reuse.estimatedCompletionTokensSaved).toBe(20);
      expect(reuse.estimatedTotalTokensSaved).toBe(60);
      expect(reuse.estimatedCostUsdSaved).toBeCloseTo(0.00012, 6);
      // Malformed row is surfaced for repair.
      expect(reuse.malformedCostImpactCount).toBe(1);
      expect(reuse.diagnostics).toHaveLength(1);
      expect(reuse.diagnostics[0]).toMatchObject({
        code: "translation_memory.reuse_event.cost_impact.malformed",
        severity: "warning",
        reasonCode: "malformed_cost_impact_json",
        field: "cost_impact",
      });
      expect(reuse.diagnostics[0]?.metadata).toMatchObject({
        projectId: "project-test",
        malformedCostImpactCount: 1,
      });

      // recentEvents rows surface `malformedCostImpact` for the malformed
      // event and zero its cost fields defensively (no NaN, no leaked
      // non-numeric value), while the well-formed row keeps its numbers.
      const byId = new Map(reuse.recentEvents.map((row) => [row.reuseEventId, row]));
      const good = byId.get("reuse-good");
      const bad = byId.get("reuse-malformed");
      expect(good).toBeDefined();
      expect(bad).toBeDefined();
      expect(good?.malformedCostImpact).toBe(false);
      expect(good?.estimatedPromptTokensSaved).toBe(40);
      expect(good?.providerCallAvoided).toBe(true);
      expect(bad?.malformedCostImpact).toBe(true);
      // Non-numeric / non-bool fields are coerced to zero / false so
      // downstream consumers never see NaN or non-boolean truthy values.
      expect(bad?.estimatedPromptTokensSaved).toBe(0);
      expect(bad?.estimatedCompletionTokensSaved).toBe(20);
      expect(bad?.estimatedTotalTokensSaved).toBe(60);
      expect(bad?.providerCallAvoided).toBe(false);
      expect(bad?.estimatedCostUsdSaved).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("does not surface a malformed-cost-impact diagnostic when every reuse event is well-formed", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await context.db.execute(sql`
        insert into itotori_translation_memory_segments
          (memory_segment_id, project_id, locale_branch_id, source_revision_id,
           source_unit_key, source_occurrence_id, source_hash, source_fingerprint,
           source_text, target_locale, target_text, status, provenance)
        values
          ('tm-segment-good-2', 'project-test', 'locale-en-us', ${modelLedgerFixture.sourceRevisionId},
           ${modelLedgerFixture.sourceUnitKey}, ${modelLedgerFixture.sourceOccurrenceId}, ${modelLedgerFixture.sourceHash}, 'fingerprint-good-2',
           'こんにちは、{player}。', 'en-US', 'Hello, {player}.', 'reusable', '{}'::jsonb)
      `);
      await context.db.execute(sql`
        insert into itotori_translation_memory_reuse_events
          (reuse_event_id, project_id, locale_branch_id, target_bridge_unit_id,
           source_revision_id, memory_segment_id, match_kind, match_score,
           reuse_status, source_hash, candidate_source_hash, target_text,
           cost_impact, provenance)
        values
          ('reuse-good-2', 'project-test', 'locale-en-us', ${modelLedgerFixture.unitId},
           ${modelLedgerFixture.sourceRevisionId}, 'tm-segment-good-2', 'exact', 1000,
           'applied', ${modelLedgerFixture.sourceHash}, ${modelLedgerFixture.sourceHash}, 'Hello, {player}.',
           ${sql.raw(`'{"providerCallAvoided":true,"estimatedPromptTokensSaved":12,"estimatedCompletionTokensSaved":3,"estimatedTotalTokensSaved":15,"estimatedCostUsdSaved":"0.00005","calculation":"deterministic_character_estimate_v1"}'::jsonb`)},
           '{}'::jsonb)
      `);

      const reuse = (await ledger.getProjectCostReport(localActor, "project-test"))
        .translationMemoryReuse;
      expect(reuse.reuseEventCount).toBe(1);
      expect(reuse.malformedCostImpactCount).toBe(0);
      expect(reuse.diagnostics).toEqual([]);
      expect(reuse.estimatedPromptTokensSaved).toBe(12);
      expect(reuse.providerCallAvoidedCount).toBe(1);
    } finally {
      await context.close();
    }
  });
});
