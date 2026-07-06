-- ITOTORI-130: give pre-provenance draft rows explicit style-guide provenance
-- so approval INVALIDATION has defined behavior for existing target text.
--
-- The finding
-- -----------
-- Style-guide approval INVALIDATION (style-guide-repository.ts,
-- listAffectedWorkByPriorStyleGuideVersionInTx) selects the drafts to re-review
-- by matching a draft row's provenance column:
--
--     itotori_locale_branch_units.style_guide_version_id = <prior approved version>
--
-- The provenance column was added by migration 0018. Draft rows written BEFORE
-- 0018 carry non-null `target_text` but a NULL `style_guide_version_id`. In SQL,
-- `NULL = <anything>` is never true, so those pre-provenance drafts match NO
-- prior version and are SILENTLY MISSED by the first (and every later) approval
-- -- a draft that should be flagged for review is never flagged.
--
-- The repair (forward-only, idempotent)
-- -------------------------------------
-- Attribute each pre-provenance draft to the style-guide version that was in
-- force for its locale branch at migration time -- the currently-approved
-- version (`itotori_style_guides.approved_version_id`). This is deterministic:
-- the approved version is exactly the provenance a re-drafted unit would have
-- carried, so post-backfill these rows behave identically to normal rows -- the
-- next approval (prior = this approved version) flags them, then they clear.
--
-- Only touches rows that are genuinely pre-provenance (target_text present,
-- style_guide_version_id NULL), so re-running is a no-op. The target value is a
-- real style_guide_versions id, satisfying the 0018 foreign key.
--
-- Residual unknown-provenance rows (target_text present, provenance NULL, and
-- the locale branch has no approved version yet, so there is nothing
-- deterministic to attribute to) are LEFT NULL here and handled at query time:
-- listAffectedWorkByPriorStyleGuideVersionInTx treats a NULL-provenance draft
-- with target text as UNKNOWN provenance and FLAGS it on any later
-- approval-with-prior. The safe default is to over-flag (a human reviews a draft
-- that may already be fine) rather than silently skip a draft that should be
-- reviewed. See the "unknown-provenance invalidation policy" note there.

update itotori_locale_branch_units u
set style_guide_version_id = g.approved_version_id
from itotori_style_guides g
where u.locale_branch_id = g.locale_branch_id
  and u.target_text is not null
  and u.style_guide_version_id is null
  and g.approved_version_id is not null;
