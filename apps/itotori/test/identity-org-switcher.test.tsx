// @vitest-environment jsdom
// shell-org-identity-switch — behavior-first test for the signed-in identity
// + organization switcher mounted in the shell toolbar.
//
// The switcher reads `auth.identity` through the typed client, renders the
// actor identity plus memberships. The shell persists the selected
// organization in browser session scope, re-issues typed reads under that
// account scope, and lands the operator back on the home surface.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiAuthIdentityResponse } from "../src/api-schema.js";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import { ShellFrame } from "../src/ui/shell-frame.js";
import {
  IdentityOrgSwitcher,
  selectInitialAccountId,
  selectedIdentityAccount,
} from "../src/ui/identity-org-switcher.js";
import { ITOTORI_SELECTED_ACCOUNT_HEADER } from "../src/ui/shell-account-scope.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";
import { authIdentityFixture, costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const secondAccount = {
  membershipId: "membership-second",
  accountId: "account-second",
  accountSlug: "second",
  accountName: "Second workspace",
  permissionSetIds: ["permission-set-second-contributor"],
  createdAt: "2026-07-08T00:00:00.000Z",
};

const identityWithTwoAccounts: ApiAuthIdentityResponse = {
  ...authIdentityFixture,
  accounts: [...authIdentityFixture.accounts, secondAccount],
};

const secondAccountDashboardStatus = {
  ...dashboardStatusFixture,
  projectId: "project-second",
  projectKey: "project-second",
  name: "project-second",
  selectedLocaleBranchId: "locale-second",
  localeBranches: [
    {
      ...dashboardStatusFixture.localeBranches[0]!,
      localeBranchId: "locale-second",
      targetLocale: "de-DE",
    },
  ],
};

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  server.resetHandlers();
});
afterAll(() => server.close());

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Local workspace" }));
  return screen.getByRole("menu", { name: "Switch identity and organization" });
}

describe("identity-org-switcher — pure helpers", () => {
  it("selects the first account as the initial organization", () => {
    expect(selectInitialAccountId(identityWithTwoAccounts)).toBe("account-local");
    expect(selectInitialAccountId({ ...identityWithTwoAccounts, accounts: [] })).toBeNull();
    expect(selectInitialAccountId(null)).toBeNull();
  });

  it("resolves the selected account, falling back to the first reachable account", () => {
    expect(selectedIdentityAccount(identityWithTwoAccounts, "account-second")?.accountName).toBe(
      "Second workspace",
    );
    expect(selectedIdentityAccount(identityWithTwoAccounts, "unknown")?.accountName).toBe(
      "Local workspace",
    );
    expect(selectedIdentityAccount(null, "account-local")).toBeNull();
  });
});

