// Interactive input bridge — browser/dashboard → RealLive runtime.
//
// The runtime-side `utsushi-reallive::input_bridge` consumes an engine-neutral
// `InputEvent` stream (advance / choice / pointer / menu) at every input-gated
// yield and captures it to a `ReplayLog` so a live playthrough replays
// identically. This module is the BROWSER half of that seam: it turns a human's
// dashboard gestures (click / keypress to advance, click an option to choose,
// pointer / menu navigation) into the SAME engine-neutral `InputEvent` wire
// form the Rust runtime deserializes, accumulates them into a deterministic,
// tick-monotonic session log, and posts them to the runtime input endpoint.
//
// The wire form here is the exact serde shape of `utsushi_core::input::InputEvent`
// and `utsushi_core::replay::{ReplayEntry, ReplayLog}` — the Rust types are the
// producer/consumer of record; this file must mirror them byte-for-byte.

// Pinned to `utsushi_core::replay::REPLAY_LOG_SCHEMA_VERSION`.
export const REPLAY_LOG_SCHEMA_VERSION = "0.1.0-alpha";

// The default endpoint a host serves; the runtime consumes posted events here.
// (Like the rest of this app, no live server ships — a host wires the route and
// the tests front it with MSW.)
export const RUNTIME_INPUT_DEFAULT_ENDPOINT = "/api/utsushi/v0.1/runtime-input";

export type PointerButton = "primary" | "secondary" | "auxiliary";

// Menu-tree target — stable logical ids, never screen coordinates. Mirrors
// `MenuTarget` (`#[serde(rename_all = "camelCase")]`). A numeric `itemId` is the
// engine-general convention the runtime reads as a highlight-move to that
// option index.
export type MenuTarget = {
  menuId: string;
  itemId: string;
};

export type RawInputCode = {
  engine: string;
  code: string;
};

// Engine-neutral input event. `kind` is the serde tag; every variant mirrors
// `utsushi_core::input::InputEvent` (snake_case tag + fields).
export type InputEvent =
  | { kind: "text" }
  | { kind: "advance" }
  | { kind: "choice"; index: number }
  | { kind: "pointer"; x: number; y: number; button: PointerButton }
  | { kind: "menu_select"; target: MenuTarget }
  | { kind: "skip"; enable: boolean }
  | { kind: "auto"; enable: boolean }
  | { kind: "save"; slot: number }
  | { kind: "load"; slot: number }
  | { kind: "raw"; code: RawInputCode };

// One recorded event anchored at a logical tick. Mirrors `ReplayEntry`
// (`#[serde(rename_all = "camelCase")]`).
export type ReplayEntry = {
  tick: number;
  event: InputEvent;
};

export type ReplayMetadata = {
  runId: string;
  adapterName: string;
  adapterVersion: string;
  clockOrigin: "run_start" | "snapshot_restore";
  seed: number;
};

// The deterministic input log. Mirrors `ReplayLog` (camelCase).
export type ReplayLog = {
  schemaVersion: string;
  metadata: ReplayMetadata;
  events: ReplayEntry[];
  assetRefs: string[];
};

// -- Event constructors -----------------------------------------------------

export function textEvent(): InputEvent {
  return { kind: "text" };
}

export function advanceEvent(): InputEvent {
  return { kind: "advance" };
}

// A choice commit for a 0-based option index. Engines that present options by
// string id must canonicalize to an index at record time (the dashboard, which
// renders the option list, knows the mapping).
export function choiceEvent(index: number): InputEvent {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
    throw new Error(`choice index must be a u16, got ${JSON.stringify(index)}`);
  }
  return { kind: "choice", index };
}

// Bounded pointer input in logical normalized coordinates ([0, 1]).
export function pointerEvent(x: number, y: number, button: PointerButton = "primary"): InputEvent {
  for (const [label, value] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`pointer ${label} must be finite in [0, 1], got ${JSON.stringify(value)}`);
    }
  }
  return { kind: "pointer", x, y, button };
}

// Menu-tree navigation to a stable option id. A base-10 `itemId` moves the
// runtime's highlight to that option index.
export function menuSelectEvent(menuId: string, itemId: string): InputEvent {
  if (menuId.trim() === "" || itemId.trim() === "") {
    throw new Error("menu_select menuId and itemId must be non-empty");
  }
  return { kind: "menu_select", target: { menuId, itemId } };
}

// Move the choice-cursor highlight to option `index` (a menu navigation event
// the runtime reads as a highlight-move; commit with an advance).
export function highlightChoiceEvent(index: number): InputEvent {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
    throw new Error(`highlight index must be a u16, got ${JSON.stringify(index)}`);
  }
  return menuSelectEvent("choice", String(index));
}

// -- Interactive session ----------------------------------------------------

