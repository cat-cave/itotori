import { canonicalJson } from "./canonical-json.js";

type JsonObject = Record<string, unknown>;
type TransportFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ReasoningDetailsContinuityEvidence {
  readonly receivedBatchCount: number;
  readonly receivedDetailCount: number;
  readonly forwardedBatchCount: number;
  readonly forwardedDetailCount: number;
  readonly exactForwardCount: number;
}

export interface ReasoningDetailsContinuity {
  readonly fetcher: TransportFetcher;
  evidence(): ReasoningDetailsContinuityEvidence;
}

/**
 * Preserve provider-owned reasoning details across local tool turns. The
 * pinned adapter surfaces their text to TanStack but does not serialize the
 * opaque details onto the next assistant tool-call message, so this wrapper
 * captures and replays the untouched JSON at the one HTTP boundary.
 */
export function preserveReasoningDetails(fetcher: TransportFetcher): ReasoningDetailsContinuity {
  let pending: readonly unknown[] | null = null;
  let receivedBatchCount = 0;
  let receivedDetailCount = 0;
  let forwardedBatchCount = 0;
  let forwardedDetailCount = 0;
  let exactForwardCount = 0;

  return {
    fetcher: async (input, init) => {
      let request = new Request(input, init);
      if (pending && pending.length > 0) {
        const forwarded = await forwardPendingDetails(request, pending);
        request = forwarded.request;
        if (forwarded.forwarded) {
          forwardedBatchCount += 1;
          forwardedDetailCount += pending.length;
          if (forwarded.exact) exactForwardCount += 1;
          pending = null;
        }
      }

      const response = await fetcher(request);
      if (!isEventStream(response)) return response;
      const body = await response.text();
      const captured = reasoningDetailsFromEventStream(body);
      if (captured.length > 0) {
        pending = captured;
        receivedBatchCount += 1;
        receivedDetailCount += captured.length;
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    evidence: () => ({
      receivedBatchCount,
      receivedDetailCount,
      forwardedBatchCount,
      forwardedDetailCount,
      exactForwardCount,
    }),
  };
}

async function forwardPendingDetails(
  request: Request,
  details: readonly unknown[],
): Promise<{ request: Request; forwarded: boolean; exact: boolean }> {
  if (request.method !== "POST") return { request, forwarded: false, exact: false };
  let body: JsonObject;
  try {
    body = asObject(await request.clone().json());
  } catch {
    return { request, forwarded: false, exact: false };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const assistant = messages.findLast(
    (candidate) => asObject(candidate).role === "assistant" && hasToolCalls(candidate),
  );
  if (!assistant) return { request, forwarded: false, exact: false };
  const assistantMessage = asObject(assistant);
  assistantMessage.reasoning_details = details;
  const exact = canonicalJson(assistantMessage.reasoning_details) === canonicalJson(details);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return {
    request: new Request(request, { method: "POST", body: JSON.stringify(body), headers }),
    forwarded: true,
    exact,
  };
}

function reasoningDetailsFromEventStream(body: string): unknown[] {
  const details: unknown[] = [];
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: JsonObject;
    try {
      chunk = asObject(JSON.parse(payload));
    } catch {
      continue;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const raw = asObject(asObject(choice).delta).reasoning_details;
      if (Array.isArray(raw)) details.push(...raw);
    }
  }
  return details;
}

function hasToolCalls(value: unknown): boolean {
  const calls = asObject(value).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

function isEventStream(response: Response): boolean {
  return (
    response.ok && response.headers.get("content-type")?.includes("text/event-stream") === true
  );
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
