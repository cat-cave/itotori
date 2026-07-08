import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface PanelProps {
  /** Panel title, rendered in the VN config-window title bar. */
  title?: ReactNode;
  /** Small pixel eyebrow kicker above/inside the title bar. */
  eyebrow?: ReactNode;
  /** Trailing title-bar slot (actions, counts, a status badge). */
  lamps?: ReactNode;
  /** Tone accent for the leading title tick (default amber). */
  tone?: "amber" | "mint" | "sakura";
  /** Draw the full VN window frame + shadow (default true). */
  frame?: boolean;
  /** Add a hover lift (for panels that act as a link/target). */
  hoverable?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * Panel — the VN config-menu window. A title bar (vertical sheen + a leading
 * amber tick), a night body, a soft shadow, and a 1px inset top-highlight bevel.
 * This is the primary layout container for every surface.
 */
export function Panel({
  title,
  eyebrow,
  lamps,
  tone = "amber",
  frame = true,
  hoverable = false,
  children,
  className,
}: PanelProps): ReactNode {
  return (
    <section
      className={cx(
        "itotori-panel",
        frame && "itotori-panel--frame",
        hoverable && "itotori-lift",
        `itotori-panel--tone-${tone}`,
        className,
      )}
    >
      {(title || eyebrow || lamps) && (
        <header className="itotori-panel__titlebar">
          <span className="itotori-panel__tick" aria-hidden="true" />
          <div className="itotori-panel__heading">
            {eyebrow && <span className="itotori-eyebrow">{eyebrow}</span>}
            {title && <h2 className="itotori-panel__title">{title}</h2>}
          </div>
          {lamps && <div className="itotori-panel__lamps">{lamps}</div>}
        </header>
      )}
      <div className="itotori-panel__body">{children}</div>
    </section>
  );
}
