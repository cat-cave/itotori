use super::*;

#[derive(Clone, PartialEq, Eq)]
pub struct KeyResolverPolicy {
    pub allowed_local_secret_prefixes: Vec<String>,
}

impl KeyResolverPolicy {
    pub fn allow_all_local() -> Self {
        Self {
            allowed_local_secret_prefixes: vec![],
        }
    }

    pub fn allow_prefixes(prefixes: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            allowed_local_secret_prefixes: prefixes.into_iter().map(Into::into).collect(),
        }
    }

    pub(crate) fn permits_local_secret_id(&self, local_secret_id: &str) -> bool {
        self.allowed_local_secret_prefixes.is_empty()
            || self
                .allowed_local_secret_prefixes
                .iter()
                .any(|prefix| allow_prefix_authorizes_local_secret_id(prefix, local_secret_id))
    }
}

/// Segment-aware local-secret allow-prefix match.
/// An allow-prefix authorizes an id iff the id EQUALS the prefix (exact) or the
/// id continues past the prefix on a `/`-delimited path SEGMENT boundary
/// (`prefix + "/"`). A trailing `/` on the configured prefix is normalized away
/// so `foo/` and `foo` behave identically.
/// This deliberately rejects raw string-prefix over-matches: an allow-prefix
/// `private/customer/account` authorizes `private/customer/account` and
/// `private/customer/account/key`, but NOT the sibling
/// `private/customer/accounting/key` (segment `accounting`!= `account`).
pub(crate) fn allow_prefix_authorizes_local_secret_id(prefix: &str, local_secret_id: &str) -> bool {
    let boundary = prefix.trim_end_matches('/');
    local_secret_id == boundary
        || local_secret_id
            .strip_prefix(boundary)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl Default for KeyResolverPolicy {
    fn default() -> Self {
        Self::allow_all_local()
    }
}

impl fmt::Debug for KeyResolverPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyResolverPolicy")
            .field(
                "allowed_local_secret_prefixes",
                &format_args!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            )
            .field(
                "allowed_local_secret_prefix_count",
                &self.allowed_local_secret_prefixes.len(),
            )
            .finish()
    }
}

pub struct LocalKeyResolver<S, E = NoExternalSecretResolver> {
    store: S,
    external_resolver: E,
    policy: KeyResolverPolicy,
}

impl<S, E> fmt::Debug for LocalKeyResolver<S, E>
where
    S: fmt::Debug,
    E: fmt::Debug,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalKeyResolver")
            .field("store", &self.store)
            .field("external_resolver", &self.external_resolver)
            .field("policy", &self.policy)
            .finish()
    }
}

impl<S> LocalKeyResolver<S, NoExternalSecretResolver>
where
    S: LocalSecretStore,
{
    pub fn new(store: S) -> Self {
        Self {
            store,
            external_resolver: NoExternalSecretResolver,
            policy: KeyResolverPolicy::default(),
        }
    }
}

