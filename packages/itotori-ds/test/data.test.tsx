import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComparisonPane } from "../src/components/data/ComparisonPane.js";
import { DataTable } from "../src/components/data/DataTable.js";
import { LocalizationProgress } from "../src/components/data/LocalizationProgress.js";
import { ProgressBar } from "../src/components/data/ProgressBar.js";
import { StatReadout } from "../src/components/data/StatReadout.js";

interface Row {
  id: string;
  pass: number;
  score: number;
}

const rows: Row[] = [
  { id: "p1", pass: 1, score: 3.4 },
  { id: "p2", pass: 2, score: 3.9 },
];

describe("data / DataTable", () => {
  it("renders headers and a cell per row", () => {
    render(
      <DataTable
        rows={rows}
        getRowKey={(r) => r.id}
        columns={[
          { key: "pass", header: "pass", render: (r) => `pass ${r.pass}` },
          { key: "score", header: "score", render: (r) => r.score },
        ]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "pass" })).toBeInTheDocument();
    expect(screen.getByText("pass 1")).toBeInTheDocument();
    expect(screen.getByText("pass 2")).toBeInTheDocument();
  });

  it("activates a row on click when onRowActivate is provided", async () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable
        rows={rows}
        getRowKey={(r) => r.id}
        onRowActivate={onRowActivate}
        columns={[{ key: "pass", header: "pass", render: (r) => `pass ${r.pass}` }]}
      />,
    );
    await userEvent.click(screen.getByText("pass 2"));
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });

  it("renders the empty label when there are no rows", () => {
    render(
      <DataTable
        rows={[]}
        getRowKey={(r: Row) => r.id}
        emptyLabel="Nothing here."
        columns={[{ key: "pass", header: "pass", render: (r: Row) => r.pass }]}
      />,
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
  });
});

describe("data / ProgressBar", () => {
  it("exposes an accessible progressbar with the current value", () => {
    render(<ProgressBar value={66} max={100} label="proven" />);
    const bar = screen.getByRole("progressbar", { name: "proven" });
    expect(bar).toHaveAttribute("aria-valuenow", "66");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("clamps out-of-range values", () => {
    render(<ProgressBar value={150} max={100} label="over" />);
    expect(screen.getByRole("progressbar", { name: "over" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });
});

describe("data / LocalizationProgress", () => {
  it("renders the proven percentage headline and every stage in the legend", () => {
    render(
      <LocalizationProgress
        total={100}
        stages={[
          { key: "proven", label: "proven", count: 40, tone: "mint" },
          { key: "translated", label: "drafted", count: 60, tone: "sakura" },
        ]}
        cycle={{ current: 2, of: 4 }}
      />,
    );
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("drafted")).toBeInTheDocument();
  });
});

describe("data / ComparisonPane", () => {
  it("renders source and draft with the unit token", () => {
    render(
      <ComparisonPane unit="bridge-unit:s07-l14" source="源のテキスト" draft="the drafted line" />,
    );
    expect(screen.getByText("bridge-unit:s07-l14")).toBeInTheDocument();
    expect(screen.getByText("源のテキスト")).toBeInTheDocument();
    expect(screen.getByText("the drafted line")).toBeInTheDocument();
  });
});

describe("data / StatReadout", () => {
  it("renders the value, unit and a sparkline when a series is given", () => {
    render(<StatReadout label="spend" value="$0.51" unit="USD" series={[1, 3, 2, 4]} />);
    expect(screen.getByText("$0.51")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "trend" })).toBeInTheDocument();
  });
});
