-- p0-core-purge-reviewer-queue-as-deferral:
--
-- The reviewer queue was a deferral mechanism, not a durable localization
-- surface. Result revisions, canonical context corrections, wiki context, and
-- patch iteration now own the legitimate mutations. Historical migrations stay
-- immutable so deployed databases retain their migration ledger; this forward
-- migration removes the retired physical queue everywhere.
--
-- The workspace-correction table is retired by a later forward migration. Its
-- nullable `review_item_id` was only a foreign-key link into the retired queue,
-- so drop that link before removing the queue tables.

alter table if exists itotori_workspace_correction_edits
  drop column if exists review_item_id;

-- Drop the dependent transition log before its parent. Do not use CASCADE:
-- the workspace-correction dependency was removed explicitly above, so an
-- unexpected future dependency fails the migration instead of being erased.
drop table if exists itotori_reviewer_queue_transitions;
drop table if exists itotori_reviewer_queue_items;
