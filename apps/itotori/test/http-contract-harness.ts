// fe-http-contract-harness — the code-agnostic REAL-HTTP /api contract harness.
//
// Black-boxes the Itotori `/api` surface over a REAL loopback socket: the
// harness boots `createItotoriServer` on an ephemeral `127.0.0.1` port and
// drives requests with the global `fetch` (NOT Supertest, and NOT a direct
// `handleItotoriApiRequest` call). Driving the native `node:http` server over
// the wire is the behavior-first / code-agnostic mandate
// ([[feedback_behavior_first_code_agnostic_testing]]): the test observes the
// same status line / headers / JSON body an external client (curl, the SPA,
// OpenAPI consumers) observes, so a contract change at the transport boundary
// is caught here instead of silently diverging from the white-box handler
// tests.
//
// The harness is generic over the service factory: by default it boots the
// server with a deterministic FIXTURE-backed `ItotoriServiceFactory`
// (`fixtureServiceFactory`) so the contract suite is hermetic + deterministic
// (no network, no DB). A Postgres-backed smoke variant
// (`withDatabaseHttpContractHarness`) boots the server against the real
// DB-backed services so the wire contract is also exercised end-to-end where
// the repository layer matters (gated on `DATABASE_URL`, so it skips in the
// fixture-only lane).
//
// Contract assertion reuses the existing api-schema authority
// (`assertItotoriApiResponse` / `assertItotoriApiErrorResponse`): the route id
// resolves both the HTTP method + path (via `ITOTORI_API_ROUTES`) AND the typed
// response body asserter, so a single `httpRequest(routeId)` + `assertOk`
// call pins status + content-type + the full body contract in one shot.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Ajv, { type ValidateFunction } from "ajv";
import { expect, vi } from "vitest";
import type { Permission } from "@itotori/db";
import {
  assertItotoriApiResponse,
  assertItotoriApiErrorResponse,
  type ApiErrorResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  ITOTORI_API_ROUTES,
  interpolateRoutePath,
  jsonSchemaForApiError,
  jsonSchemaForRoute,
} from "../src/api-contract.js";
import { createItotoriServer, type DashboardServerOptions } from "../src/server.js";
import type {
  ItotoriReadOnlyServiceFactory,
  ItotoriServiceFactory,
} from "../src/services/database-services.js";
import {
  bmkCockpitFixture,
  bmkCockpitHistoryFixture,
  benchmarkReportsFixture,
  branchPolicySettingsFixture,
  catalogBenchmarkSeedsFixture,
  catalogCompletenessFixture,
  catalogConflictReviewFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  jobsRunTableFixture,
  modelRoutingSettingsFixture,
  projectOverviewFixture,
  projectFixture,
  runtimeStatusFixture,
  terminologySearchFixture,
  wikiEntriesFixture,
} from "./api-fixtures.js";
import {
  workspaceAssetBrowseFixture,
  workspaceComparisonFixture,
  workspaceProjectBrowseFixture,
  workspaceSceneBrowseFixture,
  workspaceSearchFixture,
} from "../src/workspace/fixtures.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * The full wire result a black-box /api request resolves to. `body` is the
 * parsed JSON value when the response carries an `application/json`
 * content-type (every `/api` route does, including the typed error bodies),
 * otherwise the raw response text (non-api paths). Asserters narrow `body`
 * against the route's typed contract.
 */
export type HttpContractResult = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
};

/**
 * The first argument to {@link HttpContractHarness.httpRequest}: either a
 * {@link ItotoriApiRouteId} (resolved to method + path via the route table, so
 * the contract asserter can also key off it) OR a raw path string starting
 * with `/` (the raw-path escape hatch for routes the table does not own, e.g.
 * a probe for an unknown path).
 */
export type HttpTarget = ItotoriApiRouteId | (string & {});

