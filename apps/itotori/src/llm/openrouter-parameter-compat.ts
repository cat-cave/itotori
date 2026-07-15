type JsonObject = Record<string, unknown>;
type TransportFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Use the provider-supported spelling for the output-token ceiling. The pinned
 * TanStack adapter only exposes maxCompletionTokens even though the OpenRouter
 * SDK and API also support max_tokens. With require_parameters enabled,
 * OpenRouter excludes the Fireworks route when the unsupported
 * max_completion_tokens spelling is present.
 */
export function normalizeOpenRouterParameters(fetcher: TransportFetcher): TransportFetcher {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return fetcher(request);
    let body: JsonObject;
    try {
      body = asObject(await request.clone().json());
    } catch {
      return fetcher(request);
    }
    if (!("max_completion_tokens" in body) || "max_tokens" in body) return fetcher(request);
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return fetcher(new Request(request, { method: "POST", body: JSON.stringify(body), headers }));
  };
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
