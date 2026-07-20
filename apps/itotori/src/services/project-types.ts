import type { ItotoriProjectRecord } from "@itotori/db";

/**
 * Shared project document shape for deterministic API, CLI, and QA surfaces.
 * The record remains owned by the database package; this module gives local
 * consumers a neutral type-only import path.
 */
export type ProjectState = ItotoriProjectRecord;
