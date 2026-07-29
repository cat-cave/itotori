import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { AuthorizationError } from "@itotori/db";
import {
  handleItotoriApiRequest,
  handleReadOnlyItotoriApiRequest,
  isItotoriApiPath,
} from "./api-handlers.js";
import {
  toReadOnlyServiceFactory,
  ItotoriInvalidAuthSessionError,
  withDatabaseItotoriServices,
  type ItotoriServiceFactory,
  type ItotoriReadOnlyServiceFactory,
} from "./services/database-services.js";
import { parseItotoriSessionCookie } from "./auth-session-cookie.js";
import { databaseUnreachableMessage } from "./database-unreachable.js";
import { isShellNavPath } from "./ui/shell-nav-routes.js";
import { assertPrivacyRetentionEgressContract } from "./contracts/privacy.js";
import { studioCapabilityPermissions } from "./auth.js";
import { serveArtifactStoreRequest } from "./artifact-store.js";
import { BrowserPlayerSessionManager } from "./play/browser-player-session.js";
import {
  isBrowserPlayerRoute,
  serveBrowserPlayerRequest,
  type BrowserPlayerLaunchRegistry,
} from "./play/browser-player-routes.js";
import { realliveBrowserPlayerLaunchFromInventory } from "./play/reallive-browser-player-launch.js";
import {
  isPatchbackProduceRoute,
  parsePatchIterationDeliveryArchiveRoute,
  parsePlayDeliveryArchiveRoute,
  servePatchbackProduceRequest,
  servePatchIterationDeliveryArchiveRequest,
  servePlayDeliveryArchiveRequest,
} from "./play/delivery-routes.js";

export type DashboardServerOptions = {
  databaseUrl?: string;
  port?: number;
  serviceFactory?: ItotoriServiceFactory;
  readOnlyServiceFactory?: ItotoriReadOnlyServiceFactory;
  webRoot?: URL;
  runtimeWebRoot?: URL;
  managedArtifactRoot?: URL;
  /** Full-fidelity files live here, never beneath `managedArtifactRoot`. */
  privateArtifactRoot?: URL;
  publicFixtureArtifactRoot?: URL;
  /** In-memory server-side engine sessions. Never persisted to the DB. */
  browserPlayerSessions?: BrowserPlayerSessionManager;
  /** Trusted descriptors installed by a local launcher, not HTTP callers. */
  browserPlayerLaunches?: BrowserPlayerLaunchRegistry;
};