impl<S, E> LocalKeyResolver<S, E>
where
    S: LocalSecretStore,
    E: ExternalSecretResolver,
{
    pub fn with_external_resolver<NextExternalResolver>(
        self,
        external_resolver: NextExternalResolver,
    ) -> LocalKeyResolver<S, NextExternalResolver>
    where
        NextExternalResolver: ExternalSecretResolver,
    {
        LocalKeyResolver {
            store: self.store,
            external_resolver,
            policy: self.policy,
        }
    }

    pub fn with_policy(mut self, policy: KeyResolverPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn resolve_profile(
        &self,
        profile: &GameProfile,
    ) -> Result<ResolvedKeySet, KeyResolverError> {
        let validation = profile.validate();
        if validation.status != OperationStatus::Passed {
            return Err(KeyResolverError::out_of_policy(
                None,
                None,
                "profile must pass key-profile validation before resolving secret refs",
            ));
        }
        self.resolve_requirements(
            &profile.key_requirements,
            profile
                .helper_evidence
                .as_ref()
                .map(|evidence| evidence.tool_version.as_str()),
        )
    }

    pub fn resolve_requirements(
        &self,
        requirements: &[KeyRequirement],
        helper_tool_version: Option<&str>,
    ) -> Result<ResolvedKeySet, KeyResolverError> {
        let mut resolved = ResolvedKeySet::default();
        for requirement in requirements {
            let scheme = requirement.secret_ref.scheme();
            let raw_material = match scheme {
                SecretRefScheme::LocalSecret => {
                    let local_secret_id = requirement.secret_ref.name();
                    if !self.policy.permits_local_secret_id(local_secret_id) {
                        return Err(KeyResolverError::out_of_policy(
                            Some(&requirement.requirement_id),
                            Some(scheme),
                            "local-secret id is outside the resolver policy",
                        ));
                    }
                    self.store.read_secret(local_secret_id)?.ok_or_else(|| {
                        KeyResolverError::missing_secret(&requirement.requirement_id, scheme)
                    })?
                }
                SecretRefScheme::OsKeychain
                | SecretRefScheme::SecretManager
                | SecretRefScheme::Prompt => {
                    match self
                        .external_resolver
                        .resolve_external_secret(ExternalSecretRequest {
                            requirement_id: &requirement.requirement_id,
                            scheme,
                            secret_ref_name: requirement.secret_ref.name(),
                            material_kind: requirement.kind,
                            bytes: requirement.bytes,
                        })? {
                        ExternalSecretResolution::Material(material) => material,
                        ExternalSecretResolution::Unavailable => {
                            return Err(KeyResolverError::external_store_unavailable(
                                &requirement.requirement_id,
                                scheme,
                            ));
                        }
                        ExternalSecretResolution::PromptCancelled => {
                            return Err(KeyResolverError::prompt_cancelled(
                                &requirement.requirement_id,
                            ));
                        }
                    }
                }
            };
            let material = normalize_key_material(requirement, scheme, raw_material)?;
            let byte_length = material.byte_len();
            resolved.proof_records.push(ResolvedKeyProofRecord {
                requirement_id: requirement.requirement_id.clone(),
                secret_ref_scheme: scheme,
                material_kind: requirement.kind,
                byte_length,
                readiness_status: KeyResolutionStatus::Resolved,
                validation_method: requirement.validation.as_ref().map(|proof| proof.method),
                proof_hash: requirement
                    .validation
                    .as_ref()
                    .map(|proof| proof.proof_hash.clone()),
                helper_tool_version: helper_tool_version.map(ToOwned::to_owned),
            });
            resolved
                .materials
                .insert(requirement.requirement_id.clone(), material);
        }
        resolved.proof_records.sort_by_key(|proof| {
            (
                proof.requirement_id.clone(),
                serde_json::to_string(&proof.material_kind).unwrap_or_default(),
            )
        });
        Ok(resolved)
    }

    pub fn resolve_secret_ref_str(
        &self,
        requirement_id: &str,
        secret_ref: &str,
        kind: KeyMaterialKind,
        bytes: Option<u32>,
    ) -> Result<ResolvedKeyMaterial, KeyResolverError> {
        let secret_ref =
            SecretRef::new(secret_ref.to_string()).map_err(KeyResolverError::malformed_ref)?;
        let requirement = KeyRequirement {
            requirement_id: requirement_id.to_string(),
            secret_ref,
            kind,
            bytes,
            validation: None,
        };
        let mut resolved = self.resolve_requirements(&[requirement], None)?;
        resolved.materials.remove(requirement_id).ok_or_else(|| {
            KeyResolverError::missing_secret(requirement_id, SecretRefScheme::LocalSecret)
        })
    }
}

pub(crate) fn normalize_key_material(
    requirement: &KeyRequirement,
    scheme: SecretRefScheme,
    raw_material: Vec<u8>,
) -> Result<ResolvedKeyMaterial, KeyResolverError> {
    let bytes = match requirement.kind {
        KeyMaterialKind::FixedBytes => raw_material,
        KeyMaterialKind::HexBytes => {
            let text = std::str::from_utf8(&raw_material).map_err(|_| {
                KeyResolverError::invalid_material(&requirement.requirement_id, scheme)
            })?;
            decode_hex_material(text).ok_or_else(|| {
                KeyResolverError::invalid_material(&requirement.requirement_id, scheme)
            })?
        }
        KeyMaterialKind::RpgMakerAssetKey => normalize_rpg_maker_asset_key_material(raw_material),
        KeyMaterialKind::Utf8String | KeyMaterialKind::ArchivePassword => {
            std::str::from_utf8(&raw_material).map_err(|_| {
                KeyResolverError::invalid_material(&requirement.requirement_id, scheme)
            })?;
            raw_material
        }
    };
    if let Some(expected_len) = requirement.bytes
        && bytes.len() != expected_len as usize
    {
        return Err(KeyResolverError::invalid_material(
            &requirement.requirement_id,
            scheme,
        ));
    }
    if bytes.is_empty() {
        return Err(KeyResolverError::invalid_material(
            &requirement.requirement_id,
            scheme,
        ));
    }
    Ok(ResolvedKeyMaterial::new(bytes))
}
