// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceEvent,
  bindInteractiveControls,
  choiceEvent,
  highlightChoiceEvent,
  InputSession,
  type InputEvent,
  menuSelectEvent,
  pointerEvent,
  REPLAY_LOG_SCHEMA_VERSION,
  sendInput,
} from "../src/input-bridge.js";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("input-bridge wire form (mirrors Rust utsushi_core::input::InputEvent)", () => {
  it("emits the exact serde tag + fields for each variant", () => {
    expect(advanceEvent()).toEqual({ kind: "advance" });
    expect(choiceEvent(2)).toEqual({ kind: "choice", index: 2 });
    expect(pointerEvent(0.25, 0.75, "secondary")).toEqual({
      kind: "pointer",
      x: 0.25,
      y: 0.75,
      button: "secondary",
    });
    expect(menuSelectEvent("choice", "1")).toEqual({
      kind: "menu_select",
      target: { menuId: "choice", itemId: "1" },
    });
    // Highlight-move is a menu_select with a numeric itemId (the runtime reads
    // it as a highlight-move to that option index).
    expect(highlightChoiceEvent(3)).toEqual({
      kind: "menu_select",
      target: { menuId: "choice", itemId: "3" },
    });
  });

  it("rejects out-of-range payloads (matching the Rust payload-shape validation)", () => {
    expect(() => choiceEvent(-1)).toThrow();
    expect(() => choiceEvent(1.5)).toThrow();
    expect(() => pointerEvent(1.5, 0)).toThrow();
    expect(() => pointerEvent(0, Number.NaN)).toThrow();
    expect(() => menuSelectEvent("choice", "")).toThrow();
  });
});

describe("InputSession deterministic capture", () => {
  it("records events at strictly monotonic ticks starting at 1", () => {
    const session = new InputSession({ runId: "run-1" });
    session.record(advanceEvent());
    session.record(choiceEvent(0));
    session.record(advanceEvent());
    const ticks = session.toEntries().map((entry) => entry.tick);
    expect(ticks).toEqual([1, 2, 3]);
  });

  it("builds a ReplayLog matching the Rust ReplayLog camelCase wire form", () => {
    const session = new InputSession({ runId: "run-42" });
    session.record(advanceEvent());
    session.record(choiceEvent(1));
    const log = session.toReplayLog(["vfs://hello/intro.txt"]);
    expect(log).toEqual({
      schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
      metadata: {
        runId: "run-42",
        adapterName: "utsushi-reallive",
        adapterVersion: REPLAY_LOG_SCHEMA_VERSION,
        clockOrigin: "run_start",
        seed: 0,
      },
      events: [
        { tick: 1, event: { kind: "advance" } },
        { tick: 2, event: { kind: "choice", index: 1 } },
      ],
      assetRefs: ["vfs://hello/intro.txt"],
    });
  });

  it("the same gesture script produces an identical log (reproducible)", () => {
    const script: InputEvent[] = [advanceEvent(), choiceEvent(1), advanceEvent()];
    const build = (): unknown => {
      const session = new InputSession({ runId: "run-x" });
      for (const event of script) {
        session.record(event);
      }
      return session.toReplayLog();
    };
    expect(build()).toEqual(build());
  });
});

describe("bindInteractiveControls — human gestures reach the runtime", () => {
  it("routes an option click to a choice commit and a bare click to advance", () => {
    const session = new InputSession({ runId: "dom-run" });
    const seen: InputEvent[] = [];
    const teardown = bindInteractiveControls(root, session, {
      onInput: (event) => seen.push(event),
    });

    const option = document.createElement("button");
    option.setAttribute("data-choice-index", "1");
    root.append(option);

    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(seen).toEqual([{ kind: "choice", index: 1 }, { kind: "advance" }, { kind: "advance" }]);
    // Every gesture was captured deterministically.
    expect(session.toEvents()).toEqual(seen);
    teardown();
    // After teardown, further gestures are ignored.
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(session.length).toBe(3);
  });

  it("records pointer navigation as a bounded normalized pointer event", () => {
    const session = new InputSession({ runId: "ptr-run" });
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const teardown = bindInteractiveControls(root, session);
    root.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 50, clientY: 50, bubbles: true }),
    );
    const [entry] = session.toEntries();
    expect(entry?.event).toEqual({ kind: "pointer", x: 0.25, y: 0.5, button: "primary" });
    teardown();
  });
});

describe("sendInput transport", () => {
  it("records then posts the engine-neutral entry to the runtime endpoint", async () => {
    const session = new InputSession({ runId: "post-run" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const entry = await sendInput(session, choiceEvent(2), "http://localhost/api/runtime-input");
    expect(entry).toEqual({ tick: 1, event: { kind: "choice", index: 2 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      tick: 1,
      event: { kind: "choice", index: 2 },
    });
    // The capture reflects exactly what reached the runtime.
    expect(session.toEvents()).toEqual([{ kind: "choice", index: 2 }]);
  });

  it("throws on a non-OK runtime response", async () => {
    const session = new InputSession({ runId: "err-run" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      sendInput(session, advanceEvent(), "http://localhost/api/runtime-input"),
    ).rejects.toThrow(/503/);
  });
});
