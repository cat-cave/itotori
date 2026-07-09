import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { StatReadout } from "../components/data/StatReadout.js";
import { costSeries } from "./fixtures.js";

const meta = {
  title: "data/StatReadout",
  component: StatReadout,
  args: {
    label: "pass 4 spend",
    value: "$0.5107",
    mono: true,
    delta: "+$0.03",
    deltaTone: "neutral" as const,
    series: costSeries,
  },
} satisfies Meta<typeof StatReadout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("pass 4 spend")).toBeInTheDocument();
    await expect(canvas.getByText("$0.5107")).toBeInTheDocument();
  },
};

export const ZdrPosture: Story = {
  args: {
    label: "zdr posture",
    value: "zdr=true",
    mono: false,
    delta: "data_collection=none",
    deltaTone: "ok",
  },
};
