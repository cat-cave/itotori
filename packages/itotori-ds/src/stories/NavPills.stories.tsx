import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { NavPills } from "../components/navigation/NavPills.js";

const meta = {
  title: "navigation/NavPills",
  component: NavPills,
  args: {
    label: "surfaces",
    activeId: "overview",
    onSelect: fn(),
    items: [
      { id: "overview", label: "Overview" },
      { id: "review", label: "Review", badge: 12 },
      { id: "player", label: "Player" },
      { id: "benchmark", label: "Benchmark" },
      { id: "wiki", label: "Wiki" },
    ],
  },
} satisfies Meta<typeof NavPills>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(canvas.getByRole("tab", { name: /Review/ }));
    await expect(args.onSelect).toHaveBeenCalledWith("review");
  },
};
