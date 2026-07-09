// fnd-caps-context — the client-side Studio capability context.
//
// A React provider that holds the actor's resolved permission VIEW
// (`StudioCapabilityPermissionView`) and exposes the four hi-fi Studio
// capabilities the screens gate on:
//
//   canFlag   — compose a playtest flag into the review queue
//   canDecide — approve / queue a correction on a queue item
//   canSteer  — launch the next localization pass
//   canReveal — unblur sensitive frames for private viewing
//
// Capabilities are permissions, NOT roles. The view is sourced server-side by
// `resolveStudioCapabilityPermissionView` (which probes each capability's
// exact Permission through the auth-002 effective-permission resolver) and
// delivered to the SPA via GET `/api/auth/capabilities`. A denied action is
// DISABLED + EXPLAINED (title / aria-description carry the denial reason) —
// never silently hidden without explanation at the context layer.
//
// Screens may still accept an explicit prop override (tests, partial mounts);
// when the prop is undefined they fall back to this context.

import {
  createContext,
  useContext,
  useMemo,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useApiQuery } from "./use-api-resource.js";

// ---------------------------------------------------------------------------
// Value surface
// ---------------------------------------------------------------------------

/** The four hi-fi Studio capabilities gated by exact permission grants. */
export type StudioCapability = "flag" | "decide" | "steer" | "reveal";

/**
 * Browser-local copy of the exact permission strings shown in disabled action
 * affordances. Server-side resolution still lives in `auth.ts`; keeping these
 * literals here avoids pulling the Node-only auth/db module into the SPA bundle.
 */
export const studioCapabilityPermissions = {
  flag: "feedback.import",
  decide: "queue.manage",
  steer: "draft.write",
  reveal: "catalog.read",
} as const satisfies Readonly<Record<StudioCapability, string>>;

export type StudioCapabilityDenials = {
  flag: string | null;
  decide: string | null;
  steer: string | null;
  reveal: string | null;
  queueRead: string | null;
  queueManage: string | null;
};

export type StudioCapabilityPermissionView = {
  actorUserId: string;
  canReadQueue: boolean;
  canManageQueue: boolean;
  canFlag: boolean;
  canDecide: boolean;
  canSteer: boolean;
  canReveal: boolean;
  denials: StudioCapabilityDenials;
  denialReasons: string[];
};

export type CapsContextValue = {
  /** Actor the view was resolved for. */
  actorUserId: string;
  canFlag: boolean;
  canDecide: boolean;
  canSteer: boolean;
  canReveal: boolean;
  /** Per-capability denial explanations (null when allowed). */
  denials: StudioCapabilityDenials;
  /**
   * Look up a single capability's gate. Returns `{ allowed, reason }` so a
   * control can disable itself AND surface the explanation (title / aria).
   */
  cap: (capability: StudioCapability) => { allowed: boolean; reason: string | null };
  /** Whether the view is still loading from the API. */
  loading: boolean;
  /** Whether a resolved view is available (ready or an explicit override). */
  ready: boolean;
};

const CapsContext = createContext<CapsContextValue | null>(null);

/** A fully-denied view used as the safe default while loading / on error. */
export function deniedStudioCapabilityView(
  actorUserId = "anonymous",
  reason = "capabilities not yet resolved",
): StudioCapabilityPermissionView {
  return {
    actorUserId,
    canReadQueue: false,
    canManageQueue: false,
    canFlag: false,
    canDecide: false,
    canSteer: false,
    canReveal: false,
    denials: {
      flag: reason,
      decide: reason,
      steer: reason,
      reveal: reason,
      queueRead: reason,
      queueManage: reason,
    },
    denialReasons: [reason],
  };
}

/** A fully-granted view for tests / local-operator fixtures. */
export function grantedStudioCapabilityView(
  actorUserId = "local-user",
): StudioCapabilityPermissionView {
  return {
    actorUserId,
    canReadQueue: true,
    canManageQueue: true,
    canFlag: true,
    canDecide: true,
    canSteer: true,
    canReveal: true,
    denials: {
      flag: null,
      decide: null,
      steer: null,
      reveal: null,
      queueRead: null,
      queueManage: null,
    },
    denialReasons: [],
  };
}

