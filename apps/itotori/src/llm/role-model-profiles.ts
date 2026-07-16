import { z } from "zod";
import {
  CallSpecSchema,
  DecimalUsdSchema,
  ProviderPolicySchema,
  RebuildCallWirePolicySchema,
  RoleIdSchema,
  Sha256Schema,
  TokenUsageSchema,
  assertNoProviderPin,
  assertProfileIdNamesNoProvider,
  type CallSpec,
  type RoleId,
} from "../contracts/index.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import { modelProfileCertificates } from "./model-profiles/certificates.js";

export const ROLE_MODEL_PROFILE_CONFIG_VERSION = "itotori.role-model-profiles.v1" as const;
export const MODEL_PROFILE_CERTIFICATE_VERSION = "itotori.model-profile-certificate.v1" as const;
const MODEL_PROFILE_VERSION_PREFIX = "itotori.model-profile.v1";

const ModelProfileNameSchema = z.enum(["draft", "reasoning", "reviewer", "judge"]);
const RoleBindingSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    modelProfile: ModelProfileNameSchema,
  })
  .strict();

export const RoleModelProfileSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    providerPolicy: ProviderPolicySchema,
  })
  .strict()
  .superRefine((value, context) => {
    try {
      assertProfileIdNamesNoProvider(value.profileId);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["profileId"],
        message:
          error instanceof Error ? error.message : "profile identity must not name a provider",
      });
    }
    const exactWire = RebuildCallWirePolicySchema.safeParse({
      model: value.model,
      provider: value.providerPolicy,
      headers: { "X-OpenRouter-Metadata": "enabled", "X-OpenRouter-Cache": "false" },
      plugins: [],
      remoteCache: false,
      hiddenRetries: false,
    });
    if (!exactWire.success) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "model profile must use an exact versioned model route",
      });
    }
    const expected = profileVersion(value.model, value.providerPolicy);
    if (value.version !== expected) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "model profile version must bind the exact model and provider policy",
      });
    }
  });

export const RoleModelProfileConfigSchema = z
  .object({
    schemaVersion: z.literal(ROLE_MODEL_PROFILE_CONFIG_VERSION),
    roles: z.record(RoleIdSchema, RoleBindingSchema),
    profiles: z.record(z.string().min(1).max(128), RoleModelProfileSchema),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [roleId, binding] of Object.entries(value.roles)) {
      if (!value.profiles[binding.profileId]) {
        context.addIssue({
          code: "custom",
          path: ["roles", roleId, "profileId"],
          message: "role references an absent model profile",
        });
      }
    }
  });

const ProbeCheckSchema = z.enum(["passed", "failed", "deferred"]);
const ProbeChecksSchema = z
  .object({
    strictStructuredFinish: ProbeCheckSchema,
    typedToolRoundTrip: ProbeCheckSchema,
    reasoningDetailsContinuity: ProbeCheckSchema,
    usageCapture: ProbeCheckSchema,
    costCapture: ProbeCheckSchema,
    generationLookup: ProbeCheckSchema,
    servedPairVerification: ProbeCheckSchema,
  })
  .strict();
const UnknownServedPairSchema = z.object({ status: z.literal("unknown") }).strict();
const PositiveBilledUsdSchema = DecimalUsdSchema.refine((value) => Number(value) > 0, {
  message: "certified provider cost must be positive",
});

// ITOTORI-241 - binds a certificate to the ACTUAL live run it was minted from.
// `memoKey` is the request identity (sha256 of the CallSpec) and
// `transcriptHash` is sha256 of the response transcript (the dispatch events)
// captured by the certifier from the real result. `evidenceHash` is a
// recomputable integrity seal over the certified subject/checks/observations +
// those two run references. A hand-authored certificate that flips the status,
// inflates usage/cost, or is minted without running the certifier cannot
// reproduce a matching `evidenceHash`, so selection rejects it.
const CertificateRunBindingSchema = z
  .object({
    memoKey: Sha256Schema,
    transcriptHash: Sha256Schema,
    evidenceHash: Sha256Schema,
  })
  .strict();

