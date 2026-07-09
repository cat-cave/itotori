// xs-deep-jumps — the cross-surface addressable jump link.
//
// ONE link primitive for the finding -> line -> wiki -> frame chain. Renders
// an addressable entity (unit / scene / route / character / term / run /
// finding) as a stable deep-link via the EXISTING fnd-addressable-routing
// scheme (`hrefForAddressable`), so any surface that surfaces an addressable
// id can offer the jump to its focused surface. Surfaces that do not yet own
// a full screen still resolve (AddressableFocusScreen) — the backbone is
// usable from any jump source.
//
// When the id is null / empty the jump degrades to a plain <span> (the
// `fallback` label) — it NEVER emits an <a> with an empty/invented target.
// `addressableJumpHref` is the pure half (null on empty) so a non-JSX caller
// or a unit test can resolve the href without rendering.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; the
// data-jump-kind / data-jump-id attrs pin the resolved href per kind/id only.

import type { ReactNode } from "react";
import {
  hrefForAddressable,
  type AddressableKind,
  type AddressableTarget,
} from "./addressable-routing.js";

/** Optional scope forwarded as the deep-link `projectId` / `localeBranchId` query. */
export type AddressableJumpScope = Pick<
  AddressableTarget,
  "projectId" | "localeBranchId" | "unitId"
>;

/**
 * Resolve the stable href for an addressable jump. Returns `null` when the id
 * is null / empty / whitespace so callers render plain text instead of a link
 * to an invented destination. Pure — safe to call from non-JSX contexts.
 */
export function addressableJumpHref(
  kind: AddressableKind,
  id: string | null,
  scope: AddressableJumpScope = emptyScope,
): string | null {
  const trimmed = id === null ? "" : id.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return hrefForAddressable({ kind, id: trimmed, ...scope });
}

const emptyScope: AddressableJumpScope = {
  projectId: null,
  localeBranchId: null,
  unitId: null,
};

export type AddressableJumpProps = {
  kind: AddressableKind;
  /** The addressable id; when null / empty the jump degrades to plain text. */
  id: string | null;
  /**
   * Optional project / locale-branch scope (forwarded as query). Omitted, the
   * destination surface falls back to its own project-status resolution.
   */
  projectId?: string | null;
  localeBranchId?: string | null;
  /** Optional nested unit focus (scene deep-links). */
  unitId?: string | null;
  /** Link label (defaults to the id). */
  children?: ReactNode;
  /** Label rendered when the id is null / empty (defaults to "—"). */
  fallback?: ReactNode;
  className?: string;
};

/**
 * Render an addressable entity as a cross-surface jump link. When the id is
 * null / empty, renders the `fallback` as plain text (no invented destination).
 */
export function AddressableJump({
  kind,
  id,
  projectId,
  localeBranchId,
  unitId,
  children,
  fallback = "—",
  className,
}: AddressableJumpProps): ReactNode {
  const href = addressableJumpHref(kind, id, {
    projectId: projectId ?? null,
    localeBranchId: localeBranchId ?? null,
    unitId: unitId ?? null,
  });
  if (href === null) {
    // The fallback is plain text, NOT a jump link — it carries neither the
    // jump className nor data-jump-kind, so a className / data-jump-kind
    // selector counts only REAL <a> jumps and a degraded slot is told apart
    // by its data-jump-resolved="false" marker. No invented destination.
    return <span data-jump-resolved="false">{fallback}</span>;
  }
  const trimmed = (id ?? "").trim();
  return (
    <a href={href} className={className} data-jump-kind={kind} data-jump-id={trimmed}>
      {children ?? trimmed}
    </a>
  );
}
