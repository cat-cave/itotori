// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LivePlayerScreen } from "../src/ui/screens/LivePlayerScreen.js";

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
            dataUrl: second ? "data:image/png;base64,second" : "data:image/png;base64,first",
            artifactId: second ? "frame-2" : "frame-1",
            width: 16,
            height: 9,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    render(
      <LivePlayerScreen
        config={{
          seenPath: "/seen",
          gameexePath: "/gameexe",
          g00Dir: "/g00",
          artifactRoot: "/artifacts",
          scene: 7,
        }}
      />,
    );

    const frame = await screen.findByAltText("Current real engine frame");
    expect(frame).toHaveAttribute("src", "data:image/png;base64,first");
    fireEvent.click(screen.getByRole("button", { name: "Advance" }));
    expect(await screen.findByAltText("Current real engine frame")).toHaveAttribute(
      "src",
      "data:image/png;base64,second",
    );
    expect(screen.getByRole("img")).toHaveAttribute("data-frame-artifact-id", "frame-2");
    expect(calls).toBe(2);
  });
});
