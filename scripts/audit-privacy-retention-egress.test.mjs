import assert from "node:assert/strict";
import test from "node:test";
import {
  findContentBearingLogs,
  findManifestViolations,
  findPlaintextRebuildColumns,
  findViolations,
} from "./audit-privacy-retention-egress.mjs";

const manifest = [
  "PrivacyRetentionEgressContractSchema",
  "RebuildCallWirePolicySchema",
  '"X-OpenRouter-Metadata"',
  '"X-OpenRouter-Cache"',
  "OPENROUTER_ZDR_ACCOUNT_ASSERTED",
  "OPENROUTER_ZDR_GUARDRAIL_ASSERTED",
  "operator-managed-envelope",
  'z.literal("content.read")',
  'z.literal("billing_unknown")',
  'z.literal("/generation")',
  'z.literal("web_search")',
  'z.literal("A7")',
  "QualifyingRunEgressSchema",
].join("\n");

test("rejects a weakened privacy manifest", () => {
  assert.deepEqual(findManifestViolations(manifest), []);
  assert.deepEqual(findManifestViolations(manifest.replace('z.literal("A7")', "")), [
    'apps/itotori/src/contracts/privacy.ts: missing privacy contract requirement z.literal("A7")',
  ]);
});

test("rejects plaintext content fields in rebuilt LLM migrations", () => {
  const plaintext = [
    "create table itotori_llm_call_memos (",
    "  memo_id text primary key,",
    "  response_text text not null,",
    "  content_hash text not null",
    ");",
  ].join("\n");
  assert.deepEqual(
    findPlaintextRebuildColumns(plaintext, "packages/itotori-db/migrations/9999_llm.sql"),
    [
      "packages/itotori-db/migrations/9999_llm.sql: itotori_llm_call_memos.response_text is content-bearing and must use an encrypted/ciphertext column",
    ],
  );
  const encrypted = plaintext.replace("response_text", "response_encrypted");
  assert.deepEqual(
    findPlaintextRebuildColumns(encrypted, "packages/itotori-db/migrations/9999_llm.sql"),
    [],
  );
});

test("rejects content values in rebuilt LLM observability", () => {
  const unsafe = "logger.info({ event: 'completed', sourceText });";
  assert.deepEqual(findContentBearingLogs(unsafe, "apps/itotori/src/llm/dispatch.ts"), [
    "apps/itotori/src/llm/dispatch.ts:1: content-bearing value reaches a log or telemetry call",
  ]);
  assert.deepEqual(
    findContentBearingLogs(
      "logger.info({ event: 'completed', contentHash, byteLength });",
      "apps/itotori/src/llm/dispatch.ts",
    ),
    [],
  );
});

test("combines manifest, migration, and logging violations", () => {
  const files = new Map([
    ["apps/itotori/src/contracts/privacy.ts", manifest],
    [
      "packages/itotori-db/migrations/9999_llm.sql",
      "create table itotori_llm_conversation_events (\nbody jsonb not null\n);",
    ],
    ["apps/itotori/src/llm/events.ts", "telemetry.record({ message });"],
  ]);
  assert.equal(findViolations(files).length, 2);
});
