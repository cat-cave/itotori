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
  // itotori-043-followup-transport-level-readonly-routing — GET (read-only)
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
  const browserPlayerLaunches = options.browserPlayerLaunches ?? browserPlayerLaunchesFromEnv();
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
        // itotori-043-followup-transport-level-readonly-routing — dispatch by
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
        const statusCode =
          error instanceof SyntaxError
            ? 400
            : error instanceof ItotoriInvalidAuthSessionError
              ? 403
              : 500;
        const code =
          error instanceof SyntaxError
            ? "bad_request"
            : error instanceof ItotoriInvalidAuthSessionError
              ? "forbidden"
              : "internal_error";
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            code,
          }),
        );
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
  return options.databaseUrl === undefined
    ? { bootstrapLocalUser: false }
    : { databaseUrl: options.databaseUrl, bootstrapLocalUser: false };
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

function browserPlayerLaunchesFromEnv(): BrowserPlayerLaunchRegistry {
  const seenPath = process.env.ITOTORI_PLAYER_E2E_SEEN;
  const gameexePath = process.env.ITOTORI_PLAYER_E2E_GAMEEXE;
  const g00Dir = process.env.ITOTORI_PLAYER_E2E_G00_DIR;
  const artifactRoot = process.env.ITOTORI_PLAYER_E2E_ARTIFACT_ROOT;
  const scene = Number(process.env.ITOTORI_PLAYER_E2E_SCENE ?? "");
  if (
    seenPath === undefined ||
    gameexePath === undefined ||
    g00Dir === undefined ||
    artifactRoot === undefined ||
    seenPath.trim() === "" ||
    gameexePath.trim() === "" ||
    g00Dir.trim() === "" ||
    artifactRoot.trim() === "" ||
    !Number.isInteger(scene)
  ) {
    return {};
  }
  return {
    [process.env.ITOTORI_PLAYER_E2E_SESSION_ID ?? "e2e"]: {
      seenPath,
      gameexePath,
      g00Dir,
      artifactRoot,
      scene,
    },
  };
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

async function readFirstExistingStaticFile(path: string, roots: URL[]): Promise<Buffer | null> {
  for (const root of roots) {
    const safePath = safeStaticPath(path);
    if (safePath === null) {
      return null;
    }
    try {
      return await readFile(join(fileURLToPath(root), safePath));
    } catch {
      continue;
    }
  }
  return null;
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
