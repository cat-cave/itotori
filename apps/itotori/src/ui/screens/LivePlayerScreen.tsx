// Browser surface for a server-held real engine session.

import { useEffect, useState, type ReactNode } from "react";
import { Panel } from "@itotori/ds";
import { ShellHeader } from "../states.js";

export const livePlayerRoutePathRegex = /^\/play\/player\/?$/u;

type LivePlayerConfig = {
  seenPath: string;
  gameexePath: string;
  g00Dir: string;
  artifactRoot: string;
  scene: number;
};

type PlayerState = {
  sessionId: string;
  scene: number;
  instructionPointer: number;
  eventIndex: number;
  waitingFor: { type: "advance" } | { type: "choice"; choiceCount: number } | null;
  ended: boolean;
  frame: { dataUrl: string; artifactId: string; width: number; height: number } | null;
};

export function parseLivePlayerRoute(pathname: string, search: string): LivePlayerConfig | null {
  if (!livePlayerRoutePathRegex.test(pathname)) return null;
  const params = new URLSearchParams(search);
  const seenPath = params.get("seenPath");
  const gameexePath = params.get("gameexePath");
  const g00Dir = params.get("g00Dir");
  const artifactRoot = params.get("artifactRoot");
  const scene = Number(params.get("scene"));
  if (
    [seenPath, gameexePath, g00Dir, artifactRoot].some(
      (value) => value === null || value.trim() === "",
    )
  )
    return null;
  if (!Number.isInteger(scene) || scene < 1 || scene > 65_535) return null;
  return {
    seenPath: seenPath!,
    gameexePath: gameexePath!,
    g00Dir: g00Dir!,
    artifactRoot: artifactRoot!,
    scene,
  };
}

export function LivePlayerScreen({ config }: { config: LivePlayerConfig | null }): ReactNode {
  const [state, setState] = useState<PlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(config !== null);

  useEffect(() => {
    if (config === null) return;
    let cancelled = false;
    void post<PlayerState>("/api/player/sessions", config).then(
      (next) => {
        if (!cancelled) {
          setState(next);
          setBusy(false);
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
    };
  }, [config]);

  const send = (input: { type: "advance" } | { type: "choice"; index: number }) => {
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
  send: (input: { type: "advance" } | { type: "choice"; index: number }) => void;
}): ReactNode {
  return (
    <Panel
      title="Live frame"
      eyebrow={`scene ${state.scene} · ip ${state.instructionPointer} · event ${state.eventIndex}`}
    >
      {state.frame === null ? (
        <p>The engine reached a boundary without a renderable text frame.</p>
      ) : (
        <img
          src={state.frame.dataUrl}
          width={state.frame.width}
          height={state.frame.height}
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
  send: (input: { type: "advance" } | { type: "choice"; index: number }) => void;
}): ReactNode {
  if (waitingFor?.type === "choice")
    return (
      <p>
        {Array.from({ length: waitingFor.choiceCount }, (_, index) => (
          <button
            key={index}
            type="button"
            disabled={busy}
            onClick={() => send({ type: "choice", index })}
          >
            Choose {index + 1}
          </button>
        ))}
      </p>
    );
  return (
    <p>
      <button type="button" disabled={busy} onClick={() => send({ type: "advance" })}>
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