export type InputSessionOptions = {
  runId: string;
  adapterName?: string;
  adapterVersion?: string;
};

// Accumulates a human's dashboard gestures into a deterministic, tick-monotonic
// input log and (optionally) posts each event to the runtime as it arrives. The
// log this produces is exactly what the Rust `ReplaySource` replays to reproduce
// the identical playthrough.
export class InputSession {
  private readonly runId: string;
  private readonly adapterName: string;
  private readonly adapterVersion: string;
  private readonly entries: ReplayEntry[] = [];
  private nextTick = 1;

  constructor(options: InputSessionOptions) {
    if (options.runId.trim() === "") {
      throw new Error("InputSession requires a non-empty runId");
    }
    this.runId = options.runId;
    this.adapterName = options.adapterName ?? "utsushi-reallive";
    this.adapterVersion = options.adapterVersion ?? REPLAY_LOG_SCHEMA_VERSION;
  }

  // Record one gesture at the next monotonic tick. Returns the recorded entry.
  record(event: InputEvent): ReplayEntry {
    const entry: ReplayEntry = { tick: this.nextTick, event };
    this.nextTick += 1;
    this.entries.push(entry);
    return entry;
  }

  // The recorded entries in tick order.
  toEntries(): ReplayEntry[] {
    return this.entries.map((entry) => ({ tick: entry.tick, event: entry.event }));
  }

  // The events in tick order (the stream the runtime consumes).
  toEvents(): InputEvent[] {
    return this.entries.map((entry) => entry.event);
  }

  // Finalize a `ReplayLog` matching the Rust wire form, replayable by the
  // runtime's `ReplaySource`.
  toReplayLog(assetRefs: string[] = []): ReplayLog {
    return {
      schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
      metadata: {
        runId: this.runId,
        adapterName: this.adapterName,
        adapterVersion: this.adapterVersion,
        clockOrigin: "run_start",
        seed: 0,
      },
      events: this.toEntries(),
      assetRefs,
    };
  }

  get length(): number {
    return this.entries.length;
  }
}

// -- Runtime transport ------------------------------------------------------

// Post one input event to the runtime input endpoint. Records it into `session`
// first (so the deterministic capture reflects exactly what reached the
// runtime), then delivers the engine-neutral wire form. Surfaces a non-OK
// response as a thrown error so the dashboard can render an error state.
export async function sendInput(
  session: InputSession,
  event: InputEvent,
  endpoint: string = RUNTIME_INPUT_DEFAULT_ENDPOINT,
): Promise<ReplayEntry> {
  const entry = session.record(event);
  const url = endpoint.startsWith("http")
    ? endpoint
    : new URL(endpoint, globalThis.location?.href ?? "http://localhost/").toString();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!response.ok) {
    throw new Error(`runtime rejected input: ${response.status}`);
  }
  return entry;
}

// -- DOM wiring -------------------------------------------------------------

export type InteractiveControlsOptions = {
  // Called after each gesture is recorded (e.g. to POST to the runtime).
  onInput?: (event: InputEvent) => void;
};

// Bind a human's dashboard gestures on `root` to the input session:
//
//   * a click on the root (outside a choice option) or an Enter / Space / click
//     keypress → advance (dismiss a pause / commit the highlighted choice);
//   * a click on an element with `data-choice-index` → a choice commit;
//   * pointer move over the root → a bounded pointer navigation event
//     (recorded so the full gesture stream replays).
//
// Returns a teardown that removes the listeners. Engine-general: no game or
// scene knowledge, only the generic advance / choice / pointer gestures.
export function bindInteractiveControls(
  root: HTMLElement,
  session: InputSession,
  options: InteractiveControlsOptions = {},
): () => void {
  const emit = (event: InputEvent): void => {
    session.record(event);
    options.onInput?.(event);
  };

  const onClick = (raw: Event): void => {
    const target = raw.target as HTMLElement | null;
    const optionEl = target?.closest<HTMLElement>("[data-choice-index]");
    if (optionEl) {
      const index = Number(optionEl.getAttribute("data-choice-index"));
      emit(choiceEvent(index));
      return;
    }
    emit(advanceEvent());
  };

  const onKeydown = (raw: Event): void => {
    const key = (raw as KeyboardEvent).key;
    if (key === "Enter" || key === " " || key === "Spacebar") {
      emit(advanceEvent());
    }
  };

  const onPointerMove = (raw: Event): void => {
    const pointer = raw as PointerEvent;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const x = clamp01((pointer.clientX - rect.left) / rect.width);
    const y = clamp01((pointer.clientY - rect.top) / rect.height);
    emit(pointerEvent(x, y));
  };

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("pointermove", onPointerMove);

  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeydown);
    root.removeEventListener("pointermove", onPointerMove);
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
