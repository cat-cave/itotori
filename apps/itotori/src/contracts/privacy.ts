import { z } from "zod";
import { IdentifierSchema, ProviderPolicySchema, RoleIdSchema } from "./shared.js";

export const PRIVACY_RETENTION_EGRESS_CONTRACT_VERSION =
  "itotori.privacy-retention-egress.v1" as const;

const ExactModelSchema = IdentifierSchema.superRefine((value, context) => {
  if (/(?:^|[/:_-])(?:auto|latest|router)(?:$|[/:_-])/iu.test(value)) {
    context.addIssue({ code: "custom", message: "model must be an exact versioned slug" });
  }
});

const EmptyPluginsSchema = z.array(z.never()).max(0);

/** The complete wire plan a rebuilt dispatcher must validate before a call. */
export const RebuildCallWirePolicySchema = z
  .object({
    model: ExactModelSchema,
    provider: ProviderPolicySchema,
    headers: z
      .object({
        "X-OpenRouter-Metadata": z.literal("enabled"),
        "X-OpenRouter-Cache": z.literal("false"),
      })
      .strict(),
    plugins: EmptyPluginsSchema,
    remoteCache: z.literal(false),
    hiddenRetries: z.literal(false),
  })
  .strict();

export const QualifyingRunEgressSchema = z
  .object({
    qualifyingRun: z.literal(true),
    webSearchEnabled: z.literal(false),
  })
  .strict();

export const PrivacyRetentionEgressContractSchema = z
  .object({
    schemaVersion: z.literal(PRIVACY_RETENTION_EGRESS_CONTRACT_VERSION),
    openRouter: z
      .object({
        exclusiveInferenceEgress: z.literal(true),
        accountZdrAssertionEnv: z.literal("OPENROUTER_ZDR_ACCOUNT_ASSERTED"),
        guardrailZdrAssertionEnv: z.literal("OPENROUTER_ZDR_GUARDRAIL_ASSERTED"),
        dashboardInputOutputLogging: z.literal(false),
        dataUseOptIn: z.literal(false),
      })
      .strict(),
    storage: z
      .object({
        contentEncryption: z.literal("operator-managed-envelope"),
        plaintextLifetime: z.literal("process-memory-only"),
        readPermission: z.literal("content.read"),
      })
      .strict(),
    retention: z
      .object({
        transientAttemptDays: z.literal(7),
        runContentDays: z.literal(30),
        acceptedContentDays: z.literal(365),
        sourceVolumeLifetime: z.literal("job-lifetime"),
        deleteBy: z.tuple([
          z.literal("delete-ciphertext"),
          z.literal("destroy-key"),
          z.literal("retain-tombstone-only"),
        ]),
      })
      .strict(),
    billing: z
      .object({
        confirmed: z.literal("generation-reconciled"),
        unknown: z.literal("billing_unknown"),
        reconciliationPath: z.literal("/generation"),
      })
      .strict(),
    egress: z
      .object({
        onlyException: z.literal("web_search"),
        webSearchRole: z.literal("A7"),
        operatorEnabledOnly: z.literal(true),
        qualifyingRunEnabled: z.literal(false),
        provenance: z.tuple([
          z.literal("url"),
          z.literal("retrieved-on"),
          z.literal("content-hash"),
          z.literal("web"),
        ]),
      })
      .strict(),
  })
  .strict();

/**
 * This is a policy manifest, not a model profile. Profiles provide exact model
 * and provider slugs; every resolved call is validated by RebuildCallWirePolicySchema.
 */
export const privacyRetentionEgressManifest = {
  schemaVersion: PRIVACY_RETENTION_EGRESS_CONTRACT_VERSION,
  openRouter: {
    exclusiveInferenceEgress: true,
    accountZdrAssertionEnv: "OPENROUTER_ZDR_ACCOUNT_ASSERTED",
    guardrailZdrAssertionEnv: "OPENROUTER_ZDR_GUARDRAIL_ASSERTED",
    dashboardInputOutputLogging: false,
    dataUseOptIn: false,
  },
  storage: {
    contentEncryption: "operator-managed-envelope",
    plaintextLifetime: "process-memory-only",
    readPermission: "content.read",
  },
  retention: {
    transientAttemptDays: 7,
    runContentDays: 30,
    acceptedContentDays: 365,
    sourceVolumeLifetime: "job-lifetime",
    deleteBy: ["delete-ciphertext", "destroy-key", "retain-tombstone-only"],
  },
  billing: {
    confirmed: "generation-reconciled",
    unknown: "billing_unknown",
    reconciliationPath: "/generation",
  },
  egress: {
    onlyException: "web_search",
    webSearchRole: "A7",
    operatorEnabledOnly: true,
    qualifyingRunEnabled: false,
    provenance: ["url", "retrieved-on", "content-hash", "web"],
  },
} as const;

export type RebuildCallWirePolicy = z.infer<typeof RebuildCallWirePolicySchema>;
export type PrivacyRetentionEgressContract = z.infer<typeof PrivacyRetentionEgressContractSchema>;

export function assertPrivacyRetentionEgressContract(): PrivacyRetentionEgressContract {
  const parsed = PrivacyRetentionEgressContractSchema.safeParse(privacyRetentionEgressManifest);
  if (!parsed.success) {
    throw new Error(`privacy/retention/egress contract is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function assertRebuildLlmStartupPolicy(
  env: Readonly<Record<string, string | undefined>>,
): PrivacyRetentionEgressContract {
  const contract = assertPrivacyRetentionEgressContract();
  const requiredAssertions = [
    contract.openRouter.accountZdrAssertionEnv,
    contract.openRouter.guardrailZdrAssertionEnv,
  ];
  const missing = requiredAssertions.filter((name) => env[name] !== "1");
  if (missing.length > 0) {
    throw new Error(`rebuilt LLM requires operator assertions: ${missing.join(", ")}`);
  }
  return contract;
}

export function assertWebSearchEgress(input: {
  roleId: z.infer<typeof RoleIdSchema>;
  operatorEnabled: boolean;
  qualifyingRun: boolean;
}): void {
  const contract = assertPrivacyRetentionEgressContract();
  if (input.roleId !== contract.egress.webSearchRole) {
    throw new Error("web_search is restricted to the configured role");
  }
  if (!input.operatorEnabled) {
    throw new Error("web_search requires explicit operator egress enablement");
  }
  if (input.qualifyingRun && !contract.egress.qualifyingRunEnabled) {
    throw new Error("web_search is disabled for a qualifying run");
  }
}
