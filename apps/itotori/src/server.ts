import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
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
};

export function createItotoriServer(options: DashboardServerOptions = {}) {
  const webRoot = options.webRoot ?? new URL("../web-dist/", import.meta.url);
  const serviceFactory =
    options.serviceFactory ??
    ((callback) => withDatabaseItotoriServices(databaseOptions(options), callback));
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (isItotoriApiPath(url.pathname)) {
      try {
        const apiResponse = await serviceFactory((services) =>
          handleItotoriApiRequest(url.pathname, services.projectWorkflow),
        );
        response.writeHead(apiResponse.statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(apiResponse.body));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
      return;
    }

    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try {
      const body = await readFile(join(webRoot.pathname, path));
      response.writeHead(200, { "content-type": contentType(path) });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
}

function databaseOptions(options: DashboardServerOptions) {
  return options.databaseUrl === undefined
    ? { bootstrapLocalUser: false }
    : { databaseUrl: options.databaseUrl, bootstrapLocalUser: false };
}

export function startItotoriServer(options: DashboardServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? "4173");
  const server = createItotoriServer(options);
  server.listen(port, () => {
    console.log(`Itotori dashboard listening on http://127.0.0.1:${port}`);
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
    default:
      return "application/octet-stream";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startItotoriServer();
}
