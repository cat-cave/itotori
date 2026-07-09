import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Badge } from "../components/core/Badge.js";
import { ComparisonPane } from "../components/data/ComparisonPane.js";

const meta = {
  title: "data/ComparisonPane",
  component: ComparisonPane,
  args: {
    unit: "bridge-unit:scene-07-line-014",
    source: "放課後、屋上で待ってる。",
    draft: "I'll be waiting on the roof after school.",
    draftMeta: <Badge status="in_review" />,
  },
} satisfies Meta<typeof ComparisonPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("放課後、屋上で待ってる。")).toBeInTheDocument();
    await expect(canvas.getByText("I'll be waiting on the roof after school.")).toBeInTheDocument();
    await expect(canvas.getByText("bridge-unit:scene-07-line-014")).toBeInTheDocument();
  },
};
