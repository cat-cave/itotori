// Behaviour-first test harness setup.
// - jest-dom matchers (toBeInTheDocument, toHaveClass, …) on Vitest's expect
// - auto-cleanup of the rendered tree between tests
// This file is loaded by vitest.config.ts `setupFiles`. Downstream UI nodes
// inherit exactly this harness: render real DOM, assert observable behaviour.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
