import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export type ToastTone = "neutral" | "ok" | "critical";

export interface ToastData {
  id: string;
  message: ReactNode;
  tone?: ToastTone;
}

export interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
  className?: string;
}

/** Toast — a single transient notification (dismissable). */
export function Toast({ toast, onDismiss, className }: ToastProps): ReactNode {
  const tone = toast.tone ?? "neutral";
  return (
    <div
      className={cx("itotori-toast", `itotori-toast--${tone}`, "itotori-riser", className)}
      role="status"
      aria-live="polite"
      data-toast-id={toast.id}
      data-toast-tone={tone}
    >
      <span className="itotori-toast__dot" aria-hidden="true" />
      <span className="itotori-toast__message">{toast.message}</span>
      <button
        type="button"
        className="itotori-toast__dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

export interface ToastViewportProps {
  toasts: ReadonlyArray<ToastData>;
  onDismiss: (id: string) => void;
  className?: string;
}

/**
 * ToastViewport — the stacked, live region that renders the toast queue. One
 * viewport at the shell; `pushToast`/`dismissToast` live in the host store.
 */
export function ToastViewport({ toasts, onDismiss, className }: ToastViewportProps): ReactNode {
  return (
    <div className={cx("itotori-toast-viewport", className)} aria-live="polite">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
