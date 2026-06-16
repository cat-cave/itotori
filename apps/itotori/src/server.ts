import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { HelloWorldRepository, createDatabaseContext } from "@itotori/db";

export type DashboardServerOptions = {
  databaseUrl?: string;
  port?: number;
  webRoot?: URL;
};

export function createItotoriServer(options: DashboardServerOptions = {}) {
  const webRoot = options.webRoot ?? new URL("../web-dist/", import.meta.url);
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/hello/status") {
      const context = createDatabaseContext(options.databaseUrl);
      try {
        const status = await new HelloWorldRepository(context.db).getStatus();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(status));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      } finally {
        await context.close();
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
