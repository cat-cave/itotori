import { createPrivateKey, sign as signDetached, verify as verifyDetached } from "node:crypto";
import { z } from "zod";
import {
  CallSpecSchema,
  DecimalUsdSchema,
  ProviderPolicySchema,
  RebuildCallWirePolicySchema,
  RoleIdSchema,
  Sha256Schema,
  ServedPairSchema,
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
export const MODEL_PROFILE_CERTIFICATE_REGISTRATION_VERSION =
  "itotori.model-profile-certificate-registration.v1" as const;
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
const ConfirmedServedPairSchema = ServedPairSchema.refine(
  (value) => value.status === "confirmed",
  "reconciled certificate requires a confirmed served route",
);
const GenerationIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, "generation ID must not have outer whitespace");
const PositiveBilledUsdSchema = DecimalUsdSchema.refine((value) => Number(value) > 0, {
  message: "certified provider cost must be positive",
});

const CertificateRunBindingSchema = z
  .object({
    memoKey: Sha256Schema,
    transcriptHash: Sha256Schema,
  })
  .strict();

const CertificateObservationBaseShape = {
  physicalStepCount: z.number().int().positive(),
  toolExecutionCount: z.number().int().positive(),
  reasoningDetailBatchCount: z.number().int().positive(),
  forwardedReasoningDetailBatchCount: z.number().int().positive(),
  usage: TokenUsageSchema,
  billedUsdByStep: z.array(PositiveBilledUsdSchema).min(1).max(4),
  // This makes the zero-lookup branch auditable: only a deliberately disabled
  // reconciliation configuration may certify it as deferred.
  generationReconciliation: z.enum(["enabled", "disabled"]),
  runBinding: CertificateRunBindingSchema,
} as const;

const CertificateObservationsSchema = z.union([
  z
    .object({
      ...CertificateObservationBaseShape,
      generationReconciliation: z.literal("disabled"),
      generationLookupAttempts: z.literal(0),
      generationId: z.null(),
      served: UnknownServedPairSchema,
    })
    .strict(),
  z
    .object({
      ...CertificateObservationBaseShape,
      generationReconciliation: z.literal("enabled"),
      generationLookupAttempts: z.literal(1),
      generationId: GenerationIdSchema,
      served: ConfirmedServedPairSchema,
    })
    .strict(),
  z
    .object({
      ...CertificateObservationBaseShape,
      generationReconciliation: z.literal("enabled"),
      generationLookupAttempts: z.literal(1),
      generationId: GenerationIdSchema,
      served: UnknownServedPairSchema,
    })
    .strict(),
]);

export const ModelProfileCertificateSchema = z
  .object({
    schemaVersion: z.literal(MODEL_PROFILE_CERTIFICATE_VERSION),
    certificateStatus: z.enum(["valid", "invalid"]),
    probeMode: z.enum(["live", "recorded"]),
    probedAt: z.iso.datetime({ offset: true }),
    subject: RoleModelProfileSchema,
    checks: ProbeChecksSchema,
    observations: CertificateObservationsSchema,
  })
  .strict()
  .superRefine((value, context) => {
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
    const deferred =
      value.checks.generationLookup === "deferred" &&
      value.checks.servedPairVerification === "deferred" &&
      value.observations.generationReconciliation === "disabled" &&
      value.observations.generationLookupAttempts === 0 &&
      value.observations.generationId === null &&
      value.observations.served.status === "unknown";
    const verified =
      value.checks.generationLookup === "passed" &&
      value.checks.servedPairVerification === "passed" &&
      value.observations.generationReconciliation === "enabled" &&
      value.observations.generationLookupAttempts === 1 &&
      value.observations.generationId !== null &&
      value.observations.served.status === "confirmed";
    const explicitUnknown =
      value.checks.generationLookup === "passed" &&
      value.checks.servedPairVerification === "deferred" &&
      value.observations.generationReconciliation === "enabled" &&
      value.observations.generationLookupAttempts === 1 &&
      value.observations.generationId !== null &&
      value.observations.served.status === "unknown";
    if (!deferred && !verified && !explicitUnknown) {
      context.addIssue({
        code: "custom",
        message:
          "certificate generation evidence must be exactly disabled, explicitly unknown, or exactly verified",
      });
    }
    if (
      verified &&
      value.observations.served.status === "confirmed" &&
      !servedModelIsCertified(value.observations.served.model, value.subject.model)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observations", "served", "model"],
        message: "reconciled served model is outside the certified model family",
      });
    }
  });

const CertificateAttestationSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    keyId: z.literal("itotori-model-profile-certifier-2026-07"),
    signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  })
  .strict();

const MODEL_PROFILE_CERTIFIER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAsqqiH/VOaKLxXomim17wfr2kH2oVxvQ95bLjyr/MOUc=
-----END PUBLIC KEY-----`;

export const RegisteredModelProfileCertificateSchema = z
  .object({
    schemaVersion: z.literal(MODEL_PROFILE_CERTIFICATE_REGISTRATION_VERSION),
    certificate: ModelProfileCertificateSchema,
    attestation: CertificateAttestationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const signature = Buffer.from(value.attestation.signature, "base64");
    const verified = verifyDetached(
      null,
      Buffer.from(registeredCertificatePayload(value.certificate)),
      MODEL_PROFILE_CERTIFIER_PUBLIC_KEY,
      signature,
    );
    if (!verified) {
      context.addIssue({
        code: "custom",
        path: ["attestation", "signature"],
        message: "certificate attestation does not verify against the trusted certifier key",
      });
    }
  });

export type RoleModelProfile = z.infer<typeof RoleModelProfileSchema>;
export type RoleModelProfileConfig = z.infer<typeof RoleModelProfileConfigSchema>;
export type ModelProfileCertificate = z.infer<typeof ModelProfileCertificateSchema>;
export type RegisteredModelProfileCertificate = z.infer<
  typeof RegisteredModelProfileCertificateSchema
>;
export type ResolvedRoleModelProfile = RoleModelProfile & {
  readonly roleId: RoleId;
  readonly modelProfile: z.infer<typeof ModelProfileNameSchema>;
  readonly certificate: ModelProfileCertificate;
};

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

export function servedModelIsCertified(servedModel: string, certifiedModel: string): boolean {
  if (servedModel === certifiedModel) return true;
  const suffix = servedModel.startsWith(`${certifiedModel}-`)
    ? servedModel.slice(certifiedModel.length + 1)
    : null;
  return suffix !== null && /^\d{8}$/u.test(suffix);
}

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
    .map((value) => RegisteredModelProfileCertificateSchema.safeParse(value))
    .flatMap((result) => (result.success ? [result.data] : []))
    .find(
      (value) =>
        value.certificate.certificateStatus === "valid" &&
        canonicalJson(value.certificate.subject) === canonicalJson(profileSubject(candidate)),
    );
  if (!certificate) {
    throw new Error("role model profile has no valid trusted certificate for its exact subject");
  }
  return { ...candidate, certificate: certificate.certificate };
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

export function registerModelProfileCertificate(
  certificateInput: unknown,
  privateKeyPem: string,
): RegisteredModelProfileCertificate {
  const certificate = ModelProfileCertificateSchema.parse(certificateInput);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("model profile certificate registration requires an Ed25519 private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("model profile certificate registration requires an Ed25519 private key");
  }
  return RegisteredModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_REGISTRATION_VERSION,
    certificate,
    attestation: {
      algorithm: "ed25519",
      keyId: "itotori-model-profile-certifier-2026-07",
      signature: signDetached(
        null,
        Buffer.from(registeredCertificatePayload(certificate)),
        privateKey,
      ).toString("base64"),
    },
  });
}

function registeredCertificatePayload(certificate: ModelProfileCertificate): string {
  return canonicalJson({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_REGISTRATION_VERSION,
    certificate,
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
