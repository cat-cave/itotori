import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, relative, resolve, sep } from "node:path";
import { handleItotoriApiRequest, isItotoriApiPath } from "./api-handlers.js";
import {
  withDatabaseItotoriServices,
  type ItotoriServiceFactory,
} from "./services/database-services.js";

export type DashboardServerOptions = {
  databaseUrl?: string;
  port?: number;
  serviceFactory?: ItotoriServiceFactory;
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
    ((callback) => withDatabaseItotoriServices(databaseOptions(options), callback));
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (isItotoriApiPath(url.pathname)) {
      try {
        const body = await readJsonRequestBody(request);
        const apiResponse = await serviceFactory((services) =>
          handleItotoriApiRequest(
            {
              method: request.method ?? "GET",
              pathname: url.pathname,
              search: url.search,
              body,
            },
            services,
          ),
        );
        response.writeHead(apiResponse.statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(apiResponse.body));
      } catch (error) {
        const statusCode = error instanceof SyntaxError ? 400 : 500;
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof SyntaxError ? "bad_request" : "internal_error",
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
    /^\/reviewer-queue\/(?:batch|[^/]+)$/u.test(pathname) ||
    /^\/projects\/[^/]+\/locale-branches\/[^/]+\/asset-decisions(?:\/batch)?$/u.test(pathname)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startItotoriServer();
}
