import type { ReactNode } from "react";
import { cx } from "../../cx.js";

/**
 * The contestant vocabulary a swatch keys off — the §10 framing's named roles.
 * Mirrors `BmkCockpitContestantRole` (kept local to the ds so the design system
 * does not depend on the app's read-model types).
 */
export type ContestantRole = "official" | "self" | "self_nocontext" | "fan" | "mtl";

export interface ContestantSwatchProps {
  /** The contestant role whose palette token the swatch paints. */
  role: ContestantRole;
  /** Accessible label for the swatch (defaults to the role). */
  label?: string;
  className?: string;
}

/**
 * ContestantSwatch — a categorical colour chip keyed off the contestant role,
 * painted from the reconciled `--ito-contestant-*` token group. The
 * benchmark cockpit composes one ahead of each contestant label so the
 * comparative field reads at a glance, never collapsing a contestant onto a
 * semantic status hue (amber / mint / coral).
 */
export function ContestantSwatch({ role, label, className }: ContestantSwatchProps): ReactNode {
  return (
    <span
      className={cx("itotori-contestant-swatch", className)}
      data-contestant={role}
      aria-label={label ?? role}
      aria-hidden={label === undefined ? "true" : undefined}
    />
  );
}
