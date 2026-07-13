// @vitest-environment jsdom
// fnd-caps-context — behavior-first test for the client Studio capability
// context.
//
// Mounts the real CapsProvider (over msw-intercepted `/api/auth/capabilities`
// or an explicit view) + CapGatedButton controls and asserts the OBSERVABLE
// behavior a viewer sees:
//
//   1. capabilities resolve from permission grants (canFlag / canSteer /
//      canReveal), NEVER roles;
//   2. a denied action is DISABLED + EXPLAINED (title / aria-description /
//      data-cap-denial carry the AuthorizationError message);
//   3. a granted action is enabled and clickable;
//   4. App wires canReveal into RedactionGovernor from the caps view.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered cap-gates and denial explanations are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AuthorizationError, permissionValues, type Permission } from "@itotori/db";
import {
  resolveStudioCapabilityPermissionView,
  studioCapabilityPermissions,
  type ItotoriAuthorizationPort,
} from "../src/auth.js";
import {
  CapGatedButton,
  CapsProvider,
  deniedStudioCapabilityView,
  grantedStudioCapabilityView,
  useCaps,
} from "../src/ui/caps-context.js";
import { App } from "../src/ui/App.js";
import { RedactionToggle } from "../src/ui/redaction-governor.js";
import { apiJson, authIdentityMswHandler } from "./msw-handlers.js";
import {
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  projectOverviewFixture,
} from "./api-fixtures.js";

// ---------------------------------------------------------------------------
// Server-side permission-view resolver (unit, no DOM)
// ---------------------------------------------------------------------------

function authorization(
  grants: ReadonlyArray<Permission>,
  actorUserId = "local-user",
): ItotoriAuthorizationPort {
  const granted = new Set(grants);
  return {
    requirePermission: async (permission) => {
      if (!granted.has(permission)) {
        throw new AuthorizationError({ userId: actorUserId }, permission);
      }
    },
  };
}

