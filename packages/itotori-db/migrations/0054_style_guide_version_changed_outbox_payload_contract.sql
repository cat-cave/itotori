-- ITOTORI-123: durably enforce the StyleGuideVersionChanged outbox payload
-- contract at the event-persistence boundary.
--
-- The finding
-- -----------
-- The primary style-guide event, StyleGuideVersionChanged, is appended to
-- itotori_event_outbox with its contract carried entirely in a `jsonb` payload
-- column. The table already constrains `event_type` (an allow-list) and the
-- shape of `error_history`, but places NO shape requirement on `payload`. The
-- application write path (appendStyleGuideVersionChangedEventInTx) does call a
-- TypeScript assert (assertStyleGuideVersionChangedPayload) before the insert,
-- but that assert is NOT durable: any raw SQL insert, a future/alternate code
-- path, or a bug that skips the helper could persist a StyleGuideVersionChanged
-- row whose payload is missing schemaVersion / project id / locale-branch id /
-- previous or new version id — an audit-incomplete event that downstream
-- consumers cannot trust.
--
-- The fix: a DB-level CHECK constraint that validates the payload shape for
-- every StyleGuideVersionChanged outbox row, for EVERY code path and every raw
-- SQL statement. This is the durable persistence boundary the application-level
-- assert cannot provide.
--
-- Why a CHECK constraint (not a trigger, not repo-only)
-- -----------------------------------------------------
-- The required contract is a per-row, self-contained shape check on immutable
-- jsonb operators (`?&`, `->`, `->>`, jsonb_typeof) — exactly what a CHECK
-- constraint expresses. It needs no other rows/tables, so a trigger would be
-- strictly heavier with no gain. A repo-level validator (which already exists,
-- and is kept for fast, descriptive app-boundary errors and for the deeper
-- approval-boundary / source-revision structure a CHECK cannot ergonomically
-- express) is NOT durable on its own — it is bypassable. The CHECK is the
-- durable backstop for the acceptance-named core fields.
--
-- The enforced contract (acceptance-named fields + identity discriminators)
-- ------------------------------------------------------------------------
-- A StyleGuideVersionChanged payload MUST:
--   * be a JSON object;
--   * carry all of: schemaVersion, eventName, changeKind, projectId,
--     localeBranchId, previousVersionId, newVersionId (key presence);
--   * schemaVersion  == 'itotori.style_guide_version_changed.v1';
--   * eventName      == 'StyleGuideVersionChanged';
--   * changeKind     in ('version_created', 'version_approved');
--   * projectId, localeBranchId, newVersionId  each a JSON string;
--   * previousVersionId  a JSON string OR JSON null (present but nullable — a
--     first version has no predecessor).
-- The deeper approvalBoundary / sourceRevisionReference structure remains
-- enforced by the TypeScript contract (assertStyleGuideVersionChangedPayload);
-- this CHECK is the durable floor for the core audit fields.
--
-- Definite-boolean design: `payload ?& array[...]` yields a definite boolean
-- (never NULL for the NOT NULL payload column), so a missing key makes the
-- clause FALSE rather than UNKNOWN — a CHECK treats UNKNOWN as satisfied, which
-- would let a missing field slip through. Requiring key presence FIRST means
-- every subsequent jsonb_typeof(...) operates on a present value and returns a
-- definite result. Rows of any OTHER event_type are unaffected (the leading
-- `event_type <> '...'` disjunct short-circuits them to satisfied).
--
-- Forward-only. Synthetic/test schemas are empty, so it applies clean. On a
-- populated DB, every StyleGuideVersionChanged row is produced by the build
-- helpers (buildStyleGuideVersionCreatedPayload / buildStyleGuideApprovalEvent-
-- Payload), which always emit these fields, so no pre-existing row violates the
-- new constraint; ADD CONSTRAINT validating existing rows is the desired proof.
--
-- @permission-gate draft.write writes (createVersion / approveVersion append
--   the constrained StyleGuideVersionChanged outbox rows)
-- @permission-gate draft.read reads

alter table itotori_event_outbox
  drop constraint if exists itotori_event_outbox_style_guide_version_changed_payload_check;

alter table itotori_event_outbox
  add constraint itotori_event_outbox_style_guide_version_changed_payload_check check (
    event_type <> 'style_guide_version_changed'
    or (
      jsonb_typeof(payload) = 'object'
      and payload ?& array[
        'schemaVersion',
        'eventName',
        'changeKind',
        'projectId',
        'localeBranchId',
        'previousVersionId',
        'newVersionId'
      ]
      and payload->>'schemaVersion' = 'itotori.style_guide_version_changed.v1'
      and payload->>'eventName' = 'StyleGuideVersionChanged'
      and payload->>'changeKind' in ('version_created', 'version_approved')
      and jsonb_typeof(payload->'projectId') = 'string'
      and jsonb_typeof(payload->'localeBranchId') = 'string'
      and jsonb_typeof(payload->'previousVersionId') in ('string', 'null')
      and jsonb_typeof(payload->'newVersionId') = 'string'
    )
  );
