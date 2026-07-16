// Type aliases inferred from the contract Zod schemas. The contracts export the
// schemas (values); the gates need the inferred TS types, so we derive them
// once here rather than re-inferring at each use site.

import type { z } from "zod";

import type {
  Defect,
  DeterministicDefectCategorySchema,
  DeterministicGateSchema,
  ReviewerDefectCategorySchema,
} from "../contracts/index.js";

export type DeterministicGate = z.infer<typeof DeterministicGateSchema>;
export type ReviewerDefectCategory = z.infer<typeof ReviewerDefectCategorySchema>;
export type DeterministicDefectCategory = z.infer<typeof DeterministicDefectCategorySchema>;

/** The deterministic-origin member of the Defect union — every gate emits this. */
export type DeterministicDefect = Extract<Defect, { origin: "deterministic" }>;
