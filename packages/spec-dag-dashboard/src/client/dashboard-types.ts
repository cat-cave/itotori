import type { EnrichedNode } from "./client-types.js";

export type AnyNode = EnrichedNode & Record<string, unknown>;

export interface DashboardState {
  q: string;
  status: Set<string>;
  priority: Set<string>;
  target: Set<string>;
  project: Set<string>;
  group: Set<string>;
  issuesOnly: boolean;
  readyOnly: boolean;
  sort: string;
  sel: string | null;
}

export interface Position {
  x: number;
  y: number;
}
