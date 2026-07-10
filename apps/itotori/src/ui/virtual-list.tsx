import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from "react";
import "./virtual-list.css";

export type VirtualListProps<T> = {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  /** Estimated row content height, excluding the inter-row gap. */
  itemHeight: number;
  renderItem: (item: T, index: number) => ReactNode;
  ariaLabel: string;
  className?: string;
  overscan?: number;
  /** Gap between rows, included in scroll pitch math. */
  rowGap?: number;
  viewportHeight?: number;
};

export function VirtualList<T>({
  items,
  getItemKey,
  itemHeight,
  renderItem,
  ariaLabel,
  className,
  overscan = 4,
  rowGap = 8,
  viewportHeight = 420,
}: VirtualListProps<T>): ReactNode {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measuredHeight, setMeasuredHeight] = useState(viewportHeight);
  const [itemSizes, setItemSizes] = useState<ReadonlyMap<number, number>>(() => new Map());
  const itemSizesRef = useRef(itemSizes);
  itemSizesRef.current = itemSizes;
  const height = measuredHeight > 0 ? measuredHeight : viewportHeight;

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const current = event.currentTarget;
    setScrollTop(current.scrollTop);
    if (current.clientHeight > 0 && current.clientHeight !== measuredHeight) {
      setMeasuredHeight(current.clientHeight);
    }
  };

  const geometry = useMemo(() => {
    const offsets: number[] = [];
    let nextOffset = 0;
    for (let index = 0; index < items.length; index += 1) {
      offsets.push(nextOffset);
      nextOffset +=
        (itemSizes.get(index) ?? itemHeight) + (index === items.length - 1 ? 0 : rowGap);
    }
    return {
      offsets,
      totalHeight: nextOffset,
      sizeAt: (index: number): number => itemSizes.get(index) ?? itemHeight,
    };
  }, [itemHeight, itemSizes, items.length, rowGap]);

  const window = useMemo(() => {
    let start = 0;
    while (
      start < items.length &&
      geometry.offsets[start]! + geometry.sizeAt(start) < scrollTop
    ) {
      start += 1;
    }
    start = Math.max(0, start - overscan);

    let end = start;
    const viewportEnd = scrollTop + height;
    while (end < items.length && geometry.offsets[end]! < viewportEnd) {
      end += 1;
    }
    end = Math.min(items.length, end + overscan);
    return { start, end };
  }, [geometry, height, items.length, overscan, scrollTop]);

  const renderedItems = items.slice(window.start, window.end);
  const rowPitch = itemHeight + rowGap;

  const measureItem = useCallback(
    (index: number, node: HTMLDivElement | null): void => {
      if (node === null) {
        return;
      }
      const measured = Math.ceil(node.getBoundingClientRect().height || node.offsetHeight);
      if (measured <= 0 || measured === (itemSizesRef.current.get(index) ?? itemHeight)) {
        return;
      }
      setItemSizes((current) => {
        if ((current.get(index) ?? itemHeight) === measured) {
          return current;
        }
        const next = new Map(current);
        next.set(index, measured);
        return next;
      });
    },
    [itemHeight],
  );

  return (
    <div
      ref={viewportRef}
      className={["itotori-virtual-list", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
      data-virtualized="true"
      data-total-items={items.length}
      data-rendered-items={renderedItems.length}
      data-row-gap={rowGap}
      data-row-pitch={rowPitch}
      onScroll={onScroll}
      style={
        {
          "--itotori-virtual-list-height": `${viewportHeight}px`,
          "--itotori-virtual-list-row-gap": `${rowGap}px`,
        } as CSSProperties
      }
    >
      <div className="itotori-virtual-list__spacer" style={{ height: geometry.totalHeight }}>
        <div
          className="itotori-virtual-list__window"
          style={{ transform: `translateY(${geometry.offsets[window.start] ?? 0}px)` }}
        >
          {renderedItems.map((item, index) => {
            const absoluteIndex = window.start + index;
            return (
              <div
                ref={(node) => measureItem(absoluteIndex, node)}
                key={getItemKey(item, absoluteIndex)}
                className="itotori-virtual-list__item"
                style={{ minHeight: itemHeight }}
              >
                {renderItem(item, absoluteIndex)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
