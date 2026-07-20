// @vitest-environment jsdom
//
// The Studio extract form is a projection of registry capabilities. This keeps
// engine-specific fields out of the screen and proves each registered adapter
// renders its own controls rather than inheriting a RealLive-shaped form.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OnboardingScreen } from "../src/ui/screens/OnboardingScreen.js";
import { authIdentityFixture, catalogOpportunitiesFixture } from "./api-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installOnboardingFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input.toString(), "http://itotori.test");
    const body =
      url.pathname === "/api/auth/identity"
        ? authIdentityFixture
        : url.pathname === "/api/projects"
          ? { projects: [] }
          : url.pathname === "/api/catalog/opportunities"
            ? catalogOpportunitiesFixture
            : null;
    return new Response(JSON.stringify(body), {
      status: body === null ? 404 : 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("Onboarding extract form", () => {
  it("renders each selected adapter's registry-supplied fields and modes", async () => {
    installOnboardingFetch();
    render(<OnboardingScreen />);

    const adapter = await screen.findByRole("combobox", { name: "Extract adapter" });
    expect(adapter).toHaveValue("");

    fireEvent.change(adapter, { target: { value: "softpal" } });
    expect(screen.getByLabelText("Game root path")).toBeInTheDocument();
    expect(screen.queryByLabelText("Game id")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Entire game" })).toBeInTheDocument();

    fireEvent.change(adapter, { target: { value: "rpg-maker" } });
    expect(screen.getByLabelText("Game www/ directory")).toBeInTheDocument();
    expect(screen.getByLabelText("Game id")).toBeInTheDocument();
    expect(screen.queryByLabelText("Scene id")).not.toBeInTheDocument();

    fireEvent.change(adapter, { target: { value: "reallive" } });
    const mode = screen.getByRole("combobox", { name: "Extract mode" });
    expect(screen.getByLabelText("Vault canonical id")).toBeInTheDocument();
    expect(screen.getByLabelText("Game root path")).toBeInTheDocument();
    fireEvent.change(mode, { target: { value: "per-scene" } });
    expect(screen.getByLabelText("Scene id")).toBeInTheDocument();
  });
});
