import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface CommandItem {
  id: string;
  /** Primary label (sentence case). */
  label: string;
  /** Group heading (e.g. "scenes", "characters", "runs", "actions"). */
  group?: string;
  /** Trailing hint / machine token (mono). */
  hint?: ReactNode;
  /** Extra search keywords not shown in the label. */
  keywords?: ReadonlyArray<string>;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: ReadonlyArray<CommandItem>;
  onSelect: (item: CommandItem) => void;
  placeholder?: string;
  /** Label for the dialog. */
  label?: string;
}

/**
 * Wire the ⌘K / Ctrl+K global shortcut to open the palette. The connective
 * tissue across every surface; downstream hosts call this once at the shell.
 */
export function useCommandPaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

function matches(item: CommandItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = [item.label, item.group ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
  return hay.includes(q);
}

/**
 * CommandPalette (⌘K) — jump to any scene / character / term / run / action
 * across surfaces. Query-filtered, arrow-key navigable, Enter to select, Esc to
 * close. The primary connective tissue of the studio.
 */
export function CommandPalette({
  open,
  onClose,
  items,
  onSelect,
  placeholder = "Jump to scene, character, run, action…",
  label = "Command palette",
}: CommandPaletteProps): ReactNode {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => items.filter((item) => matches(item, query)), [items, query]);

  // Reset query + focus the input each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  // Keep the active index in range as the filter narrows.
  useEffect(() => {
    setActiveIndex((i) => (i >= filtered.length ? 0 : i));
  }, [filtered.length]);

  const choose = useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return;
      onSelect(item);
      onClose();
    },
    [onSelect, onClose],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) =>
          filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        choose(filtered[activeIndex]);
      }
    },
    [filtered, activeIndex, choose, onClose],
  );

  if (!open) return null;

  return (
    <div className="itotori-command__scrim" onMouseDown={onClose}>
      <div
        className="itotori-command"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="itotori-command__field">
          <span className="itotori-command__prompt" aria-hidden="true">
            ⌘K
          </span>
          <input
            ref={inputRef}
            type="text"
            className="itotori-command__input"
            placeholder={placeholder}
            aria-label={placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="itotori-command__list" role="listbox" aria-label={label}>
          {filtered.length === 0 ? (
            <li className="itotori-command__empty">No matches.</li>
          ) : (
            filtered.map((item, index) => (
              <li key={item.id} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  className={cx(
                    "itotori-command__item",
                    index === activeIndex && "itotori-command__item--active",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(item)}
                >
                  {item.group && <span className="itotori-command__group">{item.group}</span>}
                  <span className="itotori-command__label">{item.label}</span>
                  {item.hint != null && <code className="itotori-command__hint">{item.hint}</code>}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
