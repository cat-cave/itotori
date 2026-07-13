// shell-toasts (HI-FI STUDIO EPIC · Shell) — the SPA toast host.
//
// A shell-level React context that owns the toast queue + auto-dismiss
// timers and renders the ds `<ToastViewport>`. Downstream surfaces (result
// revision, launch-pass, play flag) enqueue through `useToast()` /
// `useWorkflowHandoffToasts()` so workflow handoffs surface as legible
// notifications without each screen owning its own toast stack.
//
// The ds `Toast` / `ToastViewport` stay pure prop consumers (no context);
// the host owns queue identity, a 4200ms auto-dismiss window, and manual
// dismiss. Empty queue → empty viewport (no
// ghost chrome). No game is named; className-based, ds tokens only.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ToastViewport, type ToastData, type ToastTone } from "@itotori/ds";

/** Default auto-dismiss window for transient workflow handoff notices. */
export const DEFAULT_TOAST_DURATION_MS = 4200;

export type ToastPushInput = {
  message: ReactNode;
  tone?: ToastTone;
  /**
   * Auto-dismiss delay in ms. Defaults to {@link DEFAULT_TOAST_DURATION_MS}.
   * Pass `0` (or a negative number) to keep the toast until manual dismiss.
   */
  durationMs?: number;
  /** Stable id; generated when omitted. */
  id?: string;
};

export interface ToastHostValue {
  /** Currently visible toasts (oldest → newest). */
  toasts: ReadonlyArray<ToastData>;
  /** Enqueue a toast; returns its id. Auto-dismisses unless durationMs ≤ 0. */
  pushToast: (input: ToastPushInput) => string;
  /** Dismiss a toast by id (no-op when unknown). */
  dismissToast: (id: string) => void;
}

const ToastHostContext = createContext<ToastHostValue | null>(null);

let toastSeq = 0;
function nextToastId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Override the default auto-dismiss window (tests may pass a short value). */
  defaultDurationMs?: number;
}

/**
 * ToastProvider — mounts once at the SPA shell. Renders children, then the
 * ds ToastViewport so every routed screen inherits the same toast surface.
 */
export function ToastProvider({
  children,
  defaultDurationMs = DEFAULT_TOAST_DURATION_MS,
}: ToastProviderProps): ReactNode {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const pushToast = useCallback(
    (input: ToastPushInput): string => {
      const id = input.id ?? nextToastId();
      const tone: ToastTone = input.tone ?? "neutral";
      const toast: ToastData = { id, message: input.message, tone };
      // Replace any prior toast with the same id so re-push is idempotent.
      clearTimer(id);
      setToasts((current) => [...current.filter((entry) => entry.id !== id), toast]);
      const durationMs = input.durationMs ?? defaultDurationMs;
      if (durationMs > 0) {
        const handle = setTimeout(() => {
          timers.current.delete(id);
          setToasts((current) => current.filter((entry) => entry.id !== id));
        }, durationMs);
        timers.current.set(id, handle);
      }
      return id;
    },
    [clearTimer, defaultDurationMs],
  );

  // Clear outstanding timers on unmount so a remounted shell never leaks.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) {
        clearTimeout(handle);
      }
      map.clear();
    };
  }, []);

  const value = useMemo<ToastHostValue>(
    () => ({ toasts, pushToast, dismissToast }),
    [toasts, pushToast, dismissToast],
  );

  return (
    <ToastHostContext.Provider value={value}>
      {children}
      <ToastViewport
        toasts={toasts}
        onDismiss={dismissToast}
        className="itotori-shell-toast-viewport"
      />
    </ToastHostContext.Provider>
  );
}

export function useToast(): ToastHostValue {
  const value = useContext(ToastHostContext);
  if (value === null) {
    throw new Error("useToast must be used inside a <ToastProvider>");
  }
  return value;
}
