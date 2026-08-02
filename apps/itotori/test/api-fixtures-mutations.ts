import type {
  ApiDraftBranchRequest,
  ApiDraftBranchResponse,
  ApiErrorResponse,
  ApiProjectImportRequest,
  ApiProjectImportResponse,
  ApiRecordBenchmarkRequest,
  ApiRecordBenchmarkResponse,
  ApiRecordFindingRequest,
  ApiRecordFindingResponse,
  ApiRuntimeEvidenceRequest,
  ApiRuntimeEvidenceResponse,
  ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  benchmarkReportFixture,
  bridgeFixture,
  findingRecordFixture,
  projectFixture,
  runtimeIngestResultFixture,
  runtimeReportFixture,
} from "./api-fixtures-project.js";
import { dashboardStatusFixture } from "./api-fixtures-dashboard.js";

export const bridgeImportRequestFixture: ApiProjectImportRequest = {
  bridge: bridgeFixture,
};

export const bridgeImportResponseFixture: ApiProjectImportResponse = {
  project: projectFixture,
  status: dashboardStatusFixture,
};

export const draftBranchRequestFixture: ApiDraftBranchRequest = {
  project: projectFixture,
  targetLocale: "fr-FR",
};

export const draftBranchResponseFixture: ApiDraftBranchResponse = {
  outcome: "drafted",
  project: projectFixture,
  status: dashboardStatusFixture,
  refusalMessage: null,
};

export const recordFindingRequestFixture: ApiRecordFindingRequest = {
  localeBranchId: "locale-1",
  finding: findingRecordFixture,
};

export const recordFindingResponseFixture: ApiRecordFindingResponse = {
  findingId: findingRecordFixture.findingId,
  status: "open",
};

export const recordBenchmarkRequestFixture: ApiRecordBenchmarkRequest = {
  benchmarkReport: benchmarkReportFixture,
};

export const recordBenchmarkResponseFixture: ApiRecordBenchmarkResponse = {
  benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
  artifactId: benchmarkReportFixture.benchmarkRunId,
  status: benchmarkReportFixture.status,
  systemCount: benchmarkReportFixture.systemsCompared.length,
  findingCount: benchmarkReportFixture.findingRecords.length,
};

export const runtimeEvidenceIngestRequestFixture: ApiRuntimeEvidenceRequest = {
  project: projectFixture,
  runtimeReport: runtimeReportFixture,
};

export const runtimeEvidenceIngestResponseFixture: ApiRuntimeEvidenceResponse =
  runtimeIngestResultFixture;

/**
 * policy — the typed validation-failure response every project mutation
 * route emits when `parseXxxRequest` rejects the body (ApiValidationError →
 * 400 bad_request). The `error` message is the parser's, but the SHAPE is
 * stable across routes.
 */
export const apiMutationBadRequestResponseFixture: ApiErrorResponse = {
  error:
    "ApiProjectImportRequest: BridgeBundleV02.schemaVersion must be 0.2.0; follow the migration path",
  code: "bad_request",
};

/**
 * policy / policy — the typed permission / scoping-denial response
 * every project mutation route emits when either the permission gate
 * (AuthorizationError → 403 forbidden) or the server-side project/branch
 * ownership scope check (ProjectMutationScopeError → 403 forbidden) refuses
 * the mutation. The SHAPE is stable across routes.
 */
export const apiMutationForbiddenResponseFixture: ApiErrorResponse = {
  error: "user api-user-without-required-permission is missing permission project.import",
  code: "forbidden",
};

/**
 * policy — the per-route mutation contract surface. Each entry binds a
 * project mutation {@link ItotoriApiRouteId} to its MSW origin URL, its
 * request fixture (the SUCCESS body the api-schema parser MUST accept), and
 * its response fixture (the SUCCESS body `assertItotoriApiResponse` MUST
 * accept). The contract-drift tests iterate this surface so adding a NEW
 * project mutation route forces a matching fixture + drift test rather than
 * silently passing.
 */
export type ApiMutationContractEntry = {
  routeId: Extract<
    ItotoriApiRouteId,
    | "imports.bridge"
    | "branches.draft"
    | "findings.record"
    | "benchmarks.record"
    | "runtimeEvidence.ingest"
  >;
  /** MSW URL the dashboard / SPA mutation layer POSTs to. */
  url: string;
  /** Label used in the parser + asserter error expectations. */
  requestTypeName: string;
  /** A field the parser requires; dropping it must FAIL the request contract. */
  requiredRequestField: string;
  /** A field the response asserter requires; mutating it must FAIL the response contract. */
  requiredResponseField: string;
  /** Substring of the parser's error message when the request shape drifts. */
  parserErrorSubstring: string;
};

export const apiMutationContract: readonly ApiMutationContractEntry[] = [
  {
    routeId: "imports.bridge",
    url: "http://itotori.test/api/imports/bridge",
    requestTypeName: "ApiProjectImportRequest",
    requiredRequestField: "bridge",
    requiredResponseField: "project",
    // `parseRequest` wraps the inner `BridgeInput` asserter as
    // `"ApiProjectImportRequest: <inner>"`, so the substring keys on the
    // request type label (always present) rather than the field path.
    parserErrorSubstring: "ApiProjectImportRequest",
  },
  {
    routeId: "branches.draft",
    url: "http://itotori.test/api/projects/project-1/branches",
    requestTypeName: "ApiDraftBranchRequest",
    requiredRequestField: "targetLocale",
    requiredResponseField: "status",
    // `targetLocale` is a top-level scalar, so `assertString` includes the
    // full `"ApiDraftBranchRequest.targetLocale"` field path.
    parserErrorSubstring: "ApiDraftBranchRequest.targetLocale",
  },
  {
    routeId: "findings.record",
    url: "http://itotori.test/api/projects/project-1/findings",
    requestTypeName: "ApiRecordFindingRequest",
    requiredRequestField: "finding",
    requiredResponseField: "findingId",
    parserErrorSubstring: "ApiRecordFindingRequest",
  },
  {
    routeId: "benchmarks.record",
    url: "http://itotori.test/api/projects/project-1/benchmarks",
    requestTypeName: "ApiRecordBenchmarkRequest",
    requiredRequestField: "benchmarkReport",
    requiredResponseField: "benchmarkRunId",
    parserErrorSubstring: "ApiRecordBenchmarkRequest",
  },
  {
    routeId: "runtimeEvidence.ingest",
    url: "http://itotori.test/api/projects/project-1/runtime-evidence",
    requestTypeName: "ApiRuntimeEvidenceRequest",
    requiredRequestField: "runtimeReport",
    requiredResponseField: "patchResultId",
    parserErrorSubstring: "ApiRuntimeEvidenceRequest",
  },
] as const;
