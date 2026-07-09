import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { BiText } from "../components/localization/BiText.js";

const meta = {
  title: "localization/BiText",
  component: BiText,
  args: {
    speaker: "Aoi",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    source: "また明日、ね。",
    translation: "See you tomorrow, okay?",
    onCopy: fn(),
  },
} satisfies Meta<typeof BiText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("また明日、ね。")).toBeInTheDocument();
    await expect(canvas.getByText("See you tomorrow, okay?")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "copy" }));
    // Observable behavior: the injected copy handler receives the translation.
    // (Transient "copied" label is best-effort UI chrome, covered in Vitest.)
    await expect(args.onCopy).toHaveBeenCalledWith("See you tomorrow, okay?");
  },
};
