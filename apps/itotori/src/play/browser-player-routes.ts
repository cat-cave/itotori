import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  BrowserPlayerSessionError,
  BrowserPlayerSessionManager,
  type BrowserPlayerInput,
  type BrowserPlayerLaunch,
} from "./browser-player-session.js";

export type BrowserPlayerLaunchRegistry = Readonly<Record<string, BrowserPlayerLaunch>>;

export function isBrowserPlayerRoute(pathname: string): boolean {
  return (
    pathname === "/api/player/sessions" ||
    parseBrowserPlayerInputRoute(pathname) !== null ||
    parseBrowserPlayerFrameRoute(pathname) !== null
  );
}

export async function serveBrowserPlayerRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  sessions: BrowserPlayerSessionManager;
  launches: BrowserPlayerLaunchRegistry;
  canReveal: () => Promise<boolean>;
}): Promise<void> {
  try {
    const frameRoute = parseBrowserPlayerFrameRoute(input.pathname);
    if (frameRoute !== null) {
      if (input.request.method !== "GET")
        return writeError(input.response, 405, "method_not_allowed");
      const bytes = await input.sessions.readFrame(
        frameRoute.sessionId,
        frameRoute.frameId,
        await input.canReveal(),
      );
      input.response.writeHead(200, { "content-type": "image/png" });
      input.response.end(bytes);
      return;
    }
    if (input.request.method !== "POST")
      return writeError(input.response, 405, "method_not_allowed");
    const body = await readJsonRequestBody(input.request);
    if (input.pathname === "/api/player/sessions") {
      const launchId = parseBrowserPlayerStart(body);
      const launch = input.launches[launchId];
      if (launch === undefined)
        throw new BrowserPlayerSessionError("browser player session was not found");
      writeJson(input.response, 201, await input.sessions.start(launch, await input.canReveal()));
      return;
    }
    const sessionId = parseBrowserPlayerInputRoute(input.pathname);
    if (sessionId === null) return writeError(input.response, 404, "not_found");
    writeJson(
      input.response,
      200,
      await input.sessions.send(sessionId, parseBrowserPlayerInput(body)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const forbidden = message === "reveal capability is required for this frame";
    const status = forbidden ? 403 : error instanceof BrowserPlayerSessionError ? 422 : 400;
    writeError(input.response, status, forbidden ? "forbidden" : "bad_request", message);
  }
}

function parseBrowserPlayerInputRoute(pathname: string): string | null {
  const match = /^\/api\/player\/sessions\/([^/]+)\/input$/u.exec(pathname);
  return match === null ? null : decodeSegment(match[1]);
}

function parseBrowserPlayerFrameRoute(
  pathname: string,
): { sessionId: string; frameId: string } | null {
  const match = /^\/api\/player\/sessions\/([^/]+)\/frames\/([^/]+)$/u.exec(pathname);
  if (match === null) return null;
  const sessionId = decodeSegment(match[1]);
  const frameId = decodeSegment(match[2]);
  return sessionId === null || frameId === null ? null : { sessionId, frameId };
}

function decodeSegment(value: string | undefined): string | null {
  try {
    return value === undefined ? null : decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseBrowserPlayerStart(value: unknown): string {
  if (!isObject(value) || typeof value.session !== "string" || value.session.trim() === "") {
    throw new BrowserPlayerSessionError("player start requires a server-registered session");
  }
  return value.session;
}

function parseBrowserPlayerInput(value: unknown): BrowserPlayerInput {
  if (!isObject(value) || typeof value.type !== "string")
    throw new BrowserPlayerSessionError("player input requires a type");
  if (value.type === "advance") return { type: "advance" };
  if (value.type === "choice") return { type: "choice", index: requiredNumber(value, "index") };
  throw new BrowserPlayerSessionError("player input type must be advance or choice");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const entry = value[key];
  if (typeof entry !== "number")
    throw new BrowserPlayerSessionError(`player ${key} must be a number`);
  return entry;
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeError(response: ServerResponse, status: number, code: string, error = code): void {
  writeJson(response, status, { code, error });
}