export type HttpContractRequestInit = {
  /** Overrides the route-table method (defaults to the route's method or GET). */
  readonly method?: string;
  /** Path params interpolated into a parameterized route's path template. */
  readonly params?: Readonly<Record<string, string>>;
  /** URL query params; `undefined` values are omitted. */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON request body; serialized with `content-type: application/json`. */
  readonly body?: unknown;
  /** Raw request body string (takes precedence over `body`); no content-type is set automatically. */
  readonly rawBody?: string;
  /** Extra request headers. */
  readonly headers?: Readonly<Record<string, string>>;
};

export type HttpContractHarness = {
  /** The booted server's loopback origin (`http://127.0.0.1:<ephemeral-port>`). */
  readonly origin: string;
  /** The underlying `node:http` Server (for advanced lifecycle control). */
  readonly server: Server;
  /**
   * Drive a black-box HTTP request against the booted server with `fetch`.
   * When `target` is a known {@link ItotoriApiRouteId}, the route table
   * supplies the method + path (and the same id drives the contract asserter);
   * otherwise `target` is treated as a raw path.
   */
  httpRequest(target: HttpTarget, init?: HttpContractRequestInit): Promise<HttpContractResult>;
  /** Tear the loopback server down (rejects if the server cannot close). */
  close(): Promise<void>;
};

export type HttpContractHarnessOptions = Omit<DashboardServerOptions, "port">;

/**
 * Boot the Itotori dashboard server on an ephemeral loopback port and return a
 * {@link HttpContractHarness} that drives `/api` requests with `fetch`.
 *
 * Defaults to the deterministic fixture-backed service factory
 * ({@link fixtureServiceFactory}); pass a `serviceFactory` (e.g. a Postgres
 * one) to boot against a different service layer. The caller MUST `close()` the
 * harness (typically in a `finally`) so the ephemeral port is released.
 */
