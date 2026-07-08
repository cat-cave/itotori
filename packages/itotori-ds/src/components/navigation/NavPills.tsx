import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface NavPillItem {
  id: string;
  label: ReactNode;
  /** Optional trailing count/badge. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface NavPillsProps {
  items: ReadonlyArray<NavPillItem>;
  activeId: string;
  onSelect: (id: string) => void;
  /** Accessible label for the nav region. */
  label?: string;
  className?: string;
}

/**
 * NavPills — the primary surface switcher. The active pill carries amber (the
 * scarce accent); the rest are muted. Rendered as a tablist for keyboard +
 * assistive-tech navigation.
 */
export function NavPills({
  items,
  activeId,
  onSelect,
  label,
  className,
}: NavPillsProps): ReactNode {
  return (
    <nav className={cx("itotori-navpills", className)} aria-label={label}>
      <div className="itotori-navpills__list" role="tablist">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              className={cx("itotori-navpills__pill", active && "itotori-navpills__pill--active")}
              onClick={() => onSelect(item.id)}
            >
              <span className="itotori-navpills__label">{item.label}</span>
              {item.badge != null && <span className="itotori-navpills__badge">{item.badge}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
