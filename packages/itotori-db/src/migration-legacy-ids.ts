/**
 * Legacy migration id aliases.
 *
 * A small set of migrations were renumbered after concurrent ordinal collisions
 * on earlier branches. Deployed databases may still record the pre-rename id;
 * migrate() adopts those rows when the checksum matches rather than replaying
 * DDL. This map is the only hand-maintained migration metadata — the apply
 * list itself is discovered from packages/itotori-db/migrations/*.sql.
 *
 * Edit this file only when introducing a deliberate rename/alias. Ordinary new
 * migrations need no entry here.
 */
export const migrationLegacyIds: Readonly<Record<string, readonly string[]>> = {
  "0085_localization_run_finalizer": ["0083_localization_run_finalizer"],
  "0086_terminal_finalizer_integrity": ["0084_terminal_finalizer_integrity"],
  "0087_playable_patch_immutability": ["0085_playable_patch_immutability"],
  "0088_playable_patch_idempotent_membership": ["0086_playable_patch_idempotent_membership"],
  "0090_play_tester_result_revision": ["0089_play_tester_result_revision"],
};
