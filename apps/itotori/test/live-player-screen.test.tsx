// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LivePlayerScreen } from "../src/ui/screens/LivePlayerScreen.js";
import { RedactionGovernor, RedactionToggle } from "../src/ui/redaction-governor.js";

const CONFIG = {
  session: "review-session",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Live browser player", () => {
  it("renders the engine frame returned after an input instead of retaining the prior frame", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        "http://itotori.test",
      );
      calls += 1;
      const second = url.pathname.endsWith("/input");
      return new Response(
        JSON.stringify({
          sessionId: "session-1",
          scene: 7,
          instructionPointer: second ? 128 : 64,
          eventIndex: second ? 2 : 1,
          waitingFor: { type: "advance" },
          ended: false,
          frame: {
            frameId: second ? "frame-2" : "frame-1",
            artifactId: second ? "frame-2" : "frame-1",
            width: 16,
            height: 9,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    render(<LivePlayerScreen config={CONFIG} />);

    const frame = await screen.findByAltText("Current real engine frame");
    expect(frame).toHaveAttribute("src", "/api/player/sessions/session-1/frames/frame-1");
    fireEvent.click(screen.getByRole("button", { name: "Advance" }));
    expect(await screen.findByAltText("Current real engine frame")).toHaveAttribute(
      "src",
      "/api/player/sessions/session-1/frames/frame-2",
    );
    expect(screen.getByRole("img")).toHaveAttribute("data-frame-artifact-id", "frame-2");
    expect(calls).toBe(2);
  });

  // The browser sends an opaque server-registered session only. The server
  // consults the same reveal permission backing the governor; request JSON
  // cannot select a filesystem path or redaction posture.
  it.each([
    { label: "without the reveal capability", reveal: false },
    { label: "when the capable viewer reveals", reveal: true },
  ])("does not send redaction or paths $label", async ({ reveal }) => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          sessionId: "session-1",
          scene: 7,
          instructionPointer: 64,
          eventIndex: 1,
          waitingFor: { type: "advance" },
          ended: false,
          frame: null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    render(
      <RedactionGovernor revealSensitive={reveal}>
        <RedactionToggle />
        <LivePlayerScreen config={CONFIG} />
      </RedactionGovernor>,
    );
    await screen.findByRole("button", { name: "Advance" });
    if (reveal) {
      fireEvent.click(screen.getByRole("checkbox"));
      await waitFor(() => expect(bodies).toHaveLength(2));
    }

    expect(bodies.length).toBeGreaterThan(0);
    expect(JSON.parse(bodies[bodies.length - 1]!)).toEqual({ session: "review-session" });
  });
});
