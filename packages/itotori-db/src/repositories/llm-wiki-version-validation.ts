// Strict field validators for a Wiki version write. These are the write gate:
// a forged object kind, subject kind, scope, run mode, author role, or a version
// that does not advance its expected head is rejected before any row is written.
// Split from the repository so the persistence orchestration and its field
// invariants stay individually within the module line budget.

import type { LlmWikiScope, LlmWikiSubject, LlmWikiVersionCommon } from "./llm-wiki-repository.js";

const OBJECT_KINDS = new Set([
  "style-contract",
  "term-ruling",
  "scene-summary",
  "story-so-far",
  "route-arc",
  "voice-profile",
  "adaptation-note",
  "character-bio",
  "character-background",
  "character-route-arc",
  "speaker-hypothesis",
  "translation",
]);

const SUBJECT_KINDS = new Set([
  "game",
  "route",
  "scene",
  "unit",
  "character",
  "glossary-term",
  "choice",
  "organization",
  "user",
  "genre",
]);

export function assertCommon(input: LlmWikiVersionCommon): void {
  assertIdentifier(input.objectId, "wiki object ID");
  assertLanguageTag(input.language, "wiki object language");
  assertObjectKind(input.objectKind);
  assertScope(input.scope);
  assertRunMode(input.runMode);
  if (input.editedBy !== null && !["human", "enhancement", "agent"].includes(input.editedBy)) {
    throw new Error("wiki provenance editedBy is invalid");
  }
  if (!Number.isSafeInteger(input.objectVersion) || input.objectVersion <= 0) {
    throw new Error("wiki object version must be a positive safe integer");
  }
  if (input.expectedHead === null && input.objectVersion !== 1) {
    throw new Error("the first wiki object version must be one");
  }
  if (
    input.expectedHead !== null &&
    (input.objectVersion !== input.expectedHead.version + 1 ||
      input.supersedesVersion !== input.expectedHead.version)
  ) {
    throw new Error("wiki object version does not advance its expected head");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("wiki object timestamp is invalid");
  }
}

function assertObjectKind(value: string): void {
  if (!OBJECT_KINDS.has(value)) throw new Error("wiki object kind is invalid");
}

export function assertSubject(subject: LlmWikiSubject): void {
  if (!SUBJECT_KINDS.has(subject.kind)) throw new Error("wiki subject kind is invalid");
  assertIdentifier(subject.id, "wiki subject ID");
}

function assertScope(scope: LlmWikiScope): void {
  if (scope.kind === "global") return;
  if (scope.kind === "route") {
    assertIdentifier(scope.routeId, "wiki scope route ID");
    return;
  }
  if (scope.routeIds.length === 0) throw new Error("wiki route-set scope must not be empty");
  for (const routeId of scope.routeIds) assertIdentifier(routeId, "wiki scope route ID");
  if (new Set(scope.routeIds).size !== scope.routeIds.length) {
    throw new Error("wiki route-set scope routes must be unique");
  }
  const sorted = [...scope.routeIds].every(
    (routeId, index) => index === 0 || routeId > scope.routeIds[index - 1]!,
  );
  if (!sorted) throw new Error("wiki route-set scope routes must be sorted");
}

export function assertContextScope(value: string): void {
  if (
    value !== "whole-game" &&
    value !== "external-augmented" &&
    !/^narrowed:[^\s].{0,127}$/u.test(value)
  ) {
    throw new Error("wiki context scope is invalid");
  }
}

function assertRunMode(value: string): void {
  if (!["production", "pilot", "test-dev"].includes(value)) {
    throw new Error("wiki run mode is invalid");
  }
}

export function assertAuthorRole(value: string): void {
  if (!/^(A[1-9]|A10|P[1-3]|Q[1-6])$/u.test(value)) {
    throw new Error("wiki provenance author role is invalid");
  }
}

function assertLanguageTag(value: string, label: string): void {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value)) {
    throw new Error(`${label} is not a language tag`);
  }
}

export function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/u.test(value)) {
    throw new Error(`${label} is not a stable identifier`);
  }
}
