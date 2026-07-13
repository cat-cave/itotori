import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, relative, resolve, sep } from "node:path";
import { AuthorizationError } from "@itotori/db";
import {
  handleItotoriApiRequest,
  handleReadOnlyItotoriApiRequest,
  isItotoriApiPath,
} from "./api-handlers.js";
import {
  toReadOnlyServiceFactory,
  ItotoriInvalidAuthSessionError,
  startDatabaseContextCorrectionWorker,
  withDatabaseItotoriServices,
  type ItotoriServiceFactory,
  type ItotoriReadOnlyServiceFactory,
} from "./services/database-services.js";
import { parseItotoriSessionCookie } from "./auth-session-cookie.js";

export type DashboardServerOptions = {
  databaseUrl?: string;
  port?: number;
  serviceFactory?: ItotoriServiceFactory;
  readOnlyServiceFactory?: ItotoriReadOnlyServiceFactory;
  webRoot?: URL;
  runtimeWebRoot?: URL;
  managedArtifactRoot?: URL;
  publicFixtureArtifactRoot?: URL;
};

const dashboardListenHost = "127.0.0.1";
const managedRuntimeArtifactUriRoot = "artifacts/utsushi/runtime/";

export function createItotoriServer(options: DashboardServerOptions = {}) {
  const webRoot = options.webRoot ?? new URL("../web-dist/", import.meta.url);
  const runtimeWebRoot =
    options.runtimeWebRoot ?? new URL("../../runtime-web-review/dist/", import.meta.url);
  const managedArtifactRoot =
    options.managedArtifactRoot ?? new URL("../../../artifacts/utsushi/runtime/", import.meta.url);
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
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (isItotoriApiPath(url.pathname)) {
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
      await serveArtifactStoreRequest(url.pathname, response, {
        managedArtifactRoot,
        publicFixtureArtifactRoot,
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
}

async function servePatchIterationDeliveryArchiveRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  patchVersionId: string;
  readOnlyServiceFactory: ItotoriReadOnlyServiceFactory;
}): Promise<void> {
  if (input.request.method !== "GET") {
    writeApiError(input.response, 405, "method_not_allowed", "method must be GET");
    return;
  }
  try {
    const sessionId = parseItotoriSessionCookie(input.request.headers.cookie);
    const serviceOptions = sessionId === undefined ? undefined : { sessionId };
    // Exact historical delivery has the same authenticated catalog.read and
    // manifest-verification boundary as current-run delivery. The URL carries
    // only an opaque version id, never an artifact filesystem path.
    const archive = await input.readOnlyServiceFactory(
      (services) =>
        services.playTesterResultRevision.loadExactPatchArchive({
          patchVersionId: input.patchVersionId,
        }),
      serviceOptions,
    );
    if (archive === null) {
      writeApiError(
        input.response,
        404,
        "not_found",
        `playable patch ${input.patchVersionId} was not found`,
      );
      return;
    }
    input.response.writeHead(200, {
      "content-type": archive.contentType,
      "content-length": String(archive.bytes.byteLength),
      "content-disposition": `attachment; filename="${archive.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    input.response.end(archive.bytes);
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof ItotoriInvalidAuthSessionError) {
      writeApiError(input.response, 403, "forbidden", error.message);
      return;
    }
    writeApiError(
      input.response,
      500,
      "internal_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function servePlayDeliveryArchiveRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  runId: string;
  readOnlyServiceFactory: ItotoriReadOnlyServiceFactory;
}): Promise<void> {
  if (input.request.method !== "GET") {
    writeApiError(input.response, 405, "method_not_allowed", "method must be GET");
    return;
  }
  try {
    const sessionId = parseItotoriSessionCookie(input.request.headers.cookie);
    const serviceOptions = sessionId === undefined ? undefined : { sessionId };
    // `loadSelectedArchive` is a bound production service method: its exporter
    // resolves the selected revision through the authenticated repository
    // actor and refuses callers without catalog.read before any bytes are read.
    const archive = await input.readOnlyServiceFactory(
      (services) => services.playTesterResultRevision.loadSelectedArchive({ runId: input.runId }),
      serviceOptions,
    );
    if (archive === null) {
      writeApiError(
        input.response,
        404,
        "not_found",
        `selected delivered patch for run ${input.runId} was not found`,
      );
      return;
    }
    input.response.writeHead(200, {
      "content-type": archive.contentType,
      "content-length": String(archive.bytes.byteLength),
      "content-disposition": `attachment; filename="${archive.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    input.response.end(archive.bytes);
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof ItotoriInvalidAuthSessionError) {
      writeApiError(input.response, 403, "forbidden", error.message);
      return;
    }
    writeApiError(
      input.response,
      500,
      "internal_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parsePlayDeliveryArchiveRoute(pathname: string): { runId: string } | null {
  const match = /^\/api\/play\/runs\/([^/]+)\/delivery\/archive\/?$/u.exec(pathname);
  if (match === null || match[1] === undefined) {
    return null;
  }
  try {
    const runId = decodeURIComponent(match[1]);
    if (
      runId.trim().length === 0 ||
      runId.includes("/") ||
      runId.includes("\\") ||
      runId === "." ||
      runId === ".."
    ) {
      return null;
    }
    return { runId };
  } catch {
    return null;
  }
}

function parsePatchIterationDeliveryArchiveRoute(pathname: string): {
  patchVersionId: string;
} | null {
  const match = /^\/api\/play\/patch-versions\/([^/]+)\/delivery\/archive\/?$/u.exec(pathname);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const patchVersionId = decodeSafeDeliveryPathId(match[1]);
  return patchVersionId === null ? null : { patchVersionId };
}

function decodeSafeDeliveryPathId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.trim().length === 0 ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded === "." ||
      decoded === ".."
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function writeApiError(
  response: ServerResponse,
  statusCode: number,
  code: "bad_request" | "forbidden" | "not_found" | "method_not_allowed" | "internal_error",
  error: string,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify({ error, code }));
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

export function startItotoriServer(options: DashboardServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? "4173");
  const server = createItotoriServer(options);
  // The normal request path drains a new correction immediately. The default
  // production server also owns a small unref'd poller for retry_waiting and
  // recovered abandoned leases, which cannot depend on another HTTP request
  // arriving. An injected service factory is a test/custom host boundary and
  // owns its own worker lifecycle instead.
  const contextCorrectionWorker =
    options.serviceFactory === undefined
      ? startDatabaseContextCorrectionWorker(databaseOptions(options))
      : undefined;
  server.once("close", () => {
    contextCorrectionWorker?.stop();
  });
  server.listen(port, dashboardListenHost, () => {
    console.log(`Itotori dashboard listening on http://${dashboardListenHost}:${port}`);
  });
  return server;
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

async function serveArtifactStoreRequest(
  pathname: string,
  response: ServerResponse,
  roots: Pick<DashboardServerOptions, "managedArtifactRoot" | "publicFixtureArtifactRoot">,
): Promise<void> {
  const artifactUri = decodeArtifactStoreUri(pathname);
  if (artifactUri === null || !isManagedRuntimeArtifactUri(artifactUri)) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("bad artifact uri");
    return;
  }

  const runtimeRelativePath = artifactUri.slice(managedRuntimeArtifactUriRoot.length);
  const candidateRoots = [
    { root: roots.managedArtifactRoot, path: runtimeRelativePath },
    { root: roots.publicFixtureArtifactRoot, path: artifactUri },
  ];

  for (const candidate of candidateRoots) {
    if (candidate.root === undefined) {
      continue;
    }
    const file = await readRootedFile(candidate.root, candidate.path);
    if (file !== null) {
      response.writeHead(200, { "content-type": contentType(artifactUri) });
      response.end(file);
      return;
    }
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

function decodeArtifactStoreUri(pathname: string): string | null {
  const encodedArtifactUri = pathname.slice("/artifact-store/".length);
  try {
    return decodeURIComponent(encodedArtifactUri);
  } catch {
    return null;
  }
}

function isManagedRuntimeArtifactUri(uri: string): boolean {
  return uri.startsWith(managedRuntimeArtifactUriRoot) && !isUnsafeRelativePath(uri);
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

async function readRootedFile(root: URL, path: string): Promise<Buffer | null> {
  const rootPath = fileURLToPath(root);
  const candidatePath = resolve(rootPath, path);
  const relativePath = relative(rootPath, candidatePath);
  if (isOutsideRoot(relativePath)) {
    return null;
  }
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(rootPath),
      realpath(candidatePath),
    ]);
    const realRelativePath = relative(realRoot, realCandidate);
    if (isOutsideRoot(realRelativePath)) {
      return null;
    }
    return await readFile(realCandidate);
  } catch {
    return null;
  }
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

function isRuntimeDashboardRoute(pathname: string): boolean {
  return pathname === "/runtime" || pathname.startsWith("/runtime/");
}

function isItotoriDashboardRoute(pathname: string): boolean {
  return (
    pathname === "/style-guide-builder" ||
    /^\/reviewer-queue(?:\/(?:batch|[^/]+))?$/u.test(pathname) ||
    /^\/projects\/[^/]+\/locale-branches\/[^/]+\/asset-decisions(?:\/batch)?$/u.test(pathname) ||
    // ITOTORI-040 — the localization workspace SPA. Mirrors the client-side
    // `workspaceRoutePathRegex` so every workspace deep link (source/draft/
    // final comparison, scene/asset browse, search, corrections) resolves to
    // the dashboard index and re-routes inside the SPA.
    /^\/workspace(?:\/(?:projects|scenes|assets|comparison|search|corrections))?$/u.test(
      pathname,
    ) ||
    // fnd-addressable-routing + surface roots the SPA owns (play / wiki /
    // benchmark / runs / findings). Keep `/runtime/*` on the runtime-web
    // dashboard (isRuntimeDashboardRoute) — Studio run deep-links use `/runs/`.
    pathname === "/play" ||
    pathname.startsWith("/play/") ||
    pathname === "/wiki" ||
    pathname.startsWith("/wiki/") ||
    pathname === "/benchmark" ||
    pathname.startsWith("/benchmark/") ||
    pathname === "/findings" ||
    pathname.startsWith("/findings/") ||
    pathname === "/runs" ||
    pathname.startsWith("/runs/")
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startItotoriServer();
}
