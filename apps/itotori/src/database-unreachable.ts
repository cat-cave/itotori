const connectionFailureCodes = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

type DatabaseEndpoint = {
  host: string;
  port: number;
  database: string;
};

type ConnectionFailure = Error & {
  address?: unknown;
  code?: unknown;
  hostname?: unknown;
  port?: unknown;
};

/**
 * Returns a safe user-facing explanation only when a database connection
 * actually failed to reach the configured endpoint. It deliberately ignores
 * SQL, authentication, and arbitrary application failures.
 */
export function databaseUnreachableMessage(
  error: unknown,
  databaseUrl = process.env.DATABASE_URL,
): string | null {
  const endpoint = databaseEndpoint(databaseUrl);
  if (endpoint === null || !hasMatchingConnectionFailure(error, endpoint)) return null;
  return `Database at ${formatHost(endpoint.host)}:${endpoint.port}/${endpoint.database} is unreachable. Start it with just dev db-up, then refresh.`;
}

function databaseEndpoint(databaseUrl: string | undefined): DatabaseEndpoint | null {
  if (!databaseUrl) return null;
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    if (!url.hostname || !database) return null;
    return { host: url.hostname, port: Number(url.port || "5432"), database };
  } catch {
    return null;
  }
}

function hasMatchingConnectionFailure(error: unknown, endpoint: DatabaseEndpoint): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (isMatchingConnectionFailure(current as ConnectionFailure, endpoint)) return true;
    current = current.cause;
  }
  return false;
}

function isMatchingConnectionFailure(
  error: ConnectionFailure,
  endpoint: DatabaseEndpoint,
): boolean {
  if (typeof error.code !== "string" || !connectionFailureCodes.has(error.code)) return false;
  const host = typeof error.address === "string" ? error.address : error.hostname;
  const port = typeof error.port === "number" ? error.port : undefined;
  if (host === undefined && port === undefined) return false;
  if (typeof host === "string" && !hostsMatch(host, endpoint.host)) return false;
  return port === undefined || port === endpoint.port;
}

function hostsMatch(actual: string, configured: string): boolean {
  const normalizedActual = actual.replace(/^\[|\]$/gu, "").toLowerCase();
  const normalizedConfigured = configured.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalizedActual === normalizedConfigured) return true;
  return (
    normalizedConfigured === "localhost" &&
    (normalizedActual === "127.0.0.1" || normalizedActual === "::1")
  );
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
