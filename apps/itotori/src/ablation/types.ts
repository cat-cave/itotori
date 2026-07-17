// The pure-MTL ablation baseline — value types.
//
// A NAMED, NON-SHIPPABLE control arm for the translation benchmark. It runs on
// the SAME substrate as the real pipeline — the same DeepSeek model profile, the
// same sole ZDR dispatch boundary, the same source bytes, the same native
// patchback, and the same deterministic gates — but with the wiki/bible/review
// machinery STRIPPED: a null Wiki, a direct translation, and ~zero model QA. The
// delta between this baseline and a full qualifying run is exactly what the
// agentic layer adds.
//
// This module holds DATA SHAPES only. The legality gate lives in `./policy.ts`
// (it composes the run-policy boundary and refuses anything but the pure-MTL
// ablation), the thin driver in `./driver.ts`, and the lineage-isolation guard
// in `./lineage.ts`.

import type { Defect } from "../contracts/index.js";
import type { RunModeValue } from "../contracts/index.js";
import type { BibleBasis, ResolvedRunPolicy, RunPolicyRequest } from "../run-policy/index.js";
import type { AttemptLineageEntry, FinalizedUnit, WorkflowScene } from "../workflow/index.js";

/** A pure-MTL ablation run request. It carries the SAME fields as a normal run
 * request EXCEPT the ablation selector, which the ablation policy pins to
 * `pure-mtl` itself — so a caller cannot accidentally submit a wiki-first run
 * through the ablation entrypoint. Run mode / context / output scope / roster are
 * validated by the composed run-policy boundary exactly as for a real run. */
export type AblationRunRequest = Omit<RunPolicyRequest, "ablation">;

/** The scenes an ablation run localizes — the SAME decode-derived work items the
 * real workflow drives. The ablation re-uses this shape verbatim; it does not
 * fork a parallel scene model. */
export type AblationScene = WorkflowScene;

/** The lineage class a run's physical attempts / cost / latency / quality belong
 * to. It is DERIVED from the resolved policy's bible basis (see `lineageClassOf`),
 * never a hand-set flag: a null-Wiki (`pure-mtl-ablation`) basis is `ablation`,
 * every wiki-first basis is `qualifying`. The two classes are never mixed. */
export type LineageClass = "qualifying" | "ablation";

/** One scene's pass through the stripped ablation path. There is no readiness /
 * review / repair / adjudication stage — only the direct draft, the deterministic
 * gate report (surfaced, never model-corrected), and the finalized units. */
export interface AblationSceneOutcome {
  readonly sceneId: string;
  /** null when the scene was fully restart-skipped (every unit already final). */
  readonly drafted: boolean;
  readonly draftedUnitIds: readonly string[];
  readonly skippedUnitIds: readonly string[];
  /** The deterministic gate defects observed on the direct draft. They are
   * REPORTED for the benchmark, not routed to any model repair — the ablation
   * runs ~zero model QA. */
  readonly gateDefects: readonly Defect[];
  readonly finalized: readonly FinalizedUnit[];
}

/** The full ablation run report — the proof surface. It carries the resolved
 * policy (whose `bibleBasis` is `pure-mtl-ablation`), the per-scene outcomes, the
 * finalized units, the exported patch id, and the physical-attempt lineage TAGGED
 * with its `lineageClass`. `buildLqa` is deliberately absent: the ablation runs no
 * downstream model QA. */
export interface AblationRunReport {
  readonly policy: ResolvedRunPolicy;
  /** Always `ablation` — derived from `policy.bibleBasis`. Carried on the report
   * so any telemetry consumer sees the class without re-deriving it. */
  readonly lineageClass: LineageClass;
  readonly bibleBasis: BibleBasis;
  readonly runMode: RunModeValue;
  readonly scenes: readonly AblationSceneOutcome[];
  readonly finalized: readonly FinalizedUnit[];
  readonly patchId: string | null;
  readonly attemptLineage: readonly AttemptLineageEntry[];
}

/** A lineage contribution tagged with the class it belongs to. The qualifying
 * metrics ledger accepts ONLY `qualifying` contributions; an `ablation`-tagged
 * one is refused (see `foldQualifyingLineage`), so ablation attempts / cost /
 * latency can never be summed into a qualifying (production / pilot) run's
 * metrics. */
export interface TaggedLineage {
  readonly lineageClass: LineageClass;
  readonly runMode: RunModeValue;
  readonly bibleBasis: BibleBasis;
  readonly attempts: readonly AttemptLineageEntry[];
  readonly finalizedUnitCount: number;
}

/** An attempt to fold an ablation-tagged lineage into the qualifying metrics
 * ledger. There is no flag or alternate path around the refusal — the ablation's
 * telemetry is structurally quarantined from the qualifying lineage. */
export class AblationLineageIsolationError extends Error {
  constructor(readonly attemptedClass: LineageClass) {
    super(
      `refusing to fold a '${attemptedClass}' lineage into the qualifying metrics: ` +
        `the pure-MTL ablation's attempts / cost / latency / quality are isolated ` +
        `and never mixed into a qualifying (production / pilot) run's metrics`,
    );
    this.name = "AblationLineageIsolationError";
  }
}

/** A misuse of the ablation entrypoint — a request or a resolved policy that is
 * not the sanctioned null-Wiki pure-MTL ablation. Thrown by `./policy.ts` when
 * the composed run-policy did not land on the `pure-mtl-ablation` basis. */
export class AblationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AblationPolicyError";
  }
}