export function createItotoriServer(options: DashboardServerOptions = {}) {
  assertPrivacyRetentionEgressContract();
  const webRoot = options.webRoot ?? new URL("../web-dist/", import.meta.url);
  const runtimeWebRoot =
    options.runtimeWebRoot ?? new URL("../../runtime-web-review/dist/", import.meta.url);
  const managedArtifactRoot =
    options.managedArtifactRoot ?? new URL("../../../artifacts/utsushi/runtime/", import.meta.url);
  const privateArtifactRoot =
    options.privateArtifactRoot ??
    new URL("../../../artifacts/utsushi/runtime.private-full/", import.meta.url);
  const publicFixtureArtifactRoot =
    options.publicFixtureArtifactRoot ?? new URL("../../../fixtures/public/", import.meta.url);
  const serviceFactory =
    options.serviceFactory ??
    ((callback, serviceOptions) =>
      withDatabaseItotoriServices({ ...databaseOptions(options), ...serviceOptions }, callback));
  // policy-followup-transport-level-readonly-routing — GET (read-only)
  // requests are served through the read-only service factory so a GET can
  // NEVER reach a mutation service: the factory hands the handler only the
  // narrowed read-only surface (`ItotoriReadOnlyApiServices`), which has no
  // mutation methods. The read-only factory is DERIVED from the full factory
  // (via `toReadOnlyServiceFactory`) so an injected `serviceFactory` (tests)
  // is narrowed consistently and the production default constructs the
  // read-only DB services directly. It may also be injected directly.
  const readOnlyServiceFactory =
    options.readOnlyServiceFactory ?? toReadOnlyServiceFactory(serviceFactory);
  const browserPlayerSessions = options.browserPlayerSessions ?? new BrowserPlayerSessionManager();
  const browserPlayerLaunches =
    options.browserPlayerLaunches ?? browserPlayerLaunchesFromInventory();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (isItotoriApiPath(url.pathname)) {
      if (isBrowserPlayerRoute(url.pathname)) {
        await serveBrowserPlayerRequest({
          request,
          response,
          pathname: url.pathname,
          sessions: browserPlayerSessions,
          launches: browserPlayerLaunches,
          canReveal: () => canReveal(request, readOnlyServiceFactory),
        });
        return;
      }
      const patchIterationDeliveryArchiveRoute = parsePatchIterationDeliveryArchiveRoute(
        url.pathname,
      );
      if (patchIterationDeliveryArchiveRoute !== null) {
        await servePatchIterationDeliveryArchiveRequest({
          request,
          response,
          patchVersionId: patchIterationDeliveryArchiveRoute.patchVersionId,
          readOnlyServiceFactory,
        });
        return;
      }
      const deliveryArchiveRoute = parsePlayDeliveryArchiveRoute(url.pathname);
      if (deliveryArchiveRoute !== null) {
        await servePlayDeliveryArchiveRequest({
          request,
          response,
          runId: deliveryArchiveRoute.runId,
          readOnlyServiceFactory,
        });
        return;
      }
      if (isPatchbackProduceRoute(url.pathname)) {
        await servePatchbackProduceRequest({
          request,
          response,
          serviceFactory,
          readJson: readJsonRequestBody,
        });
        return;
      }
      try {
        const body = await readJsonRequestBody(request);
        const method = request.method ?? "GET";
        const apiRequest = {
          method,
          pathname: url.pathname,
          search: url.search,
          body,
        };
        const sessionId = parseItotoriSessionCookie(request.headers.cookie);
        const serviceOptions = sessionId === undefined ? undefined : { sessionId };
        // policy-followup-transport-level-readonly-routing — dispatch by
        // HTTP method at the transport boundary: a GET runs through the
        // read-only factory + read-only handler (least-privilege, no mutation
        // surface); any other method runs through the full factory + full
        // handler, preserving the existing mutation routing and 405 behavior.
        const apiResponse =
          method === "GET"
            ? await readOnlyServiceFactory(
                (services) => handleReadOnlyItotoriApiRequest(apiRequest, services),
                serviceOptions,
              )
            : await serviceFactory(
                (services) => handleItotoriApiRequest(apiRequest, services),
                serviceOptions,
              );
        response.writeHead(apiResponse.statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(apiResponse.body));
      } catch (error) {
        const failure = apiFailureResponse(error, options.databaseUrl);
        response.writeHead(failure.statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(failure.body));
      }
      return;
    }

    if (url.pathname.startsWith("/artifact-store/")) {
      await serveArtifactStoreRequest({
        pathname: url.pathname,
        response,
        roots: { managedArtifactRoot, privateArtifactRoot, publicFixtureArtifactRoot },
        authorizeReveal: () => requireReveal(request, readOnlyServiceFactory),
      });
      return;
    }

    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const staticFile = await readFirstExistingStaticFile(path, [webRoot, runtimeWebRoot]);
    if (staticFile !== null) {
      response.writeHead(200, { "content-type": contentType(path) });
      response.end(staticFile);
      return;
    }

    if (isRuntimeDashboardRoute(url.pathname)) {
      const runtimeIndex = await readFirstExistingStaticFile("index.html", [runtimeWebRoot]);
      if (runtimeIndex !== null) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(runtimeIndex);
        return;
      }
    }

    if (isItotoriDashboardRoute(url.pathname)) {
      const itotoriIndex = await readFirstExistingStaticFile("index.html", [webRoot]);
      if (itotoriIndex !== null) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(itotoriIndex);
        return;
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  server.once("close", () => void browserPlayerSessions.closeAll());
  return server;
}

