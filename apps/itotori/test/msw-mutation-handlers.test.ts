// @vitest-environment jsdom
//
// ITOTORI-051 — the project MUTATION contract test suite.
//
// The dashboard SPA mutation layer POSTs to project mutation routes
// (`imports.bridge`, `branches.draft`, `findings.record`,
// `benchmarks.record`, `runtimeEvidence.ingest`). Before ITOTORI-051 the MSW
// handler suite covered only the READ routes + the import workflow fixtures;
// a mutation API shape change (a renamed response field, a narrowed enum, a
// new required request field) would silently diverge between the mock and
// the real `handleItotoriApiRequest`.
//
// This file pins every project mutation route to the REAL api-schema
// contract via three orthogonal checks per route:
//
//   1. SUCCESS            — the MSW handler accepts a well-formed request
//                           fixture and returns a 200 body the route
//                           asserter (`assertItotoriApiResponse`) accepts.
//   2. VALIDATION FAILURE — a malformed request body is rejected by the
//                           SAME api-schema parser the real handler uses,
//                           AND the typed `bad_request` error response
//                           shape every mutation emits is contract-valid.
//   3. PERMISSION DENIAL  — the typed `forbidden` error response shape every
//                           mutation emits (permission gate OR the
//                           ITOTORI-050 server-side ownership scope refusal)
//                           is contract-valid.
//
// Plus a contract-DRIFT test per route: a deliberate response shape change
// FAILS `apiJson(...)` (mirrors the read-route drift pattern in
// `dashboard.test.ts`). The final `describe` block is the literal
// acceptance-criterion demo: "a mutation API shape change fails a dashboard
// contract test instead of silently diverging".
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import {
  assertItotoriApiResponse,
  parseDraftBranchRequest,
  parseProjectImportRequest,
  parseRecordBenchmarkRequest,
  parseRecordFindingRequest,
  parseRuntimeEvidenceRequest,
} from "../src/api-schema.js";
import {
  apiMutationBadRequestResponseFixture,
  apiMutationContract,
  apiMutationForbiddenResponseFixture,
  bridgeImportRequestFixture,
  bridgeImportResponseFixture,
  draftBranchRequestFixture,
  draftBranchResponseFixture,
  recordBenchmarkRequestFixture,
  recordBenchmarkResponseFixture,
  recordFindingRequestFixture,
  recordFindingResponseFixture,
  runtimeEvidenceIngestRequestFixture,
  runtimeEvidenceIngestResponseFixture,
  type ApiMutationContractEntry,
} from "./api-fixtures.js";
import {
  apiErrorJson,
  apiJson,
  itotoriProjectMutationMswHandlers,
  itotoriProjectMutationPermissionDeniedMswHandlers,
  itotoriProjectMutationValidationFailureMswHandlers,
} from "./msw-handlers.js";

const server = setupServer(...itotoriProjectMutationMswHandlers);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

type MutationCase = {
  request: unknown;
  response: unknown;
  parser: (body: unknown) => unknown;
};

function mutationCase(routeId: ApiMutationContractEntry["routeId"]): MutationCase {
  switch (routeId) {
    case "imports.bridge":
      return {
        request: bridgeImportRequestFixture,
        response: bridgeImportResponseFixture,
        parser: parseProjectImportRequest,
      };
    case "branches.draft":
      return {
        request: draftBranchRequestFixture,
        response: draftBranchResponseFixture,
        parser: parseDraftBranchRequest,
      };
    case "findings.record":
      return {
        request: recordFindingRequestFixture,
        response: recordFindingResponseFixture,
        parser: parseRecordFindingRequest,
      };
    case "benchmarks.record":
      return {
        request: recordBenchmarkRequestFixture,
        response: recordBenchmarkResponseFixture,
        parser: parseRecordBenchmarkRequest,
      };
    case "runtimeEvidence.ingest":
      return {
        request: runtimeEvidenceIngestRequestFixture,
        response: runtimeEvidenceIngestResponseFixture,
        parser: parseRuntimeEvidenceRequest,
      };
  }
}

function malformedRequestBody(entry: ApiMutationContractEntry): unknown {
  const { request } = mutationCase(entry.routeId);
  const copy: Record<string, unknown> = { ...(request as Record<string, unknown>) };
  delete copy[entry.requiredRequestField];
  return copy;
}

