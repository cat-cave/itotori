// Browser surface for a server-held real engine session.

import { useEffect, useState, type ReactNode } from "react";
import { Panel } from "@itotori/ds";
import { ShellHeader } from "../states.js";
import { RedactionGovernorBoundary, useRedactionGovernor } from "../redaction-governor.js";

export const livePlayerRoutePathRegex = /^\/play\/player\/?$/u;

type LivePlayerConfig = {
  session: string;
};

type PlayerState = {
  sessionId: string;
  scene: number;
  instructionPointer: number;
  eventIndex: number;
  waitingFor:
    | { type: "advance" }
    | { type: "pointer" }
    | { type: "choice"; choiceCount: number; options: string[] }
    | null;
  ended: boolean;
  frame: { frameId: string; artifactId: string; width: number; height: number } | null;
};

export function parseLivePlayerRoute(pathname: string, search: string): LivePlayerConfig | null {
  if (!livePlayerRoutePathRegex.test(pathname)) return null;
  const params = new URLSearchParams(search);
  const session = params.get("session");
  return session === null || session.trim() === "" ? null : { session };
}

export function LivePlayerScreen({ config }: { config: LivePlayerConfig | null }): ReactNode {
  // The governor is the SINGLE authority on whether this viewer may see an
  // unredacted frame. The boundary supplies the closed default (no cap, no
  // reveal) when the player is mounted outside the shell, so the surface can
  // never accidentally open up by being rendered somewhere else.
  return (
    <RedactionGovernorBoundary>
      <LivePlayerSurface config={config} />
    </RedactionGovernorBoundary>
  );
}

function LivePlayerSurface({ config }: { config: LivePlayerConfig | null }): ReactNode {
  const [state, setState] = useState<PlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(config !== null);
  // The engine fixes redaction when the session starts. Restart after a local
  // toggle changes so the server can re-evaluate the actor's reveal permission;
  // the request itself carries only the opaque server-registered session.
  const { canReveal } = useRedactionGovernor();

  useEffect(() => {
    if (config === null) return;
    let cancelled = false;
    let sessionId: string | undefined;
    setBusy(true);
    void post<PlayerState>("/api/player/sessions", config).then(
      (next) => {
        sessionId = next.sessionId;
        if (!cancelled) {
          setState(next);
          setBusy(false);
        } else {
          void deleteSession(next.sessionId);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setBusy(false);
        }
      },
    );
    return () => {
      cancelled = true;
      if (sessionId !== undefined) void deleteSession(sessionId);
    };
  }, [config, canReveal]);

  const send = (
    input: { type: "advance" } | { type: "pointer" } | { type: "choice"; index: number },
  ) => {
    if (state === null || busy) return;
    setBusy(true);
    void post<PlayerState>(
      `/api/player/sessions/${encodeURIComponent(state.sessionId)}/input`,
      input,
    ).then(
      (next) => {
        setState(next);
        setBusy(false);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(false);
      },
    );
  };

  return (
    <main className="itotori-shell live-player" data-screen="live-player">
      <ShellHeader eyebrow="Play" title="Browser player">
        <p className="itotori-shell__lede">
          A live RealLive VM renders this frame and waits for your next input.
        </p>
      </ShellHeader>
      {config === null && (
        <Panel title="Player launch required">
          <p>
            Open this route from a verified patch launch that supplies the exact runtime descriptor.
          </p>
        </Panel>
      )}
      {error !== null && (
        <Panel title="Engine session ended">
          <p role="alert">{error}</p>
        </Panel>
      )}
      {busy && (
        <Panel title="Engine">
          <p>Running the real engine…</p>
        </Panel>
      )}
      {state !== null && <PlayerPanel state={state} busy={busy} send={send} />}
    </main>
  );
}

function PlayerPanel({
  state,
  busy,
  send,
}: {
  state: PlayerState;
  busy: boolean;
  send: (
    input: { type: "advance" } | { type: "pointer" } | { type: "choice"; index: number },
  ) => void;
}): ReactNode {
  return (
    <Panel
      title="Live frame"
      eyebrow={`scene ${state.scene} · ip ${state.instructionPointer} · event ${state.eventIndex}`}
      // The VM address the frame was rasterised at, stamped on the surface.
      // Progress is what a reader judges the player by, and it is the only
      // thing a rendering assertion cannot see: a player stuck on one address
      // still shows a frame. Exposing the address structurally lets a test
      // assert the VM MOVED through the browser path rather than that a
      // picture appeared.
      data-live-player-panel=""
      data-scene={state.scene}
      data-instruction-pointer={state.instructionPointer}
      data-event-index={state.eventIndex}
      data-waiting-for={state.ended ? "ended" : (state.waitingFor?.type ?? "none")}
      data-busy={busy ? "true" : "false"}
    >
      {state.frame === null ? (
        <p>The engine reached a boundary without a renderable text frame.</p>
      ) : (
        <img
          src={`/api/player/sessions/${encodeURIComponent(state.sessionId)}/frames/${encodeURIComponent(state.frame.frameId)}`}
          width={state.frame.width}
          height={state.frame.height}
          // The engine composites at the GAME's native surface size, which is
          // routinely wider than the panel. At intrinsic size the frame is
          // cut off at the container edge and the player sees a fraction of
          // the scene; scale it down to fit instead, keeping the aspect ratio.
          style={{ maxWidth: "100%", height: "auto" }}
          alt="Current real engine frame"
          data-frame-artifact-id={state.frame.artifactId}
        />
      )}
      {state.ended ? (
        <p>The engine reached a terminal state.</p>
      ) : (
        <PlayerInput waitingFor={state.waitingFor} busy={busy} send={send} />
      )}
    </Panel>
  );
}

function PlayerInput({
  waitingFor,
  busy,
  send,
}: {
  waitingFor: PlayerState["waitingFor"];
  busy: boolean;
  send: (
    input: { type: "advance" } | { type: "pointer" } | { type: "choice"; index: number },
  ) => void;
}): ReactNode {
  if (waitingFor?.type === "choice")
    return (
      <p>
        {Array.from({ length: waitingFor.choiceCount }, (_, index) => (
          <button
            key={index}
            type="button"
            disabled={busy}
            data-player-choice={index}
            onClick={() => send({ type: "choice", index })}
          >
            {waitingFor.options[index] ?? `Choice ${index + 1}`}
          </button>
        ))}
      </p>
    );
  if (waitingFor?.type === "pointer")
    return (
      <p>
        <button
          type="button"
          disabled={busy}
          data-player-pointer=""
          onClick={() => send({ type: "pointer" })}
        >
          Continue
        </button>
      </p>
    );
  return (
    <p>
      <button
        type="button"
        disabled={busy}
        data-player-advance=""
        onClick={() => send({ type: "advance" })}
      >
        Advance
      </button>
    </p>
  );
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error)
        : `request failed (${response.status})`,
    );
  return payload as T;
}

async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`/api/player/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}