function apiFailureResponse(
  error: unknown,
  databaseUrl?: string,
): {
  statusCode: 400 | 403 | 500 | 503;
  body: { code: string; error: string };
} {
  if (error instanceof SyntaxError) {
    return { statusCode: 400, body: { code: "bad_request", error: error.message } };
  }
  if (error instanceof ItotoriInvalidAuthSessionError) {
    return { statusCode: 403, body: { code: "forbidden", error: error.message } };
  }
  if (hasPostgresErrorCode(error, "42P01") || hasPostgresErrorCode(error, "42703")) {
    return {
      statusCode: 500,
      body: {
        code: "database_migrations_required",
        error: "Database migrations are not applied. Run itotori db-migrate, then refresh.",
      },
    };
  }
  const databaseMessage = databaseUnreachableMessage(error, databaseUrl);
  if (databaseMessage !== null) {
    return { statusCode: 503, body: { code: "database_unreachable", error: databaseMessage } };
  }
  return {
    statusCode: 500,
    body: {
      code: "internal_error",
      error: "The service could not complete this request. Check the server logs and try again.",
    },
  };
}

function hasPostgresErrorCode(error: unknown, expectedCode: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string" && current.code === expectedCode) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  let rawBody = "";
  for await (const chunk of request) {
    rawBody += chunk;
  }
  if (rawBody.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(rawBody) as unknown;
}

function databaseOptions(options: DashboardServerOptions) {
  return options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl };
}

async function requireReveal(
  request: IncomingMessage,
  readOnlyServiceFactory: ItotoriReadOnlyServiceFactory,
): Promise<void> {
  const sessionId = parseItotoriSessionCookie(request.headers.cookie);
  await readOnlyServiceFactory(
    (services) => services.authorization.requirePermission(studioCapabilityPermissions.reveal),
    sessionId === undefined ? undefined : { sessionId },
  );
}

async function canReveal(
  request: IncomingMessage,
  readOnlyServiceFactory: ItotoriReadOnlyServiceFactory,
): Promise<boolean> {
  try {
    await requireReveal(request, readOnlyServiceFactory);
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}

function browserPlayerLaunchesFromInventory(): BrowserPlayerLaunchRegistry {
  const launch = realliveBrowserPlayerLaunchFromInventory();
  return launch === undefined ? {} : { e2e: launch };
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html";
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

export class StaticFileReadError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`failed to read static file ${path}`, { cause });
    this.name = "StaticFileReadError";
  }
}

export async function readFirstExistingStaticFile(
  path: string,
  roots: URL[],
): Promise<Buffer | null> {
  for (const root of roots) {
    const safePath = safeStaticPath(path);
    if (safePath === null) {
      return null;
    }
    const staticPath = join(fileURLToPath(root), safePath);
    try {
      return await readFile(staticPath);
    } catch (error) {
      if (isMissingStaticFile(error)) continue;
      throw new StaticFileReadError(staticPath, error);
    }
  }
  return null;
}

function isMissingStaticFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeStaticPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (isUnsafeRelativePath(decoded)) {
    return null;
  }
  return decoded;
}

function isUnsafeRelativePath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}

function isRuntimeDashboardRoute(pathname: string): boolean {
  return pathname === "/runtime" || pathname.startsWith("/runtime/");
}

function isItotoriDashboardRoute(pathname: string): boolean {
  return (
    /^\/projects\/[^/]+\/locale-branches\/[^/]+\/asset-decisions(?:\/batch)?$/u.test(pathname) ||
    // Every nav pill href and SPA deep-link root, from the SAME list the pills
    // and the command palette render. A pill navigates with a full page load,
    // so a surface missing here is a plain-text 404 behind its own nav button.
    // `/runtime/*` stays on the runtime-web document (isRuntimeDashboardRoute).
    isShellNavPath(pathname)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void import("./server-runtime.js")
    .then(({ startItotoriServer }) => startItotoriServer())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
