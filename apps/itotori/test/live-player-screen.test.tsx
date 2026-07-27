// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LivePlayerScreen } from "../src/ui/screens/LivePlayerScreen.js";
import { RedactionGovernor, RedactionToggle } from "../src/ui/redaction-governor.js";

const CONFIG = {
  seenPath: "/seen",
  gameexePath: "/gameexe",
  g00Dir: "/g00",
  artifactRoot: "/artifacts",
  scene: 7,
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

  // The engine can rasterise either an unredacted frame or an edge-outline
  // stand-in, and the shell already owns a cap-gated control for that choice.
  // The player asked for the redacted one unconditionally, so a reviewer who
  // HELD the cap still could not see the art a line sits on. These pin the
  // governor to the launch request in both directions.
  it.each([
    { label: "without the reveal capability", reveal: false, expected: "on" },
    { label: "when the capable viewer reveals", reveal: true, expected: "off" },
  ])("starts the engine with redaction $expected $label", async ({ reveal, expected }) => {
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
    expect(JSON.parse(bodies[bodies.length - 1]!).redaction).toBe(expected);
  });
});
