import { expect, it } from "vitest";
import { reasoningDetailsContinuity } from "../src/llm/reasoning-details-continuity.js";

it("passes a terminal-only stream through before the provider closes it", async () => {
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      next.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    },
    async pull() {
      await closed;
      controller.close();
    },
  });
  const continuity = reasoningDetailsContinuity(
    false,
    async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  );
  const response = await Promise.race([
    continuity.fetcher(new Request("https://provider.example/chat")).then(() => "response"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
  ]);
  close();

  expect(response).toBe("response");
  expect(continuity.evidence()).toEqual({
    receivedBatchCount: 0,
    receivedDetailCount: 0,
    forwardedBatchCount: 0,
    forwardedDetailCount: 0,
    exactForwardCount: 0,
  });
});