export async function startHttpContractHarness(
  options: HttpContractHarnessOptions = {},
): Promise<HttpContractHarness> {
  const server = createItotoriServer({
    serviceFactory: fixtureServiceFactory,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://${address.address}:${address.port}`;
  return {
    origin,
    server,
    httpRequest: (target, init) => driveFetch(origin, target, init),
    close: () => closeServer(server),
  };
}

/**
 * Boot a Postgres-backed contract harness: the server uses the real
 * DB-backed `ItotoriServiceFactory` (`withDatabaseItotoriServices`), so the
 * `/api` wire contract is exercised end-to-end through the repository layer.
 *
 * The caller supplies the resolved `databaseUrl` (gated by the test on
 * `process.env.DATABASE_URL` so the fixture-only lane skips it). `close()`
 * tears the server down; the caller owns the DB container lifecycle
 * (`just db-up` / `just db-down`).
 */
export async function startPostgresHttpContractHarness(options: {
  databaseUrl: string;
  harnessOptions?: HttpContractHarnessOptions;
}): Promise<HttpContractHarness> {
  const serviceFactory: ItotoriServiceFactory = (callback) =>
    createDbServiceFactory(options.databaseUrl, callback);
  return startHttpContractHarness({ serviceFactory, ...options.harnessOptions });
}

async function createDbServiceFactory<T>(
  databaseUrl: string,
  callback: (
    services: import("../src/services/database-services.js").ItotoriApplicationServices,
  ) => Promise<T>,
): Promise<T> {
  const { withDatabaseItotoriServices } = await import("../src/services/database-services.js");
  return withDatabaseItotoriServices({ databaseUrl, bootstrapLocalUser: true }, (services) =>
    callback(services),
  );
}

async function driveFetch(
  origin: string,
  target: HttpTarget,
  init: HttpContractRequestInit = {},
): Promise<HttpContractResult> {
  const routeId = resolveRouteId(target);
  const method = init.method ?? (routeId === null ? "GET" : ITOTORI_API_ROUTES[routeId].method);
  const pathname =
    routeId === null ? (target as string) : interpolateRoutePath(routeId, init.params);
  const response = await fetch(
    buildUrl(origin, pathname, init.query),
    buildFetchInit(method, init),
  );
  const body = await parseResponseBody(response.headers.get("content-type"), response);
  return { status: response.status, headers: response.headers, body };
}

function buildFetchInit(method: string, init: HttpContractRequestInit): RequestInit {
  const requestInit: RequestInit = { method };
  const body = serializeBody(init);
  if (body !== undefined) {
    requestInit.body = body;
  }
  const headers = buildHeaders(init);
  if (headers !== undefined) {
    requestInit.headers = headers;
  }
  return requestInit;
}

function resolveRouteId(target: HttpTarget): ItotoriApiRouteId | null {
  if (typeof target !== "string" || !ROUTE_IDS.has(target)) {
    return null;
  }
  return target as ItotoriApiRouteId;
}

function buildUrl(
  origin: string,
  pathname: string,
  query: HttpContractRequestInit["query"],
): string {
  if (query === undefined) {
    return `${origin}${pathname}`;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search.length === 0 ? `${origin}${pathname}` : `${origin}${pathname}?${search}`;
}

function serializeBody(init: HttpContractRequestInit): string | undefined {
  if (init.rawBody !== undefined) {
    return init.rawBody;
  }
  if (init.body !== undefined) {
    return JSON.stringify(init.body);
  }
  return undefined;
}

function buildHeaders(init: HttpContractRequestInit): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined && init.rawBody === undefined) {
    headers["content-type"] = "application/json";
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

async function parseResponseBody(contentType: string | null, response: Response): Promise<unknown> {
  if (contentType !== null && contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Contract asserters
// ---------------------------------------------------------------------------

export type HttpContractOkOptions = {
  /** Expected status (defaults to 200). */
  readonly status?: number;
};

/**
 * Assert the black-box wire contract for a SUCCESSFUL route response: the
 * status line (default 200), the `application/json` content-type, AND the full
 * typed body contract (via `assertItotoriApiResponse`). A shape change at the
 * transport boundary (a renamed field, a narrowed enum, a dropped
 * `content-type`) fails here instead of silently diverging.
 */
export function assertHttpContractOk<RouteId extends ItotoriApiRouteId>(
  routeId: RouteId,
  result: HttpContractResult,
  options: HttpContractOkOptions = {},
): asserts result is HttpContractResult & { body: ItotoriApiResponseBody } {
  const expectedStatus = options.status ?? 200;
  expect(result.status, `${routeId} wire status`).toBe(expectedStatus);
  expect(result.headers.get("content-type"), `${routeId} content-type`).toContain(
    "application/json",
  );
  assertItotoriApiResponse(routeId, result.body);
  // fe-api-openapi-emit: also pin the response against the emitted wire contract.
  assertBodyMatchesEmittedSchema(routeId, result.body);
}

export type HttpContractErrorOptions = {
  readonly status?: number;
  readonly code?: ApiErrorResponse["code"];
};

/**
 * Assert the black-box wire contract for a typed ERROR response: the status
 * line, the `application/json` content-type, AND the typed `ApiErrorResponse`
 * shape (`error` string + `code` enum) via `assertItotoriApiErrorResponse`.
 */
export function assertHttpContractError(
  result: HttpContractResult,
  options: HttpContractErrorOptions = {},
): asserts result is HttpContractResult & { body: ApiErrorResponse } {
  if (options.status !== undefined) {
    expect(result.status, "error wire status").toBe(options.status);
  }
  expect(result.headers.get("content-type"), "error content-type").toContain("application/json");
  assertItotoriApiErrorResponse(result.body);
  // fe-api-openapi-emit: also pin the error body against the emitted wire contract.
  assertBodyMatchesEmittedErrorSchema(result.body);
  if (options.code !== undefined) {
    expect((result.body as ApiErrorResponse).code, "error code").toBe(options.code);
  }
}

// ---------------------------------------------------------------------------
// Route table — the SINGLE authority (`ITOTORI_API_ROUTES` in `src/api-contract`)
// binds each ItotoriApiRouteId to its method + path template. The same registry
// feeds the emitted OpenAPI + JSON-Schema contract, so the harness drives real
// requests off the exact topology the wire contract publishes.
// ---------------------------------------------------------------------------

const ROUTE_IDS: ReadonlySet<string> = new Set(Object.keys(ITOTORI_API_ROUTES));

// ---------------------------------------------------------------------------
// Emitted-JSON-Schema validation — the harness validates every real response
// body against the emitted contract (fe-api-openapi-emit) IN ADDITION to the
// api-schema guard, so the black-box tests pin the published wire contract.
// ---------------------------------------------------------------------------

const schemaAjv = new Ajv({ strict: false, allErrors: true });
const responseValidators = new Map<ItotoriApiRouteId, ValidateFunction>();
let errorValidator: ValidateFunction | undefined;

function responseSchemaValidator(routeId: ItotoriApiRouteId): ValidateFunction {
  const cached = responseValidators.get(routeId);
  if (cached !== undefined) {
    return cached;
  }
  const schema = jsonSchemaForRoute(routeId, "response");
  if (schema === null) {
    throw new Error(`route ${routeId} has no response schema`);
  }
  const validate = schemaAjv.compile(schema as object);
  responseValidators.set(routeId, validate);
  return validate;
}

function assertBodyMatchesEmittedSchema(routeId: ItotoriApiRouteId, body: unknown): void {
  const validate = responseSchemaValidator(routeId);
  expect(
    validate(body),
    `${routeId} response body violates the emitted JSON-Schema: ${schemaAjv.errorsText(
      validate.errors,
    )}`,
  ).toBe(true);
}

function assertBodyMatchesEmittedErrorSchema(body: unknown): void {
  if (errorValidator === undefined) {
    errorValidator = schemaAjv.compile(jsonSchemaForApiError() as object);
  }
  expect(
    errorValidator(body),
    `error body violates the emitted JSON-Schema: ${schemaAjv.errorsText(errorValidator.errors)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Deterministic fixture-backed service factory.
// ---------------------------------------------------------------------------

const grantAllPermissions = vi.fn<(permission: Permission) => Promise<void>>(async () => {});

const unused = () => {
  throw new Error("not used by the contract harness");
};

/**
 * The stable, module-level fixture service surface. Built ONCE so every
 * request the harness drives flows through the SAME mock instances — tests can
 * assert transport-level invariants (e.g. a mutation hit the permission gate,
 * a read forwarded to the right service method) via the exposed spies without
 * per-request mock churn.
 */
const fixtureServices = {
  authorization: {
    requirePermission: grantAllPermissions,
  },
  projectWorkflow: {
    reset: vi.fn(async () => {}),
    listLocaleBranchIdentities: vi.fn(async () => []),
    getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
    getProjectOverview: vi.fn(async () => projectOverviewFixture),
    getDashboardDecisions: vi.fn(async () => dashboardDecisionsFixture),
    getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
    getCostReport: vi.fn(async () => costReportFixture),
    getCostDrilldown: vi.fn(async () => costDrilldownFixture),
    getBenchmarkReports: vi.fn(async () => benchmarkReportsFixture),
    importBridge: vi.fn(async () => projectFixture),
    draftProject: vi.fn(unused),
    ingestRuntimeReport: vi.fn(unused),
    ingestPatchResult: vi.fn(unused),
    ingestConformanceReport: vi.fn(unused),
    recordFinding: vi.fn(unused),
    recordDecision: vi.fn(unused),
    recordBenchmarkReport: vi.fn(unused),
    launchNextLocalizationPass: vi.fn(unused),
  },
  manualFeedback: {
    importManualFeedback: vi.fn(unused),
  },
  catalogRepository: {
    catalogConflictReview: vi.fn(async () => catalogConflictReviewFixture),
    catalogCompletenessBenchmarkPools: vi.fn(async () => catalogCompletenessFixture),
    catalogBenchmarkSeedFinder: vi.fn(async () => catalogBenchmarkSeedsFixture),
    catalogOpportunityRanking: vi.fn(async () => catalogOpportunitiesFixture),
  },
  terminologyRepository: {
    searchTerms: vi.fn(async () => terminologySearchFixture),
  },
  wikiRepository: {
    loadEntries: vi.fn(async () => wikiEntriesFixture),
  },
  reviewerQueue: {
    loadDashboard: vi.fn(unused),
    loadDetailContext: vi.fn(unused),
  },
  workspace: {
    loadProjectBrowse: vi.fn(async ({ permission }) => ({
      ...workspaceProjectBrowseFixture(),
      permission,
    })),
    loadSceneBrowse: vi.fn(async ({ projectId, localeBranchId, permission }) => ({
      ...workspaceSceneBrowseFixture(),
      projectId,
      localeBranchId,
      permission,
    })),
    loadAssetBrowse: vi.fn(async ({ projectId, localeBranchId, permission }) => ({
      ...workspaceAssetBrowseFixture(),
      projectId,
      localeBranchId,
      permission,
    })),
    loadComparison: vi.fn(async ({ reviewItemId, permission }) => ({
      ...workspaceComparisonFixture(),
      reviewItemId,
      permission,
    })),
    loadSearch: vi.fn(async ({ projectId, localeBranchId, query, mode, offset, permission }) => ({
      ...workspaceSearchFixture(),
      projectId,
      localeBranchId,
      query,
      mode: mode ?? "all",
      pagination: { ...workspaceSearchFixture().pagination, offset: offset ?? 0 },
      permission,
    })),
  },
  workspaceCorrections: {
    loadPreview: vi.fn(unused),
    submitCorrections: vi.fn(unused),
  },
  assetDecisions: {
    loadActiveDecisions: vi.fn(unused),
    loadCandidateAssets: vi.fn(unused),
  },
  queueHealth: {
    loadQueueHealth: vi.fn(unused),
  },
  jobs: {
    loadRunTable: vi.fn(async () => jobsRunTableFixture),
  },
  benchmarkCockpit: {
    loadCockpit: vi.fn(async () => bmkCockpitFixture),
    loadHistory: vi.fn(async () => bmkCockpitHistoryFixture),
  },
  modelRouting: {
    loadSettings: vi.fn(async (projectId: string) => ({
      ...modelRoutingSettingsFixture,
      projectId,
      generatedAt: new Date(modelRoutingSettingsFixture.generatedAt),
      routes: modelRoutingSettingsFixture.routes.map((route) => ({
        ...route,
        updatedAt: new Date(route.updatedAt),
      })),
    })),
    saveRoute: vi.fn(unused),
  },
  branchPolicy: {
    loadSettings: vi.fn(async (input: { projectId: string; localeBranchId: string }) => ({
      ...branchPolicySettingsFixture,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    })),
    saveSettings: vi.fn(unused),
  },
  playRouteMap: {
    loadRouteMap: vi.fn(async (input: { projectId: string; localeBranchId: string }) => ({
      schemaVersion: "itotori.play.route-map.v0" as const,
      generatedAt: "2026-07-08T00:00:00.000Z",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      nodes: [],
      edges: [],
      counts: { fresh: 0, stale: 0, total: 0, choiceCount: 0 },
    })),
  },
  authMembers: {
    listMembers: vi.fn(async (accountId: string) => [
      {
        membershipId: "membership-contract",
        accountId,
        userId: "user-contract-member",
        principalId: "principal-contract-member",
        email: "member@example.test",
        displayName: "Contract Member",
        permissionSetIds: ["permission-set-account-local-reviewer"],
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
      },
    ]),
    inviteMember: vi.fn(
      async (input: {
        accountId: string;
        email: string;
        initialPermissionSetIds: readonly string[];
        expiresAt: string;
      }) => ({
        invitationId: "invitation-contract",
        accountId: input.accountId,
        email: input.email,
        initialPermissionSetIds: [...input.initialPermissionSetIds],
        expiresAt: new Date(input.expiresAt),
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
      }),
    ),
    acceptInvitation: vi.fn(
      async (
        _invitationId: string,
        input: {
          userId: string;
          principalId: string;
          email: string;
          displayName: string;
        },
      ) => ({
        membershipId: "membership-contract",
        accountId: "account-local",
        userId: input.userId,
        principalId: input.principalId,
        email: input.email,
        displayName: input.displayName,
        permissionSetIds: ["permission-set-account-local-reviewer"],
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
      }),
    ),
    removeMember: vi.fn(async (membershipId: string) => ({
      membershipId,
      accountId: "account-local",
      userId: "user-contract-member",
      principalId: "principal-contract-member",
      email: "member@example.test",
      displayName: "Contract Member",
      permissionSetIds: ["permission-set-account-local-reviewer"],
      createdAt: new Date("2026-07-08T00:00:00.000Z"),
    })),
  },
  authBilling: {
    loadSeatUsage: vi.fn(async (accountId: string) => ({
      accountId,
      planId: "studio-team",
      planName: "Studio Team",
      billingPeriod: "monthly" as const,
      seatLimit: 5,
      includedSeats: 5,
      usedSeats: 1,
      pendingInvitations: 0,
      availableSeats: 4,
      overSeatLimit: false,
      updatedAt: new Date("2026-07-08T00:00:00.000Z"),
    })),
  },
  authIdentity: {
    loadIdentity: vi.fn(async () => ({
      actorUserId: "local-user",
      userId: "local-operator",
      principalId: "principal-local-operator",
      email: null,
      displayName: "Local operator",
      accounts: [
        {
          membershipId: "membership-local-operator",
          accountId: "account-local",
          accountSlug: "local",
          accountName: "Local workspace",
          permissionSetIds: ["permission-set-account-local-operator-all"],
          createdAt: new Date("2026-07-08T00:00:00.000Z"),
        },
      ],
    })),
  },
} as const;

type FixtureServices = import("../src/services/database-services.js").ItotoriApplicationServices;

/**
 * Build the deterministic FIXTURE-backed service factory the contract harness
 * boots by default. Each read-model route resolves to its committed
 * `api-fixtures` value (so the body contract asserts against a stable shape),
 * and the permission gate is a no-op that grants every permission (so the
 * full-detail — never redacted — body is returned, exactly the wire contract a
 * privileged client sees). Routes not covered by a fixture are stubbed to
 * throw; inject a custom `serviceFactory` to cover them.
 */
export function fixtureServiceFactory<T>(
  callback: (services: FixtureServices) => Promise<T>,
): Promise<T> {
  return callback(fixtureServices as unknown as FixtureServices);
}

/**
 * Reset the fixture factory's mock call history between tests (so a test that
 * asserts `expect(...).toHaveBeenCalled*` is not polluted by a prior test).
 */
export function resetFixtureServiceFactoryMocks(): void {
  vi.clearAllMocks();
}

/**
 * The fixture-backed permission gate spy. Contract tests assert the transport
 * still flows mutations through the permission gate (e.g. the import mutation
 * hits `project.import`) via this spy.
 */
export const fixtureRequirePermission = grantAllPermissions;

/**
 * The fixture-backed workflow surface (read models + the import mutation).
 * Exposed so contract tests can assert the transport reached the intended
 * service method (e.g. `importBridge` was called with the posted bridge).
 */
export const fixtureProjectWorkflow = fixtureServices.projectWorkflow;

export type { ItotoriReadOnlyServiceFactory };
