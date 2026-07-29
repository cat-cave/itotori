export type ItotoriApiRouteId =
  | "assetDecisions.active"
  | "assetDecisions.candidates"
  | "catalog.benchmarkSeeds"
  | "catalog.contextPanel"
  | "catalog.completeness"
  | "catalog.conflicts"
  | "catalog.opportunities"
  | "terminology.search"
  | "wiki.list"
  | "wiki.show"
  | "wiki.history"
  | "wiki.edit"
  | "wiki.feedback"
  | "wiki.apply"
  | "projects.list"
  | "projects.overview"
  | "projects.status"
  | "projects.decisions"
  | "projects.cost"
  | "projects.costDrilldown"
  | "projects.benchmarks"
  | "jobs.runTable"
  | "runtime.status"
  | "queue.health"
  // p3-in-studio-decode-extract-trigger — run the REAL identify -> inventory ->
  // extract decode pipeline from a game source path/handle and return the
  // produced v0.2 bridge (replaces the manual bridge-JSON upload as the primary
  // Studio on-ramp). Gated on `project.import` — the same authority `imports.bridge`
  // carries, since it produces the same import artifact.
  | "projects.decodeExtract"
  | "imports.bridge"
  | "branches.draft"
  | "findings.record"
  | "benchmarks.record"
  | "runtimeEvidence.ingest"
  | "settings.modelRouting.get"
  | "settings.modelRouting.save"
  | "settings.branchPolicy.get"
  | "settings.branchPolicy.save"
  | "settings.translationScope.get"
  | "settings.translationScope.save"
  | "settings.localizationRunConfig.save"
  | "auth.ssoSettings.configure"
  | "auth.billing.seatUsage"
  | "auth.members.list"
  | "auth.members.invite"
  | "auth.members.accept"
  | "auth.members.remove"
  | "auth.permissionSets.list"
  | "auth.permissionSets.grant"
  | "auth.permissionSets.revoke"
  | "auth.sessions.list"
  | "auth.sessions.revoke"
  | "auth.identity"
  // fnd-caps-context — the actor's Studio capability permission VIEW
  // (canFlag / canSteer / canReveal), resolved from exact
  // permission grants via the auth-002 effective-permission resolver.
  | "auth.capabilities"
  // ovw-launch-pass-action — the Overview "launch next pass" mutation is
  // `canSteer`-gated (the `draft.write` steer permission).
  | "projects.launchPass"
  | "play.routeMap"
  // play-flag-composer — in-the-moment AnnotationComposer flag → canonical
  // context correction via ManualFeedbackImport (feedback.import / canFlag).
  | "play.flagAnnotation"
  // Unit-bound feedback retrieval — list notes for one bridge unit (same
  // ManualFeedbackImport ledger the flag composer writes).
  | "play.unitFeedback"
  | "play.addressableUnit"
  // p0-result-revision — a play tester replaces one delivered target line,
  // creating and selecting a child delivered patch revision.
  | "play.targetEdit"
  // p0-result-revision — inspect the selected delivered patch for a run.
  | "play.delivery"
  // planning-item — historical
  // version play surface, exact observed sessions, persisted feedback inbox,
  // and refinement launch all share the node-11 coordinator.
  | "patchIteration.versions"
  | "patchIteration.surface"
  | "patchIteration.delivery"
  | "patchIteration.play"
  | "patchIteration.feedbackBatch"
  | "patchIteration.feedback"
  | "patchIteration.refine";

export type ApiErrorResponse = {
  error: string;
  code:
    | "bad_request"
    | "forbidden"
    | "not_found"
    | "method_not_allowed"
    | "database_migrations_required"
    | "database_unreachable"
    | "internal_error";
};

export const API_ERROR_RESPONSE_CODES = [
  "bad_request",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "database_migrations_required",
  "database_unreachable",
  "internal_error",
] as const satisfies readonly ApiErrorResponse["code"][];
