export const productMigrationEntries = [
  {
    id: "0061_auth_authorization_boundary_hardening",
    file: "0061_auth_authorization_boundary_hardening.sql",
  },
  {
    id: "0062_catalog_release_mapping_source_traversal_index",
    file: "0062_catalog_release_mapping_source_traversal_index.sql",
  },
  {
    id: "0063_translation_memory_check_constraints",
    file: "0063_translation_memory_check_constraints.sql",
  },
  {
    id: "0064_benchmark_runs",
    file: "0064_benchmark_runs.sql",
  },
  {
    id: "0065_auth_provider_claim_quarantine",
    file: "0065_auth_provider_claim_quarantine.sql",
  },
  {
    id: "0066_auth_sso_settings",
    file: "0066_auth_sso_settings.sql",
  },
  {
    id: "0067_auth_members_manage_permission",
    file: "0067_auth_members_manage_permission.sql",
  },
  {
    id: "0068_scene_localization_coverage",
    file: "0068_scene_localization_coverage.sql",
  },
  {
    id: "0069_auth_permissions_manage_permission",
    file: "0069_auth_permissions_manage_permission.sql",
  },
  {
    id: "0070_auth_session_admin_tools",
    file: "0070_auth_session_admin_tools.sql",
  },
  {
    id: "0071_wiki_brand_contexts",
    file: "0071_wiki_brand_contexts.sql",
  },
  {
    id: "0072_auth_account_billing_seats",
    file: "0072_auth_account_billing_seats.sql",
  },
  {
    id: "0073_model_routing_settings",
    file: "0073_model_routing_settings.sql",
  },
  {
    id: "0074_translation_scope_settings",
    file: "0074_translation_scope_settings.sql",
  },
  {
    id: "0075_localization_pass_run_configs",
    file: "0075_localization_pass_run_configs.sql",
  },
  {
    id: "0076_localization_attempt_outcome_journal",
    file: "0076_localization_attempt_outcome_journal.sql",
  },
  {
    id: "0077_retire_localization_pass_ledger",
    file: "0077_retire_localization_pass_ledger.sql",
  },
  {
    id: "0078_retire_draft_attempt_provider_ledger",
    file: "0078_retire_draft_attempt_provider_ledger.sql",
  },
  {
    id: "0079_invocation_supervisor_lifecycle",
    file: "0079_invocation_supervisor_lifecycle.sql",
  },
  {
    id: "0080_localization_run_leases_and_unit_claims",
    file: "0080_localization_run_leases_and_unit_claims.sql",
  },
  {
    id: "0081_atomic_cost_reservations",
    file: "0081_atomic_cost_reservations.sql",
  },
  {
    id: "0082_backfill_localization_run_cost_accounts",
    file: "0082_backfill_localization_run_cost_accounts.sql",
  },
  {
    id: "0083_context_entry_versions",
    file: "0083_context_entry_versions.sql",
  },
  {
    id: "0084_retire_legacy_semantic_agent_tables",
    file: "0084_retire_legacy_semantic_agent_tables.sql",
  },
  {
    // Node 5 first shipped this family as 0083–0086, before nodes 6/7 landed
    // 0083/0084 on main. Adopt a byte-identical legacy migration instead of
    // replaying its DDL, and record the canonical post-rebase ID.
    id: "0085_localization_run_finalizer",
    file: "0085_localization_run_finalizer.sql",
    legacyIds: ["0083_localization_run_finalizer"],
  },
  {
    id: "0086_terminal_finalizer_integrity",
    file: "0086_terminal_finalizer_integrity.sql",
    legacyIds: ["0084_terminal_finalizer_integrity"],
  },
  {
    id: "0087_playable_patch_immutability",
    file: "0087_playable_patch_immutability.sql",
    legacyIds: ["0085_playable_patch_immutability"],
  },
  {
    id: "0088_playable_patch_idempotent_membership",
    file: "0088_playable_patch_idempotent_membership.sql",
    legacyIds: ["0086_playable_patch_idempotent_membership"],
  },
  {
    id: "0089_playtester_context_categories",
    file: "0089_playtester_context_categories.sql",
  },
  {
    // This shipped briefly as 0089 on the result-revision branch before
    // origin/main claimed that number for context categories. Its SQL is
    // byte-identical after the rename, so adopt that deployed row rather
    // than replaying the structural DDL.
    id: "0090_play_tester_result_revision",
    file: "0090_play_tester_result_revision.sql",
    legacyIds: ["0089_play_tester_result_revision"],
  },
  {
    id: "0091_iterative_patch_versioning_and_playtest_feedback",
    file: "0091_iterative_patch_versioning_and_playtest_feedback.sql",
  },
  {
    id: "0092_retire_reviewer_queue",
    file: "0092_retire_reviewer_queue.sql",
  },
  {
    id: "0093_retire_glossary_review_items",
    file: "0093_retire_glossary_review_items.sql",
  },
  {
    id: "0094_retire_workspace_correction_history",
    file: "0094_retire_workspace_correction_history.sql",
  },
  {
    id: "0095_retire_reviewer_permission_seed",
    file: "0095_retire_reviewer_permission_seed.sql",
  },
  {
    id: "0096_retire_scene_localization_coverage",
    file: "0096_retire_scene_localization_coverage.sql",
  },
  {
    id: "0097_retire_targetless_feedback_deferrals",
    file: "0097_retire_targetless_feedback_deferrals.sql",
  },
  {
    id: "0098_require_canonical_play_feedback_outcomes",
    file: "0098_require_canonical_play_feedback_outcomes.sql",
  },
  {
    id: "0099_release_interrupted_cost_reservations",
    file: "0099_release_interrupted_cost_reservations.sql",
  },
  {
    id: "0100_backfill_terminal_cost_reservations",
    file: "0100_backfill_terminal_cost_reservations.sql",
  },
  {
    id: "0101_rebuilt_llm_persistence",
    file: "0101_rebuilt_llm_persistence.sql",
  },
  {
    id: "0102_rebuilt_llm_history_truncate_guard",
    file: "0102_rebuilt_llm_history_truncate_guard.sql",
  },
  {
    id: "0103_llm_attempt_admission_exposure",
    file: "0103_llm_attempt_admission_exposure.sql",
  },
  {
    id: "0104_content_read_permission",
    file: "0104_content_read_permission.sql",
  },
  {
    id: "0105_llm_served_pair_quarantine",
    file: "0105_llm_served_pair_quarantine.sql",
  },
  {
    id: "0106_llm_transcript_snapshots",
    file: "0106_llm_transcript_snapshots.sql",
  },
  {
    id: "0107_runtime_artifact_uri_parity",
    file: "0107_runtime_artifact_uri_parity.sql",
  },
  {
    id: "0108_llm_explicit_unknown_quarantine",
    file: "0108_llm_explicit_unknown_quarantine.sql",
  },
  {
    id: "0109_wiki_snapshot_binding",
    file: "0109_wiki_snapshot_binding.sql",
  },
  {
    id: "0110_legacy_runtime_artifact_uri_parity",
    file: "0110_legacy_runtime_artifact_uri_parity.sql",
  },
  {
    id: "0111_retire_journal_finalizer_context_artifacts",
    file: "0111_retire_journal_finalizer_context_artifacts.sql",
  },
  {
    id: "0112_retire_benchmark_runs",
    file: "0112_retire_benchmark_runs.sql",
  },
  {
    id: "0113_project_engine_binding",
    file: "0113_project_engine_binding.sql",
  },
  {
    id: "0114_project_run_progress_cost_leases",
    file: "0114_project_run_progress_cost_leases.sql",
  },
  {
    id: "0115_one_active_project_run_per_branch",
    file: "0115_one_active_project_run_per_branch.sql",
  },
  {
    id: "0116_llm_provider_attribution_ledger",
    file: "0116_llm_provider_attribution_ledger.sql",
  },
  {
    id: "0117_release_terminal_project_run_cost_reservations",
    file: "0117_release_terminal_project_run_cost_reservations.sql",
  },
  {
    id: "0118_immutable_artifact_repository",
    file: "0118_immutable_artifact_repository.sql",
  },
  {
    id: "0119_immutable_artifact_database_enforcement",
    file: "0119_immutable_artifact_database_enforcement.sql",
  },
  {
    id: "0120_workflow_step_memos",
    file: "0120_workflow_step_memos.sql",
  },
] as const;
