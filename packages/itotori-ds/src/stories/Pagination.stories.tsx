import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Pagination } from "../components/navigation/Pagination.js";

const meta = {
  title: "navigation/Pagination",
  component: Pagination,
  args: {
    label: "Gallery pager preview",
    page: 1,
    pageCount: 5,
    totalItems: 120,
    onPrevious: fn(),
    onNext: fn(),
  },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("navigation", { name: "Gallery pager preview" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("Page 2 of 5 · 120 items")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Previous page" }));
    await userEvent.click(canvas.getByRole("button", { name: "Next page" }));
    await expect(args.onPrevious).toHaveBeenCalledTimes(1);
    await expect(args.onNext).toHaveBeenCalledTimes(1);
  },
};

export const AtStart: Story = {
  args: {
    page: 0,
    pageCount: 3,
    totalItems: 20,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Next page" })).toBeEnabled();
  },
};

export const AtEnd: Story = {
  args: {
    page: 4,
    pageCount: 5,
    totalItems: 120,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Next page" })).toBeDisabled();
  },
};
