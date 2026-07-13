import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Toast, ToastViewport } from "../components/feedback/Toast.js";
import { galleryToasts } from "./fixtures.js";

const meta = {
  title: "feedback/Toast",
  component: Toast,
  args: {
    toast: galleryToasts[0]!,
    onDismiss: fn(),
  },
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Result revision recorded for the current patch."),
    ).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss notification" }));
    await expect(args.onDismiss).toHaveBeenCalledWith("t1");
  },
};

export const ViewportQueue: Story = {
  render: (args) => (
    <ToastViewport toasts={galleryToasts} onDismiss={args.onDismiss as (id: string) => void} />
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Result revision recorded for the current patch."),
    ).toBeInTheDocument();
    await expect(canvas.getByText("Context correction scheduled for pass 5.")).toBeInTheDocument();
    const dismissButtons = canvas.getAllByRole("button", { name: "Dismiss notification" });
    await userEvent.click(dismissButtons[0]!);
    await expect(args.onDismiss).toHaveBeenCalledWith("t1");
  },
};