function valueFromView(
  view: StudioCapabilityPermissionView,
  loading: boolean,
  ready: boolean,
): CapsContextValue {
  return {
    actorUserId: view.actorUserId,
    canFlag: view.canFlag,
    canDecide: view.canDecide,
    canSteer: view.canSteer,
    canReveal: view.canReveal,
    denials: view.denials,
    loading,
    ready,
    cap: (capability) => {
      const allowed =
        capability === "flag"
          ? view.canFlag
          : capability === "decide"
            ? view.canDecide
            : capability === "steer"
              ? view.canSteer
              : view.canReveal;
      const reason = view.denials[capability];
      return { allowed, reason };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type CapsProviderProps = {
  /**
   * Explicit view (tests, SSR, partial mounts). When provided the provider
   * does NOT fetch `/api/auth/capabilities` — the caller owns the resolution.
   */
  value?: StudioCapabilityPermissionView;
  children: ReactNode;
};

/**
 * Provide the actor's Studio capabilities to the SPA tree.
 *
 * - With `value`: use the injected view (tests / partial mounts).
 * - Without `value`: load `auth.capabilities` through the typed client and
 *   settle into loading → ready (or a denied fallback on error).
 */
export function CapsProvider({ value, children }: CapsProviderProps): ReactNode {
  if (value !== undefined) {
    return (
      <CapsContext.Provider value={valueFromView(value, false, true)}>
        {children}
      </CapsContext.Provider>
    );
  }
  return <CapsProviderFromApi>{children}</CapsProviderFromApi>;
}

function CapsProviderFromApi({ children }: { children: ReactNode }): ReactNode {
  const query = useApiQuery("auth.capabilities", {}, "auth.capabilities");
  const contextValue = useMemo<CapsContextValue>(() => {
    if (query.state === "ready") {
      return valueFromView(query.data, false, true);
    }
    // Loading / empty / error: deny everything until a real view lands so a
    // flash of "allowed" never enables an action the actor cannot take.
    const fallback = deniedStudioCapabilityView(
      "anonymous",
      query.state === "error"
        ? (query.error.message ?? "failed to resolve capabilities")
        : "capabilities loading",
    );
    return valueFromView(fallback, query.state === "loading", false);
  }, [query]);
  return <CapsContext.Provider value={contextValue}>{children}</CapsContext.Provider>;
}

export function useCaps(): CapsContextValue {
  const value = useContext(CapsContext);
  if (value === null) {
    throw new Error("useCaps must be used inside a <CapsProvider>");
  }
  return value;
}

/**
 * Soft variant: returns null outside a provider so screens that still accept
 * explicit prop overrides can fall back without throwing (e.g. a unit test
 * that mounts ReviewerDetailScreen with `canDecide={false}` and no provider).
 */
export function useCapsOptional(): CapsContextValue | null {
  return useContext(CapsContext);
}

// ---------------------------------------------------------------------------
// CapGated control — disabled + explained when the capability is missing
// ---------------------------------------------------------------------------

export type CapGatedButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "disabled" | "title" | "aria-disabled"
> & {
  /** The Studio capability that gates this control. */
  capability: StudioCapability;
  /**
   * Optional explicit override. When set, skips the context lookup (tests /
   * screens that already resolved the gate). `true` enables; `false` disables
   * with the context denial reason (or a stable fallback).
   */
  allowed?: boolean;
  children: ReactNode;
};

/**
 * A button that is DISABLED + EXPLAINED when the actor lacks the capability.
 * The denial reason is exposed via `title` and `aria-description` so a
 * denied action is never a silent no-op. The underlying permission is named
 * in the fallback reason for auditability.
 */
export function CapGatedButton({
  capability,
  allowed: allowedOverride,
  children,
  onClick,
  ...rest
}: CapGatedButtonProps): ReactNode {
  const caps = useCapsOptional();
  const fromContext = caps?.cap(capability) ?? {
    allowed: false,
    reason: `missing ${studioCapabilityPermissions[capability]} (no caps context)`,
  };
  const allowed = allowedOverride ?? fromContext.allowed;
  const reason =
    fromContext.reason ?? `user is missing permission ${studioCapabilityPermissions[capability]}`;
  const explanation = allowed
    ? undefined
    : (reason ?? `requires ${studioCapabilityPermissions[capability]}`);
  return (
    <button
      type="button"
      {...rest}
      disabled={!allowed}
      aria-disabled={!allowed}
      title={explanation}
      aria-description={explanation}
      data-cap={capability}
      data-cap-allowed={allowed ? "true" : "false"}
      data-cap-permission={studioCapabilityPermissions[capability]}
      onClick={(event) => {
        if (!allowed) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
