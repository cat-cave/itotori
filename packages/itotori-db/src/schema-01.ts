import {
  bigint as pgBigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.
import type { Permission } from "./authorization.js";

export const projectStatusValues = {
  imported: "imported",
  drafted: "drafted",
  patchExported: "patch_exported",
  runtimeIngested: "runtime_ingested",
  archived: "archived",
} as const;

export type ProjectStatus = (typeof projectStatusValues)[keyof typeof projectStatusValues];

export const localeBranchStatusValues = {
  active: "active",
  archived: "archived",
} as const;

export type LocaleBranchStatus =
  (typeof localeBranchStatusValues)[keyof typeof localeBranchStatusValues];

export const projectRunStatusValues = {
  queued: "queued",
  running: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type ProjectRunStatus = (typeof projectRunStatusValues)[keyof typeof projectRunStatusValues];

export const projectRunProgressStatusValues = {
  decoded: "decoded",
  drafted: "drafted",
  QA: "QA",
  accepted: "accepted",
  patched: "patched",
} as const;

export type ProjectRunProgressStatus =
  (typeof projectRunProgressStatusValues)[keyof typeof projectRunProgressStatusValues];

export const wikiBrandContextRoleValues = {
  base: "base",
  sequel: "sequel",
  fandisk: "fandisk",
  shared: "shared",
} as const;

export type WikiBrandContextRole =
  (typeof wikiBrandContextRoleValues)[keyof typeof wikiBrandContextRoleValues];

export const styleGuideVersionStatusValues = {
  draft: "draft",
  approved: "approved",
  superseded: "superseded",
} as const;

export type StyleGuideVersionStatus =
  (typeof styleGuideVersionStatusValues)[keyof typeof styleGuideVersionStatusValues];

export const outboxEventTypeValues = {
  agentTaskRequested: "agent_task_requested",
  deterministicToolTaskRequested: "deterministic_tool_task_requested",
  rerunRequested: "rerun_requested",
  triageLoopRequested: "triage_loop_requested",
  styleGuideVersionChanged: "style_guide_version_changed",
  affectedWorkInvalidated: "affected_work_invalidated",
  jobScheduled: "job_scheduled",
  jobCompleted: "job_completed",
  jobFailed: "job_failed",
  jobDeadLettered: "job_dead_lettered",
} as const;

export type OutboxEventType = (typeof outboxEventTypeValues)[keyof typeof outboxEventTypeValues];

export const outboxStatusValues = {
  pending: "pending",
  publishing: "publishing",
  published: "published",
  retryWaiting: "retry_waiting",
  deadLetter: "dead_letter",
} as const;

export type OutboxStatus = (typeof outboxStatusValues)[keyof typeof outboxStatusValues];

export const jobTaskTypeValues = {
  agentTask: "agent_task",
  deterministicToolTask: "deterministic_tool_task",
  rerun: "rerun",
  triageLoop: "triage_loop",
} as const;

export type JobTaskType = (typeof jobTaskTypeValues)[keyof typeof jobTaskTypeValues];

export const jobStatusValues = {
  queued: "queued",
  running: "running",
  retryWaiting: "retry_waiting",
  succeeded: "succeeded",
  deadLetter: "dead_letter",
  cancelled: "cancelled",
} as const;

export type JobStatus = (typeof jobStatusValues)[keyof typeof jobStatusValues];

export const jobIdempotencyPolicyValues = {
  idempotent: "idempotent",
  nonIdempotent: "non_idempotent",
} as const;

export type JobIdempotencyPolicy =
  (typeof jobIdempotencyPolicyValues)[keyof typeof jobIdempotencyPolicyValues];

export const providerRunStatusValues = {
  succeeded: "succeeded",
  failed: "failed",
  partial: "partial",
  skipped: "skipped",
} as const;

export type ProviderRunStatus =
  (typeof providerRunStatusValues)[keyof typeof providerRunStatusValues];

// Narrowed from the legacy 5-value enum to the only two cost states the
// cost-tracking audit (docs/audits/openrouter-cost-tracking-
// audit-2026-06-25.md) considers correct: a real upstream charge, or no
// charge at all. Migration 0039 backfills + tightens the CHECK constraint.
//
// Also re-introduces `provider_estimate` as a narrowly-scoped deterministic
// cost-estimate state (derived from cost_details or endpoint-pricing ×
// tokens) for responses where the authoritative `usage.cost` is absent.
// The TS type accepts it; the DB CHECK constraint (migration 0039) is a
// separate follow-up — provider-level tests use an in-memory recorder, so
// this widening is type-safe without a migration.
export const providerCostKindValues = {
  billed: "billed",
  provider_estimate: "provider_estimate",
  zero: "zero",
} as const;

export type ProviderCostKind = (typeof providerCostKindValues)[keyof typeof providerCostKindValues];

export const runtimeRunStatusValues = {
  passed: "passed",
  failed: "failed",
} as const;

export type RuntimeRunStatus = (typeof runtimeRunStatusValues)[keyof typeof runtimeRunStatusValues];

export const runtimeEvidenceKindValues = {
  traceEvent: "trace_event",
  branchEvent: "branch_event",
  capture: "capture",
  recording: "recording",
  approximation: "approximation",
  referenceComparison: "reference_comparison",
} as const;

export type RuntimeEvidenceKind =
  (typeof runtimeEvidenceKindValues)[keyof typeof runtimeEvidenceKindValues];

export const runtimeBridgeUnitRefRoleValues = {
  primary: "primary",
  branchLabel: "branch_label",
  branchTarget: "branch_target",
  affected: "affected",
  covered: "covered",
} as const;

export type RuntimeBridgeUnitRefRole =
  (typeof runtimeBridgeUnitRefRoleValues)[keyof typeof runtimeBridgeUnitRefRoleValues];

export const catalogSourceValues = {
  vndb: "vndb",
  egs: "egs",
  dlsite: "dlsite",
  steam: "steam",
  igdb: "igdb",
  wikidata: "wikidata",
  localCorpus: "local_corpus",
  kaifuu: "kaifuu",
  manual: "manual",
} as const;
