import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CommandPalette } from "../components/navigation/CommandPalette.js";
import { commandItems } from "./fixtures.js";

const meta = {
  title: "navigation/CommandPalette",
  component: CommandPalette,
  args: {
    open: true,
    onClose: fn(),
    onSelect: fn(),
    items: commandItems,
    label: "Command palette",
  },
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const dialog = canvas.getByRole("dialog");
    await expect(dialog).toBeInTheDocument();
    await userEvent.type(canvas.getByRole("textbox"), "festival");
    const options = canvas.getAllByRole("option");
    await expect(options).toHaveLength(1);
    await userEvent.click(canvas.getByRole("button", { name: /the festival/ }));
    await expect(args.onSelect).toHaveBeenCalled();
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const KeyboardSelect: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox");
    await userEvent.type(input, "{ArrowDown}{Enter}");
    await expect(args.onSelect).toHaveBeenCalledWith(commandItems[1]);
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const Closed: Story = {
  args: {
    open: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
  },
};
