// Gallery fixtures — a NEUTRAL, game-agnostic placeholder corpus. A specific
// title is config, never baked in (see docs/design/hifi-brief.md). Numbers
// mirror the shapes the real dashboards render (locales, statuses, micros-USD,
// unit counts) but are not live.

import type { CommandItem } from "../components/navigation/CommandPalette.js";
import type { LocalizationStage } from "../components/data/LocalizationProgress.js";
import type { ToastData } from "../components/feedback/Toast.js";
import { STATUS_VOCABULARY } from "../status.js";

export const galleryStatuses = STATUS_VOCABULARY;

export const localizationTotal = 27_407;

export const localizationStages: LocalizationStage[] = [
  { key: "proven", label: "proven", count: 18_240, tone: "mint" },
  { key: "revised", label: "revised", count: 3_100, tone: "cyan" },
  { key: "qa", label: "in qa", count: 2_050, tone: "amber" },
  { key: "translated", label: "drafted", count: 3_017, tone: "sakura" },
  { key: "pending", label: "pending", count: 1_000, tone: "neutral" },
];

export interface PassRow {
  pass: number;
  score: number;
  feedback: number;
  note: string;
  status: string;
}

export const passLedger: PassRow[] = [
  { pass: 1, score: 3.4, feedback: 0, note: "First full draft.", status: "succeeded" },
  { pass: 2, score: 3.9, feedback: 18, note: "Folded in 18 corrections.", status: "succeeded" },
  { pass: 3, score: 4.2, feedback: 11, note: "Tone + honorific consistency.", status: "proven" },
  { pass: 4, score: 4.4, feedback: 6, note: "Re-drafting corrected units…", status: "running" },
];

export const commandItems: CommandItem[] = [
  { id: "scene-07", label: "Scene 07 — rooftop, dusk", group: "scenes", hint: "scene-07" },
  { id: "scene-12", label: "Scene 12 — the festival", group: "scenes", hint: "scene-12" },
  { id: "char-aoi", label: "Aoi (protagonist)", group: "characters", keywords: ["lead"] },
  { id: "term-senpai", label: "senpai — glossary entry", group: "terms", hint: "term:senpai" },
  { id: "run-42", label: "Pass 4 benchmark run", group: "runs", hint: "run-042" },
  { id: "act-launch", label: "Launch next pass", group: "actions", keywords: ["redraft"] },
  { id: "act-review", label: "Open review queue", group: "actions" },
];

export const galleryToasts: ToastData[] = [
  { id: "t1", message: "Approved as-is — unit marked proven.", tone: "ok" },
  { id: "t2", message: "Correction queued for pass 5.", tone: "neutral" },
  { id: "t3", message: "Deciding review items needs a reviewer.", tone: "critical" },
];

export const costSeries = [190, 205, 198, 220, 214, 231, 207];
