import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { LocalizationProgress } from "../components/data/LocalizationProgress.js";
import { localizationStages, localizationTotal } from "./fixtures.js";

const meta = {
  title: "data/LocalizationProgress",
  component: LocalizationProgress,
  args: {
    total: localizationTotal,
    stages: localizationStages,
    cycle: { current: 4, of: 6 },
    eta: "eta ~2h",
  },
} satisfies Meta<typeof LocalizationProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 18240 / 27407 ≈ 66.6% (text may be split across nodes; match via role).
    await expect(
      canvas.getByRole("img", { name: "18240 of 27407 units proven" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("66.6%")).toBeInTheDocument();
    await expect(canvas.getAllByText("proven").length).toBeGreaterThanOrEqual(1);
    await expect(canvas.getByText("eta ~2h")).toBeInTheDocument();
  },
};