describe("resolveStudioCapabilityPermissionView", () => {
  it("maps flag/steer/reveal to exact permissions (not roles)", async () => {
    const view = await resolveStudioCapabilityPermissionView(
      authorization([
        permissionValues.feedbackImport,
        permissionValues.draftWrite,
        permissionValues.catalogRead,
      ]),
      "local-user",
    );
    expect(view.canFlag).toBe(true);
    expect(view.canSteer).toBe(true);
    expect(view.canReveal).toBe(true);
    expect(view.denialReasons).toEqual([]);
    // Mapping is the documented exact Permission for each capability.
    expect(studioCapabilityPermissions.flag).toBe(permissionValues.feedbackImport);
    expect(studioCapabilityPermissions.steer).toBe(permissionValues.draftWrite);
    expect(studioCapabilityPermissions.reveal).toBe(permissionValues.catalogRead);
  });

  it("returns per-capability denial explanations when grants are missing", async () => {
    const view = await resolveStudioCapabilityPermissionView(authorization([], "anon"), "anon");
    expect(view.canFlag).toBe(false);
    expect(view.canSteer).toBe(false);
    expect(view.canReveal).toBe(false);
    expect(view.denials.flag).toBe("user anon is missing permission feedback.import");
    expect(view.denials.steer).toBe("user anon is missing permission draft.write");
    expect(view.denials.reveal).toBe("user anon is missing permission catalog.read");
    // denialReasons aggregates every missing grant for audit surfaces.
    expect(view.denialReasons).toEqual(
      expect.arrayContaining([
        "user anon is missing permission feedback.import",
        "user anon is missing permission draft.write",
        "user anon is missing permission catalog.read",
      ]),
    );
  });

  it("grants only the capabilities whose exact permissions are held", async () => {
    // A direct editor grant: draft.write, no feedback.import / catalog.read →
    // can steer, but cannot flag or reveal.
    const view = await resolveStudioCapabilityPermissionView(
      authorization([permissionValues.draftWrite]),
      "editor-1",
    );
    expect(view.canFlag).toBe(false);
    expect(view.canSteer).toBe(true);
    expect(view.canReveal).toBe(false);
    expect(view.denials.flag).toMatch(/feedback\.import/);
    expect(view.denials.reveal).toMatch(/catalog\.read/);
    expect(view.denials.steer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CapsProvider + CapGatedButton (DOM)
// ---------------------------------------------------------------------------

function CapsProbe(): JSX.Element {
  const caps = useCaps();
  return (
    <div
      data-caps-probe="true"
      data-can-flag={caps.canFlag ? "true" : "false"}
      data-can-steer={caps.canSteer ? "true" : "false"}
      data-can-reveal={caps.canReveal ? "true" : "false"}
      data-actor={caps.actorUserId}
      data-ready={caps.ready ? "true" : "false"}
    />
  );
}

describe("CapsProvider + CapGatedButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("a denied action is DISABLED + EXPLAINED with the denial reason", () => {
    const view = deniedStudioCapabilityView("anon", "user anon is missing permission draft.write");
    // Override just steer so the denial message is the exact permission miss.
    view.canSteer = false;
    view.denials.steer = "user anon is missing permission draft.write";

    let clicked = false;
    render(
      <CapsProvider value={view}>
        <CapGatedButton
          capability="steer"
          onClick={() => {
            clicked = true;
          }}
        >
          Launch iteration
        </CapGatedButton>
      </CapsProvider>,
    );

    const button = screen.getByRole("button", { name: "Launch iteration" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-cap", "steer");
    expect(button).toHaveAttribute("data-cap-allowed", "false");
    expect(button).toHaveAttribute("data-cap-permission", permissionValues.draftWrite);
    expect(button).toHaveAttribute("title", "user anon is missing permission draft.write");
    // Clicking a denied control is a no-op (never fires the handler).
    fireEvent.click(button);
    expect(clicked).toBe(false);
  });

  it("a granted action is enabled and clickable", () => {
    const view = grantedStudioCapabilityView("local-user");
    let clicked = false;
    render(
      <CapsProvider value={view}>
        <CapGatedButton
          capability="flag"
          onClick={() => {
            clicked = true;
          }}
        >
          Flag
        </CapGatedButton>
      </CapsProvider>,
    );
    const button = screen.getByRole("button", { name: "Flag" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-cap-allowed", "true");
    fireEvent.click(button);
    expect(clicked).toBe(true);
  });

  it("exposes canFlag / canSteer / canReveal from the view", () => {
    const view = grantedStudioCapabilityView("local-user");
    view.canFlag = true;
    view.canSteer = true;
    view.canReveal = false;
    view.denials.reveal = "user local-user is missing permission catalog.read";

    render(
      <CapsProvider value={view}>
        <CapsProbe />
      </CapsProvider>,
    );
    const probe = document.querySelector("[data-caps-probe]")!;
    expect(probe).toHaveAttribute("data-can-flag", "true");
    expect(probe).toHaveAttribute("data-can-steer", "true");
    expect(probe).toHaveAttribute("data-can-reveal", "false");
    expect(probe).toHaveAttribute("data-actor", "local-user");
    expect(probe).toHaveAttribute("data-ready", "true");
  });
});

// ---------------------------------------------------------------------------
// CapsProvider loads from GET /api/auth/capabilities
// ---------------------------------------------------------------------------

const CAPS_PATH = "*/api/auth/capabilities";

const server = setupServer(
  authIdentityMswHandler,
  http.get(CAPS_PATH, () =>
    apiJson("auth.capabilities", {
      schemaVersion: "itotori.auth.capabilities.v0",
      actorUserId: "local-user",
      canFlag: true,
      canSteer: true,
      canReveal: true,
      denials: {
        flag: null,
        steer: null,
        reveal: null,
      },
      denialReasons: [],
    }),
  ),
  // App shell also reads dashboard endpoints when mounted.
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/decisions", () =>
    apiJson("projects.decisions", dashboardDecisionsFixture),
  ),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/projects/cost/drilldown", () =>
    apiJson("projects.costDrilldown", costDrilldownFixture),
  ),
  http.get("*/api/projects/overview", () => apiJson("projects.overview", projectOverviewFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("CapsProvider loads /api/auth/capabilities", () => {
  it("resolves the view from the typed auth.capabilities route", async () => {
    render(
      <CapsProvider>
        <CapsProbe />
      </CapsProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-caps-probe]")).toHaveAttribute("data-ready", "true");
    });
    const probe = document.querySelector("[data-caps-probe]")!;
    expect(probe).toHaveAttribute("data-can-flag", "true");
    expect(probe).toHaveAttribute("data-can-steer", "true");
    expect(probe).toHaveAttribute("data-can-reveal", "true");
    expect(probe).toHaveAttribute("data-actor", "local-user");
  });

  it("App wires canReveal into the redaction toggle from the caps view", async () => {
    // Granted canReveal → the reveal toggle is capable (not disabled for
    // missing-cap reasons). Share mode is off so only the cap gates it.
    render(
      <App
        location={{ pathname: "/", search: "" }}
        caps={grantedStudioCapabilityView("local-user")}
      />,
    );
    // The shell redaction toggle is always mounted; with canReveal true it
    // is enabled (unless share mode).
    const toggle = await screen.findByRole("checkbox", {
      name: /reveal sensitive/i,
    });
    expect(toggle).not.toBeDisabled();
    expect(document.querySelector('[data-redaction-toggle="reveal"]')).toHaveAttribute(
      "data-reveal-capable",
      "true",
    );
  });

  it("App disables the reveal toggle when the caps view denies canReveal", async () => {
    const denied = deniedStudioCapabilityView(
      "anon",
      "user anon is missing permission catalog.read",
    );
    render(<App location={{ pathname: "/", search: "" }} caps={denied} />);
    const toggle = await screen.findByRole("checkbox", {
      name: /reveal sensitive/i,
    });
    expect(toggle).toBeDisabled();
    expect(document.querySelector('[data-redaction-toggle="reveal"]')).toHaveAttribute(
      "data-reveal-capable",
      "false",
    );
    // The toggle copy explains the missing capability.
    expect(screen.getByText(/requires revealSensitive/i)).toBeInTheDocument();
  });
});

// Keep RedactionToggle import "used" for typecheck of the surface the App
// mounts (the toggle itself is exercised via the App mount above).
void RedactionToggle;
