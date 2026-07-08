import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastViewport } from "../src/components/feedback/Toast.js";
import type { ToastData } from "../src/components/feedback/Toast.js";

const toasts: ToastData[] = [
  { id: "t1", message: "Approved as-is — unit marked proven.", tone: "ok" },
  { id: "t2", message: "Correction queued for pass 5.", tone: "neutral" },
];

describe("feedback / Toast", () => {
  it("renders every queued toast in a live region", () => {
    render(<ToastViewport toasts={toasts} onDismiss={() => {}} />);
    expect(screen.getByText("Approved as-is — unit marked proven.")).toBeInTheDocument();
    expect(screen.getByText("Correction queued for pass 5.")).toBeInTheDocument();
  });

  it("dismisses a toast by id", async () => {
    const onDismiss = vi.fn();
    render(<ToastViewport toasts={toasts} onDismiss={onDismiss} />);
    const dismissButtons = screen.getAllByRole("button", { name: "Dismiss notification" });
    await userEvent.click(dismissButtons[0] as HTMLElement);
    expect(onDismiss).toHaveBeenCalledWith("t1");
  });
});