export const ModelProfileCertificateSchema = z
  .object({
    schemaVersion: z.literal(MODEL_PROFILE_CERTIFICATE_VERSION),
    certificateStatus: z.enum(["valid", "invalid"]),
    probeMode: z.enum(["live", "recorded"]),
    probedAt: z.iso.datetime({ offset: true }),
    subject: RoleModelProfileSchema,
    checks: ProbeChecksSchema,
    observations: z
      .object({
        physicalStepCount: z.number().int().positive(),
        toolExecutionCount: z.number().int().positive(),
        reasoningDetailBatchCount: z.number().int().positive(),
        forwardedReasoningDetailBatchCount: z.number().int().positive(),
        usage: TokenUsageSchema,
        billedUsdByStep: z.array(PositiveBilledUsdSchema).min(1).max(4),
        generationLookupAttempts: z.number().int().positive(),
        generationId: z.null(),
        served: UnknownServedPairSchema,
        runBinding: CertificateRunBindingSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const { runBinding, ...observations } = value.observations;
    const expected = certificateEvidenceHash({
      probedAt: value.probedAt,
      subject: value.subject,
      checks: value.checks,
      observations,
      memoKey: runBinding.memoKey,
      transcriptHash: runBinding.transcriptHash,
    });
    if (expected !== runBinding.evidenceHash) {
      context.addIssue({
        code: "custom",
        path: ["observations", "runBinding", "evidenceHash"],
        message: "certificate run binding does not match its certified evidence",
      });
    }
    if (value.certificateStatus !== "valid") return;
    const requiredPasses = [
      value.checks.strictStructuredFinish,
      value.checks.typedToolRoundTrip,
      value.checks.reasoningDetailsContinuity,
      value.checks.usageCapture,
      value.checks.costCapture,
    ];
    if (value.probeMode !== "live" || requiredPasses.some((check) => check !== "passed")) {
      context.addIssue({
        code: "custom",
        message: "valid certificate requires a live passing probe",
      });
    }
    if (
      value.checks.generationLookup !== "deferred" ||
      value.checks.servedPairVerification !== "deferred"
    ) {
      context.addIssue({
        code: "custom",
        message: "unavailable generation reconciliation must remain explicitly deferred",
      });
    }
  });

export type RoleModelProfile = z.infer<typeof RoleModelProfileSchema>;
export type RoleModelProfileConfig = z.infer<typeof RoleModelProfileConfigSchema>;
export type ModelProfileCertificate = z.infer<typeof ModelProfileCertificateSchema>;
export type ResolvedRoleModelProfile = RoleModelProfile & {
  readonly roleId: RoleId;
  readonly modelProfile: z.infer<typeof ModelProfileNameSchema>;
  readonly certificate: ModelProfileCertificate;
};

// ITOTORI-241 - capability + ZDR + automatic-fallback policy. It names NO
// provider: `requireParameters` gates strict structured output + typed
// tool-calling to capable providers, `zdr`/`dataCollection` set the privacy
// posture and confine fallback to the account ZDR allow-list, and
// `allowFallbacks: true` lets OpenRouter route across every compliant
// provider when the preferred upstream returns a transient HTTP 429. There
// is no known-good provider list to keep in sync.
const zdrFallbackProviderPolicy = ProviderPolicySchema.parse({
  allowFallbacks: true,
  zdr: true,
  dataCollection: "deny",
  requireParameters: true,
});

export const deepSeekV4FlashProfile = constructRoleModelProfile({
  profileId: "deepseek-v4-flash",
  model: "deepseek/deepseek-v4-flash",
  providerPolicy: zdrFallbackProviderPolicy,
});

export const roleModelProfileConfig = RoleModelProfileConfigSchema.parse({
  schemaVersion: ROLE_MODEL_PROFILE_CONFIG_VERSION,
  profiles: {
    [deepSeekV4FlashProfile.profileId]: deepSeekV4FlashProfile,
  },
  roles: {
    A1: binding("reasoning"),
    A2: binding("reasoning"),
    A3: binding("reasoning"),
    A4: binding("reasoning"),
    A5: binding("reasoning"),
    A6: binding("reasoning"),
    A7: binding("reasoning"),
    A8: binding("reasoning"),
    A9: binding("reasoning"),
    A10: binding("reasoning"),
    P1: binding("draft"),
    P2: binding("draft"),
    P3: binding("draft"),
    Q1: binding("reviewer"),
    Q2: binding("reviewer"),
    Q3: binding("reviewer"),
    Q4: binding("reviewer"),
    Q5: binding("reviewer"),
    Q6: binding("judge"),
  },
});

export function constructRoleModelProfile(input: {
  readonly profileId: string;
  readonly model: string;
  readonly providerPolicy: z.input<typeof ProviderPolicySchema>;
}): RoleModelProfile {
  assertProfileIdNamesNoProvider(input.profileId);
  assertNoProviderPin(input.providerPolicy);
  const providerPolicy = ProviderPolicySchema.parse(input.providerPolicy);
  RebuildCallWirePolicySchema.parse({
    model: input.model,
    provider: providerPolicy,
    headers: { "X-OpenRouter-Metadata": "enabled", "X-OpenRouter-Cache": "false" },
    plugins: [],
    remoteCache: false,
    hiddenRetries: false,
  });
  return RoleModelProfileSchema.parse({
    profileId: input.profileId,
    version: profileVersion(input.model, providerPolicy),
    model: input.model,
    providerPolicy,
  });
}

function roleModelProfileCandidate(
  roleInput: RoleId,
  configInput: unknown = roleModelProfileConfig,
): Omit<ResolvedRoleModelProfile, "certificate"> {
  const roleId = RoleIdSchema.parse(roleInput);
  const config = RoleModelProfileConfigSchema.parse(configInput);
  const binding = config.roles[roleId];
  const profile = config.profiles[binding.profileId];
  if (!profile) throw new Error("role model profile is absent");
  return { ...profile, roleId, modelProfile: binding.modelProfile };
}

/** The only uncertified resolution seam; used solely by the dated live probe. */
export function uncertifiedRoleModelProfileCandidateForProbe(
  roleInput: RoleId,
): Omit<ResolvedRoleModelProfile, "certificate"> {
  return roleModelProfileCandidate(roleInput);
}

export function resolveRoleModelProfile(
  roleInput: RoleId,
  options: {
    readonly config?: unknown;
    readonly certificates?: readonly unknown[];
  } = {},
): ResolvedRoleModelProfile {
  const candidate = roleModelProfileCandidate(roleInput, options.config);
  const certificates = options.certificates ?? modelProfileCertificates;
  const certificate = certificates
    .map((value) => ModelProfileCertificateSchema.safeParse(value))
    .flatMap((result) => (result.success ? [result.data] : []))
    .find(
      (value) =>
        value.certificateStatus === "valid" &&
        canonicalJson(value.subject) === canonicalJson(profileSubject(candidate)),
    );
  if (!certificate) {
    throw new Error("role model profile has no valid certificate for its exact subject");
  }
  return { ...candidate, certificate };
}

export function assertCallUsesCertifiedRoleModelProfile(specInput: CallSpec): void {
  const spec = CallSpecSchema.parse(specInput);
  if (spec.runMode === "test-dev") return;
  const resolved = resolveRoleModelProfile(spec.roleId);
  const selected = {
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  const certified = {
    modelProfile: resolved.modelProfile,
    modelProfileVersion: resolved.version,
    requestedModel: resolved.model,
    providerPolicy: resolved.providerPolicy,
  };
  if (canonicalJson(selected) !== canonicalJson(certified)) {
    throw new Error("call route does not match the role's certified model profile");
  }
}

function binding(modelProfile: z.infer<typeof ModelProfileNameSchema>) {
  return { profileId: deepSeekV4FlashProfile.profileId, modelProfile };
}

/**
 * Recomputable integrity seal that binds a certificate to its real live run.
 * Hashed over the certified subject/checks/observations plus the two run
 * references (`memoKey` = request identity, `transcriptHash` = response
 * transcript). The certifier computes this from the actual dispatch result;
 * certificate parse recomputes it and rejects any mismatch, so a hand-authored
 * or tampered certificate cannot be selected.
 */
export function certificateEvidenceHash(input: {
  readonly probedAt: string;
  readonly subject: RoleModelProfile;
  readonly checks: Record<string, string>;
  readonly observations: Record<string, unknown>;
  readonly memoKey: string;
  readonly transcriptHash: string;
}): `sha256:${string}` {
  return sha256({
    version: MODEL_PROFILE_CERTIFICATE_VERSION,
    probedAt: input.probedAt,
    subject: input.subject,
    checks: input.checks,
    observations: input.observations,
    memoKey: input.memoKey,
    transcriptHash: input.transcriptHash,
  });
}

function profileVersion(
  model: string,
  providerPolicy: z.infer<typeof ProviderPolicySchema>,
): string {
  return `${MODEL_PROFILE_VERSION_PREFIX}:${sha256({ model, providerPolicy })}`;
}

function profileSubject(profile: RoleModelProfile): RoleModelProfile {
  return {
    profileId: profile.profileId,
    version: profile.version,
    model: profile.model,
    providerPolicy: profile.providerPolicy,
  };
}
