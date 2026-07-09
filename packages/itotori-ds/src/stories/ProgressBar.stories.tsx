import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ProgressBar } from "../components/data/ProgressBar.js";

const meta = {
  title: "data/ProgressBar",
  component: ProgressBar,
  args: {
    value: 66.5,
    max: 100,
    label: "proven",
    showValue: true,
  },
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole("progressbar", { name: "proven" });
    await expect(bar).toHaveAttribute("aria-valuenow", "66.5");
  },
};

export const Running: Story = {
  args: {
    value: 100,
    running: true,
    tone: "amber",
    label: "pass running",
    showValue: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole("progressbar", { name: "pass running" });
    // Running/indeterminate bars omit aria-valuenow.
    await expect(bar).not.toHaveAttribute("aria-valuenow");
  },
};
