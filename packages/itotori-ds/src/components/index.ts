// Component barrel — grouped as the design language groups them
// (core / layout / data / localization / navigation / feedback).

// core
export { Badge } from "./core/Badge.js";
export type { BadgeProps } from "./core/Badge.js";

// layout
export { Panel } from "./layout/Panel.js";
export type { PanelProps } from "./layout/Panel.js";

// data
export { DataTable } from "./data/DataTable.js";
export type { DataTableColumn, DataTableProps } from "./data/DataTable.js";
export { ProgressBar } from "./data/ProgressBar.js";
export type { ProgressBarProps } from "./data/ProgressBar.js";
export { ComparisonPane } from "./data/ComparisonPane.js";
export type { ComparisonPaneProps } from "./data/ComparisonPane.js";
export { LocalizationProgress } from "./data/LocalizationProgress.js";
export type { LocalizationProgressProps, LocalizationStage } from "./data/LocalizationProgress.js";
export { StatReadout } from "./data/StatReadout.js";
export type { StatReadoutProps } from "./data/StatReadout.js";
export { ContestantSwatch } from "./data/ContestantSwatch.js";
export type { ContestantRole, ContestantSwatchProps } from "./data/ContestantSwatch.js";
export { RedactionFrame, shouldRedactFrame } from "./data/RedactionFrame.js";
export type { RedactionFrameProps, RedactionDecision } from "./data/RedactionFrame.js";

// localization
export { BiText } from "./localization/BiText.js";
export type { BiTextProps } from "./localization/BiText.js";

// navigation
export { NavPills } from "./navigation/NavPills.js";
export type { NavPillItem, NavPillsProps } from "./navigation/NavPills.js";
export { CommandPalette, useCommandPaletteShortcut } from "./navigation/CommandPalette.js";
export type { CommandItem, CommandPaletteProps } from "./navigation/CommandPalette.js";
export { Pagination } from "./navigation/Pagination.js";
export type { PaginationProps } from "./navigation/Pagination.js";

// feedback
export { Toast, ToastViewport } from "./feedback/Toast.js";
export type { ToastData, ToastProps, ToastTone, ToastViewportProps } from "./feedback/Toast.js";

// diagram
export { RouteMap } from "./diagram/RouteMap.js";
export type {
  RouteMapCoverageState,
  RouteMapEdge,
  RouteMapNode,
  RouteMapProps,
} from "./diagram/RouteMap.js";
