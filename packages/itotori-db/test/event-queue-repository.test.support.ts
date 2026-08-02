import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { type ItotoriDatabase } from "../src/connection.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";

import { outboxEventTypeValues } from "../src/schema.js";
import { currentProjectFixture } from "./current-project-fixture.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(overrides: Partial<ItotoriProjectRecord> = {}): ItotoriProjectRecord {
  const project = currentProjectFixture({
    seed: "event-queue",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    units: [
      {
        sourceUnitKey: "hello.scene.001.line.001",
        sourceText: "こんにちは、{player}。",
        targetText: "Hello, {player}.",
        spans: [{ raw: "{player}" }],
      },
    ],
  });
  return { ...project, ...overrides };
}

export async function migratedContext() {
  return isolatedMigratedContext();
}

export async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
}

export async function seedOutboxEvent(queue: ItotoriEventQueueRepository): Promise<void> {
  await queue.appendOutboxEvent(localActor, {
    outboxEventId: "outbox-agent-task",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    eventType: outboxEventTypeValues.agentTaskRequested,
    idempotencyKey: "outbox:agent-task",
    payload: { agentTask: "context-summary" },
    maxAttempts: 3,
  });
}
