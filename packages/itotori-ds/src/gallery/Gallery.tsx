import { useState } from "react";
import type { ReactNode } from "react";
import {
  Badge,
  BiText,
  CommandPalette,
  ComparisonPane,
  DataTable,
  LocalizationProgress,
  NavPills,
  Panel,
  ProgressBar,
  StatReadout,
  ToastViewport,
} from "../components/index.js";
import type { CommandItem } from "../components/navigation/CommandPalette.js";
import type { ToastData } from "../components/feedback/Toast.js";
import {
  commandItems,
  costSeries,
  galleryStatuses,
  galleryToasts,
  localizationStages,
  localizationTotal,
  passLedger,
} from "./fixtures.js";

/** A labelled group of components in the gallery. */
function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="gallery-section" data-section={id} aria-label={title}>
      <h2 className="gallery-section__title">{title}</h2>
      <div className="gallery-section__body">{children}</div>
    </section>
  );
}

/**
 * The component gallery — the visual reference AND the behaviour-test surface.
 * Every ported component renders here against neutral, game-agnostic fixtures.
 */
export function Gallery(): ReactNode {
  const [pill, setPill] = useState("overview");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [lastCommand, setLastCommand] = useState<CommandItem | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>(galleryToasts);

  return (
    <div className="gallery">
      <header className="gallery__masthead">
        <span className="itotori-eyebrow">design system</span>
        <h1 className="gallery__wordmark">
          Itotori<span className="gallery__dot">.</span> component gallery
        </h1>
        <p className="gallery__lede">
          Dusk Observatory — the ported token set + core component vocabulary, rendered against a
          neutral configured-target corpus.
        </p>
      </header>

      <Section id="core" title="core — Badge (auto-tone from status)">
        <div className="gallery-row">
          {galleryStatuses.map((status) => (
            <Badge key={status} status={status} />
          ))}
        </div>
      </Section>

      <Section id="layout" title="layout — Panel (VN config-menu window)">
        <div className="gallery-grid">
          <Panel
            title="Localization progress"
            eyebrow="overview"
            lamps={<Badge status="running" />}
          >
            <LocalizationProgress
              total={localizationTotal}
              stages={localizationStages}
              cycle={{ current: 4, of: 6 }}
              eta="eta ~2h"
            />
          </Panel>
          <Panel title="Model cost / posture" eyebrow="spend" tone="mint" hoverable>
            <div className="gallery-row">
              <StatReadout
                label="pass 4 spend"
                value="$0.5107"
                mono
                delta="+$0.03"
                deltaTone="neutral"
                series={costSeries}
              />
              <StatReadout
                label="zdr posture"
                value="zdr=true"
                delta="data_collection=none"
                deltaTone="ok"
              />
            </div>
          </Panel>
        </div>
      </Section>

      <Section id="data" title="data — DataTable, ProgressBar, StatReadout">
        <Panel title="Pass ledger" eyebrow="passes">
          <DataTable
            caption="pass N → feedback → N+1"
            rows={passLedger}
            getRowKey={(row) => `pass-${row.pass}`}
            columns={[
              { key: "pass", header: "pass", render: (r) => <code>pass {r.pass}</code> },
              { key: "score", header: "score", align: "end", render: (r) => r.score.toFixed(1) },
              { key: "feedback", header: "feedback", align: "end", render: (r) => r.feedback },
              { key: "note", header: "note", render: (r) => r.note },
              { key: "status", header: "status", render: (r) => <Badge status={r.status} /> },
            ]}
          />
        </Panel>
        <div className="gallery-stack">
          <ProgressBar value={66.5} label="proven" showValue max={100} />
          <ProgressBar value={100} running tone="amber" label="pass running" />
        </div>
      </Section>

      <Section id="localization" title="data / localization — ComparisonPane, BiText">
        <ComparisonPane
          unit="bridge-unit:scene-07-line-014"
          source="放課後、屋上で待ってる。"
          draft="I'll be waiting on the roof after school."
          draftMeta={<Badge status="in_review" />}
        />
        <BiText
          speaker="Aoi"
          sourceLocale="ja-JP"
          targetLocale="en-US"
          source="また明日、ね。"
          translation="See you tomorrow, okay?"
        />
      </Section>

      <Section id="navigation" title="navigation — NavPills, CommandPalette (⌘K)">
        <NavPills
          label="surfaces"
          activeId={pill}
          onSelect={setPill}
          items={[
            { id: "overview", label: "Overview" },
            { id: "review", label: "Review", badge: 12 },
            { id: "player", label: "Player" },
            { id: "benchmark", label: "Benchmark" },
            { id: "wiki", label: "Wiki" },
          ]}
        />
        <div className="gallery-row">
          <button type="button" className="gallery-btn" onClick={() => setPaletteOpen(true)}>
            Open command palette (⌘K)
          </button>
          {lastCommand && (
            <span className="gallery-note">
              jumped to <code>{lastCommand.id}</code>
            </span>
          )}
        </div>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          items={commandItems}
          onSelect={setLastCommand}
        />
      </Section>

      <Section id="feedback" title="feedback — Toast">
        <button
          type="button"
          className="gallery-btn"
          onClick={() =>
            setToasts((t) => [
              ...t,
              { id: `t-${Date.now()}`, message: "New toast pushed.", tone: "ok" },
            ])
          }
        >
          Push a toast
        </button>
        <ToastViewport
          toasts={toasts}
          onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
        />
      </Section>
    </div>
  );
}
