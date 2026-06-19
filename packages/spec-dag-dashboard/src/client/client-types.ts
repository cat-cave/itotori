// Re-export the data contract for the browser client. The client is bundled
// separately (esbuild) but type-checked as part of the single tsc program, so
// it shares the exact same DashboardData/EnrichedNode shapes the generator
// serializes.

export type { DashboardData, EnrichedNode, Provenance, Verification } from "../types.js";
