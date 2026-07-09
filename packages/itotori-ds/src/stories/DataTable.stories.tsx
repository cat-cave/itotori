import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Badge } from "../components/core/Badge.js";
import { DataTable } from "../components/data/DataTable.js";
import { passLedger, type PassRow } from "./fixtures.js";

const columns = [
  { key: "pass", header: "pass", render: (r: PassRow) => <code>pass {r.pass}</code> },
  {
    key: "score",
    header: "score",
    align: "end" as const,
    render: (r: PassRow) => r.score.toFixed(1),
  },
  {
    key: "feedback",
    header: "feedback",
    align: "end" as const,
    render: (r: PassRow) => r.feedback,
  },
  { key: "note", header: "note", render: (r: PassRow) => r.note },
  {
    key: "status",
    header: "status",
    render: (r: PassRow) => <Badge status={r.status} />,
  },
];

const meta = {
  title: "data/DataTable",
  component: DataTable<PassRow>,
  args: {
    caption: "pass N → feedback → N+1",
    rows: passLedger,
    getRowKey: (row: PassRow) => `pass-${row.pass}`,
    columns,
  },
} satisfies Meta<typeof DataTable<PassRow>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("columnheader", { name: "pass" })).toBeInTheDocument();
    await expect(canvas.getByText("First full draft.")).toBeInTheDocument();
  },
};

export const ActivatableRows: Story = {
  args: {
    onRowActivate: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("First full draft."));
    await expect(args.onRowActivate).toHaveBeenCalled();
  },
};

export const Empty: Story = {
  args: {
    rows: [],
    emptyLabel: "No passes yet.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No passes yet.")).toBeInTheDocument();
  },
};
