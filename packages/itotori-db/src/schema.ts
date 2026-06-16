import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const projectStatusValues = {
  imported: "imported",
  drafted: "drafted",
  patchExported: "patch_exported",
  runtimeIngested: "runtime_ingested",
} as const;

export type ProjectStatus = (typeof projectStatusValues)[keyof typeof projectStatusValues];

export const helloWorldFinalStatusValues = {
  passed: "hello_world_passed",
} as const;

export type HelloWorldFinalStatus =
  (typeof helloWorldFinalStatusValues)[keyof typeof helloWorldFinalStatusValues];

export const projects = pgTable("itotori_projects", {
  projectId: text("project_id").primaryKey(),
  bridgeId: text("bridge_id").notNull(),
  sourceLocale: text("source_locale").notNull(),
  targetLocale: text("target_locale").notNull(),
  localeBranchId: text("locale_branch_id").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bridgeUnits = pgTable("itotori_bridge_units", {
  bridgeUnitId: text("bridge_unit_id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId, { onDelete: "cascade" }),
  sourceUnitKey: text("source_unit_key").notNull(),
  sourceText: text("source_text").notNull(),
  targetText: text("target_text"),
  textSurface: text("text_surface").notNull(),
  protectedSpanCount: integer("protected_span_count").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const patchExports = pgTable("itotori_patch_exports", {
  patchExportId: text("patch_export_id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId, { onDelete: "cascade" }),
  targetLocale: text("target_locale").notNull(),
  entryCount: integer("entry_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runtimeReports = pgTable("itotori_runtime_reports", {
  runtimeReportId: text("runtime_report_id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId, { onDelete: "cascade" }),
  status: text("status").notNull(),
  fidelityTier: text("fidelity_tier").notNull(),
  textEventCount: integer("text_event_count").notNull(),
  frameCaptureCount: integer("frame_capture_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const helloWorldRuns = pgTable("itotori_hello_world_runs", {
  runId: text("run_id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.projectId, { onDelete: "cascade" }),
  patchResultId: text("patch_result_id").notNull(),
  finalStatus: text("final_status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
