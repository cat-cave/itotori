import type { QueueHealthReadModel } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { assertQueueHealthReadModel } from "../src/api-schema.js";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import type { QueueHealthCliPort } from "../src/queue/cli.js";
import {
  unavailableServiceSurface,
  type ItotoriApplicationServices,
} from "../src/services/database-services.js";

function jsonStoreFixture(reads: Map<string, unknown>, writes: Map<string, unknown>) {
  return {
    readJson: vi.fn((path: string) => reads.get(path)),
    writeJson: vi.fn((path: string, value: unknown) => {
      writes.set(path, value);
    }),
  };
}

function queueHealthFixture(overrides: Partial<QueueHealthReadModel> = {}): QueueHealthReadModel {
  const base: QueueHealthReadModel = {
    schemaVersion: "itotori.queue_health.v0.1",
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
    outbox: {
      unprocessedCount: 2,
      oldestUnprocessedAt: new Date("2026-01-01T00:00:00.000Z"),
      unprocessedLagSeconds: 12.5,
      statusCounts: [
        { status: "pending", count: 1 },
        { status: "publishing", count: 0 },
        { status: "published", count: 3 },
        { status: "retry_waiting", count: 1 },
        { status: "dead_letter", count: 1 },
      ],
      retryingCount: 1,
      deadLetter: { count: 1, recent: [] },
    },
    jobs: {
      unprocessedCount: 4,
      oldestUnprocessedAt: new Date("2026-01-01T00:00:00.000Z"),
      unprocessedLagSeconds: 30,
      statusCounts: [
        { status: "queued", count: 2 },
        { status: "running", count: 1 },
        { status: "retry_waiting", count: 1 },
        { status: "succeeded", count: 5 },
        { status: "dead_letter", count: 2 },
        { status: "cancelled", count: 0 },
      ],
      retryingCount: 1,
      deadLetter: { count: 2, recent: [] },
    },
  };
  return { ...base, ...overrides };
}

function queueHealthPortFixture(model: QueueHealthReadModel): {
  port: QueueHealthCliPort;
  loadQueueHealth: ReturnType<typeof vi.fn>;
} {
  const loadQueueHealth = vi.fn(async () => model);
  return {
    port: { loadQueueHealth },
    loadQueueHealth,
  };
}

function servicesFixture(port: QueueHealthCliPort | undefined = undefined): ItotoriCliServices {
  const stub: Partial<ItotoriCliServices> = { queueHealth: port };
  return stub as ItotoriCliServices;
}

function unavailableAfterCutoverSurface(): ItotoriCliServices {
  return unavailableServiceSurface({
    projectWorkflow: {} as ItotoriApplicationServices["projectWorkflow"],
    wikiObjectApi: {} as ItotoriApplicationServices["wikiObjectApi"],
    wikiBuild: {} as ItotoriApplicationServices["wikiBuild"],
    localizationSubstrate: {} as ItotoriApplicationServices["localizationSubstrate"],
  });
}

describe("queue-health CLI handler", () => {
  it("itotori:queue-health writes a TYPED response that satisfies the queue.health API contract", async () => {
    const fixture = queueHealthPortFixture(queueHealthFixture());
    const writes = new Map<string, unknown>();
    await runItotoriCliCommand(["queue-health", "--output", "queue-health.json"], {
      io: jsonStoreFixture(new Map(), writes),
      migrateDatabase: vi.fn(async () => {}),
      resetDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(servicesFixture(fixture.port)),
    });

    expect(fixture.loadQueueHealth).toHaveBeenCalledWith({});
    const written = writes.get("queue-health.json");
    expect(written).toBeDefined();
    // The written JSON must pass the SAME typed asserter the dashboard
    // `queue.health` route uses (typed API response, not a dumped string).
    expect(() => assertQueueHealthReadModel(written)).not.toThrow();
    expect((written as QueueHealthReadModel).schemaVersion).toBe("itotori.queue_health.v0.1");
  });

  it("forwards --dead-letter-limit and --project to the port", async () => {
    const fixture = queueHealthPortFixture(queueHealthFixture());
    const writes = new Map<string, unknown>();
    await runItotoriCliCommand(
      [
        "queue-health",
        "--output",
        "queue-health.json",
        "--dead-letter-limit",
        "5",
        "--project",
        "project-test",
      ],
      {
        io: jsonStoreFixture(new Map(), writes),
        migrateDatabase: vi.fn(async () => {}),
        resetDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(servicesFixture(fixture.port)),
      },
    );

    expect(fixture.loadQueueHealth).toHaveBeenCalledWith({
      deadLetterLimit: 5,
      projectId: "project-test",
    });
  });

  it("errors when the queueHealth port is not configured", async () => {
    await expect(
      runItotoriCliCommand(["queue-health", "--output", "queue-health.json"], {
        io: jsonStoreFixture(new Map(), new Map()),
        migrateDatabase: vi.fn(async () => {}),
        resetDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(servicesFixture(undefined)),
      }),
    ).rejects.toThrow(/queue-health service is not configured/);
  });

  it("refuses an unbound queueHealth port before the unavailable-after-cutover fallback runs", async () => {
    const services = unavailableAfterCutoverSurface();
    expect(Reflect.has(services, "queueHealth")).toBe(false);
    expect(Reflect.has(services, "projectWorkflow")).toBe(true);
    expect(() => (services as unknown as { retiredPort(): void }).retiredPort()).toThrow(
      /retiredPort is not available after the legacy cutover/,
    );

    await expect(
      runItotoriCliCommand(["queue-health", "--output", "queue-health.json"], {
        io: jsonStoreFixture(new Map(), new Map()),
        migrateDatabase: vi.fn(async () => {}),
        resetDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      }),
    ).rejects.toThrow(/queue-health service is not configured/);
  });

  it("rejects a non-integer --dead-letter-limit", async () => {
    const fixture = queueHealthPortFixture(queueHealthFixture());
    await expect(
      runItotoriCliCommand(
        ["queue-health", "--output", "queue-health.json", "--dead-letter-limit", "not-a-number"],
        {
          io: jsonStoreFixture(new Map(), new Map()),
          migrateDatabase: vi.fn(async () => {}),
          resetDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(servicesFixture(fixture.port)),
        },
      ),
    ).rejects.toThrow(/--dead-letter-limit must be a non-negative integer/);
  });
});