describe("identity-org-switcher — disclosure behavior", () => {
  it("lists the signed-in identity and organizations from auth.identity", async () => {
    server.use(
      http.get("*/api/auth/identity", () => apiJson("auth.identity", identityWithTwoAccounts)),
    );
    render(<IdentityOrgSwitcher />);

    expect(await screen.findByRole("button", { name: "Local workspace" })).toBeInTheDocument();
    const panel = openPanel();

    const identityGroup = within(panel).getByRole("group", { name: "Identity" });
    const identity = within(identityGroup).getByRole("menuitem");
    expect(identity).toHaveTextContent("Local operator");
    expect(identity).toHaveTextContent("local-operator");
    expect(identity).toHaveAttribute("aria-disabled", "true");

    const orgGroup = within(panel).getByRole("group", { name: "Organization" });
    const orgs = within(orgGroup).getAllByRole("menuitemradio");
    expect(orgs.map((option) => option.textContent)).toEqual([
      "Local workspacelocal",
      "Second workspacesecond",
    ]);
    expect(orgs[0]).toHaveAttribute("aria-checked", "true");
    expect(orgs[1]).toHaveAttribute("aria-checked", "false");
  });

  it("switches the selected organization locally and reports the selected account", async () => {
    const onSelect = vi.fn();
    server.use(
      http.get("*/api/auth/identity", () => apiJson("auth.identity", identityWithTwoAccounts)),
    );
    render(<IdentityOrgSwitcher onSelect={onSelect} />);

    expect(await screen.findByRole("button", { name: "Local workspace" })).toBeInTheDocument();
    const panel = openPanel();
    fireEvent.click(within(panel).getByText("Second workspace"));

    expect(screen.getByRole("button", { name: "Second workspace" })).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith({ accountId: "account-second" });
    const orgs = within(screen.getByRole("group", { name: "Organization" })).getAllByRole(
      "menuitemradio",
    );
    expect(orgs[0]).toHaveAttribute("aria-checked", "false");
    expect(orgs[1]).toHaveAttribute("aria-checked", "true");
  });

  it("degrades the panel to loading while identity is in flight", () => {
    server.use(http.get("*/api/auth/identity", () => new Promise(() => {})));
    render(<IdentityOrgSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "Identity" }));
    const panel = screen.getByRole("menu", { name: "Switch identity and organization" });
    expect(panel).toHaveTextContent("Loading...");
  });

  it("degrades the panel to unavailable when the identity read fails", async () => {
    server.use(
      http.get("*/api/auth/identity", () =>
        HttpResponse.json(
          { code: "internal_error", error: "identity read failed" },
          { status: 500 },
        ),
      ),
    );
    render(<IdentityOrgSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "Identity" }));
    const panel = screen.getByRole("menu", { name: "Switch identity and organization" });
    expect(await within(panel).findAllByText("Unavailable")).toHaveLength(2);
  });
});

describe("identity-org-switcher — shell-frame wiring", () => {
  it("mounts in the real shell toolbar and reads auth.identity", async () => {
    render(
      <RedactionGovernor>
        <ShellFrame location={{ pathname: "/", search: "" }} navigate={vi.fn()}>
          <div data-screen-stub />
        </ShellFrame>
      </RedactionGovernor>,
    );

    const trigger = await screen.findByRole("button", { name: "Local workspace" });
    expect(trigger.closest('[data-shell-toolbar="true"]')).not.toBeNull();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("menu", { name: "Switch identity and organization" }),
    ).toHaveTextContent("Local operator");
  });

  it("persists the selected organization, navigates home, and scopes follow-up reads", async () => {
    const navigate = vi.fn();
    const statusAccountScopes: string[] = [];
    server.use(
      http.get("*/api/auth/identity", () => apiJson("auth.identity", identityWithTwoAccounts)),
      http.get("*/api/projects/status", ({ request }) => {
        const accountId = request.headers.get(ITOTORI_SELECTED_ACCOUNT_HEADER) ?? "";
        statusAccountScopes.push(accountId);
        return apiJson(
          "projects.status",
          accountId === "account-second" ? secondAccountDashboardStatus : dashboardStatusFixture,
        );
      }),
      http.get("*/api/projects", ({ request }) => {
        const accountId = request.headers.get(ITOTORI_SELECTED_ACCOUNT_HEADER) ?? "";
        return apiJson("projects.list", {
          projects: [
            accountId === "account-second" ? secondAccountDashboardStatus : dashboardStatusFixture,
          ],
        });
      }),
    );

    render(
      <RedactionGovernor>
        <ShellFrame location={{ pathname: "/play/patches", search: "" }} navigate={navigate}>
          <div data-screen-stub />
        </ShellFrame>
      </RedactionGovernor>,
    );

    const trigger = await screen.findByRole("button", { name: "Local workspace" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Second workspace/u }));

    expect(navigate).toHaveBeenCalledWith("/");
    expect(window.sessionStorage.getItem("itotori.shell.selectedAccountId")).toBe("account-second");
    expect(await screen.findByRole("button", { name: "Second workspace" })).toBeInTheDocument();
    expect(await screen.findByText("project-second")).toBeInTheDocument();
    expect(screen.getByText("de-DE")).toBeInTheDocument();
    await waitFor(() => expect(statusAccountScopes).toContain("account-second"));
  });
});