function driftedResponseBody(entry: ApiMutationContractEntry): unknown {
  const { response } = mutationCase(entry.routeId);
  const copy: Record<string, unknown> = { ...(response as Record<string, unknown>) };
  delete copy[entry.requiredResponseField];
  return copy;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ITOTORI-051 MSW project mutation contract handlers", () => {
  describe("SUCCESS — every project mutation route returns a contract-valid success body", () => {
    it.each(apiMutationContract)(
      "$routeId — POSTs the success request fixture and returns 200 + an asserter-valid body",
      async (entry) => {
        const { request } = mutationCase(entry.routeId);

        const response = await postJson(entry.url, request);

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(() => assertItotoriApiResponse(entry.routeId, body)).not.toThrow();
      },
    );

    it.each(apiMutationContract)(
      "$routeId — the success fixture itself passes the route asserter",
      (entry) => {
        const { response } = mutationCase(entry.routeId);

        expect(() => apiJson(entry.routeId, response as never)).not.toThrow();
      },
    );
  });

  describe("TYPED VALIDATION FAILURE — a malformed request body is rejected and the typed bad_request response is contract-valid", () => {
    it.each(apiMutationContract)(
      "$routeId — the api-schema parser rejects a body missing $requiredRequestField",
      (entry) => {
        const { parser } = mutationCase(entry.routeId);

        expect(() => parser(malformedRequestBody(entry))).toThrow(entry.parserErrorSubstring);
      },
    );

    it.each(apiMutationContract)(
      "$routeId — the validation-failure MSW handler returns 400 + a contract-valid bad_request body",
      async (entry) => {
        // The validation-failure handlers parse the SUCCESS request fixture
        // (proving the fixture parses cleanly) and then return the shared
        // typed bad_request response shape every mutation emits when the
        // parser rejects a body.
        server.use(...itotoriProjectMutationValidationFailureMswHandlers);
        const { request } = mutationCase(entry.routeId);

        const response = await postJson(entry.url, request);

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body).toEqual(apiMutationBadRequestResponseFixture);
        // The shared error-response shape is contract-valid on its own.
        expect(() => apiErrorJson(apiMutationBadRequestResponseFixture, 400)).not.toThrow();
      },
    );
  });

  describe("PERMISSION / SCOPING DENIAL — a refused mutation surfaces as a typed forbidden response", () => {
    it.each(apiMutationContract)(
      "$routeId — the denial MSW handler returns 403 + a contract-valid forbidden body",
      async (entry) => {
        // The denial handlers model BOTH ITOTORI-050 refusal paths: a missing
        // permission (AuthorizationError → 403 forbidden) AND a server-side
        // project/branch ownership scope refusal (ProjectMutationScopeError
        // → 403 forbidden). Both surface as the SAME typed error shape.
        server.use(...itotoriProjectMutationPermissionDeniedMswHandlers);
        const { request } = mutationCase(entry.routeId);

        const response = await postJson(entry.url, request);

        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body).toEqual(apiMutationForbiddenResponseFixture);
        expect(() => apiErrorJson(apiMutationForbiddenResponseFixture, 403)).not.toThrow();
      },
    );
  });

  describe("contract DRIFT — a mutation API shape change fails the route asserter", () => {
    it.each(apiMutationContract)(
      "$routeId — a success response missing $requiredResponseField is REJECTED",
      (entry) => {
        // Mirrors the read-route drift pattern in dashboard.test.ts:221. A
        // response body that drops a required field MUST fail the asserter,
        // so a mutation API shape change cannot silently diverge.
        expect(() => apiJson(entry.routeId, driftedResponseBody(entry) as never)).toThrow(
          entry.requiredResponseField,
        );
      },
    );

    it.each(apiMutationContract)(
      "$routeId — a typed error response with a drifted code is REJECTED",
      () => {
        // A mutated `code` enum value (e.g. a backend rename of
        // `bad_request` → `invalid`) MUST fail the error-response asserter.
        const drifted: Record<string, unknown> = {
          ...apiMutationBadRequestResponseFixture,
          code: "invalid_argument",
        };
        expect(() => apiErrorJson(drifted as never, 400)).toThrow("code");
      },
    );

    it.each(apiMutationContract)(
      "$routeId — a typed error response missing the error string is REJECTED",
      () => {
        const drifted: Record<string, unknown> = {
          code: "bad_request",
        };
        expect(() => apiErrorJson(drifted as never, 400)).toThrow("error");
      },
    );
  });

  // ITOTORI-051 acceptance — literal demo: a mutation API shape change FAILS
  // a dashboard contract test instead of silently diverging. The parameter-
  // drifted blocks above already prove this in bulk; this block is the
  // single, easy-to-point-at proof on a representative route (findings.record)
  // that also documents the revert contract (the original passes once the
  // drift is reverted).
  describe("mutation API shape change fails a dashboard contract test (literal demo)", () => {
    it("rejects a findings.record response with a drifted findingId and accepts the original", () => {
      // 1. The original SUCCESS fixture passes the asserter (the contract holds).
      expect(() => apiJson("findings.record", recordFindingResponseFixture)).not.toThrow();

      // 2. A deliberate shape change (the backend renames / drops / widens
      //    `findingId`) MUST fail the contract test. This is the silent-
      //    divergence guard ITOTORI-051 adds.
      const drifted: Record<string, unknown> = { ...recordFindingResponseFixture };
      delete drifted.findingId;
      expect(() => apiJson("findings.record", drifted as never)).toThrow("findingId");

      // 3. A status enum widening (a new value outside the contract) is also
      //    caught — the asserter keys on the typed enum, not a looser string.
      const widened: Record<string, unknown> = {
        ...recordFindingResponseFixture,
        status: "drafted",
      };
      expect(() => apiJson("findings.record", widened as never)).toThrow("status");

      // 4. Once the drift is reverted, the contract holds again.
      expect(() => apiJson("findings.record", recordFindingResponseFixture)).not.toThrow();
    });
  });
});
