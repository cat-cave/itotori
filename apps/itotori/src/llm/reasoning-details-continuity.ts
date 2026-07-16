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
      // Buffer the event stream to capture reasoning details, but do NOT let a
      // transport loss AFTER response bytes were emitted collapse into a fetcher
      // throw: `response.text()` would reject on the mid-stream error and turn a
      // completed-response transport loss into a retryable connection failure.
      // Replay the received bytes and re-emit the error so the model adapter
      // observes exactly the stream it would have seen unwrapped.
      const { text: body, errored } = await bufferEventStream(response);
      const captured = reasoningDetailsFromEventStream(body);
      if (captured.length > 0) {
        pending = captured;
        receivedBatchCount += 1;
        receivedDetailCount += captured.length;
      }
      if (!errored) {
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const replay = new ReadableStream<Uint8Array>({
        start(controller) {
          if (body.length > 0) controller.enqueue(new TextEncoder().encode(body));
          controller.error(new Error("reasoning-details passthrough: upstream event stream error"));
        },
      });
      return new Response(replay, {
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

/**
 * Read an event-stream body into text. Distinguishes a clean end-of-stream
 * from a transport loss that occurs AFTER some bytes were emitted: the caller
 * replays the received bytes and re-signals the error so a completed-response
 * transport loss keeps its terminal (non-retried) transport semantics.
 */
async function bufferEventStream(response: Response): Promise<{ text: string; errored: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      return { text: await response.text(), errored: false };
    } catch {
      return { text: "", errored: true };
    }
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, errored: false };
  } catch {
    text += decoder.decode();
    return { text, errored: true };
  }
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
