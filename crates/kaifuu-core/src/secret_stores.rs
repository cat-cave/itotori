use super::*;

pub trait LocalSecretStore {
    fn read_secret(&self, local_secret_id: &str) -> Result<Option<Vec<u8>>, KeyResolverError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExternalSecretRequest<'a> {
    pub requirement_id: &'a str,
    pub scheme: SecretRefScheme,
    pub secret_ref_name: &'a str,
    pub material_kind: KeyMaterialKind,
    pub bytes: Option<u32>,
}

#[derive(Clone, PartialEq, Eq)]
pub enum ExternalSecretResolution {
    Material(Vec<u8>),
    Unavailable,
    PromptCancelled,
}

impl fmt::Debug for ExternalSecretResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Material(material) => formatter
                .debug_tuple("Material")
                .field(&format_args!(
                    "[REDACTED:{}; byte_len={}]",
                    SEMANTIC_SECRET_REDACTED,
                    material.len()
                ))
                .finish(),
            Self::Unavailable => formatter.write_str("Unavailable"),
            Self::PromptCancelled => formatter.write_str("PromptCancelled"),
        }
    }
}

pub trait ExternalSecretResolver {
    fn resolve_external_secret(
        &self,
        request: ExternalSecretRequest<'_>,
    ) -> Result<ExternalSecretResolution, KeyResolverError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoExternalSecretResolver;

impl ExternalSecretResolver for NoExternalSecretResolver {
    fn resolve_external_secret(
        &self,
        _request: ExternalSecretRequest<'_>,
    ) -> Result<ExternalSecretResolution, KeyResolverError> {
        Ok(ExternalSecretResolution::Unavailable)
    }
}

#[derive(Clone, Default)]
pub struct InMemoryLocalSecretStore {
    secrets: BTreeMap<String, Vec<u8>>,
}

impl InMemoryLocalSecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_secret(mut self, local_secret_id: impl Into<String>, material: Vec<u8>) -> Self {
        self.secrets.insert(local_secret_id.into(), material);
        self
    }

    pub fn fixture_ci() -> Self {
        Self::new()
            .with_secret(
                "fixture/siglus/secondary-key",
                (0_u8..16).collect::<Vec<_>>(),
            )
            .with_secret(
                "fixture/rpg-maker/asset-key",
                b"00112233445566778899aabbccddeeff".to_vec(),
            )
    }
}

impl LocalSecretStore for InMemoryLocalSecretStore {
    fn read_secret(&self, local_secret_id: &str) -> Result<Option<Vec<u8>>, KeyResolverError> {
        Ok(self.secrets.get(local_secret_id).cloned())
    }
}

impl fmt::Debug for InMemoryLocalSecretStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InMemoryLocalSecretStore")
            .field("secret_count", &self.secrets.len())
            .finish()
    }
}

#[derive(Clone)]
pub struct LocalSecretDirectoryStore {
    root: PathBuf,
    max_secret_bytes: usize,
}

impl LocalSecretDirectoryStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_secret_bytes: 4096,
        }
    }

    pub fn with_max_secret_bytes(mut self, max_secret_bytes: usize) -> Self {
        self.max_secret_bytes = max_secret_bytes;
        self
    }

    pub fn support_boundary(&self) -> &'static str {
        local_secret_directory_support_boundary()
    }

    pub fn import_key_reference(
        &self,
        request: LocalKeyImportRequest,
    ) -> Result<LocalKeyImportResult, KeyResolverError> {
        if request.secret_ref.scheme() != SecretRefScheme::LocalSecret {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(request.secret_ref.scheme()),
                "manual key imports may only write local-secret refs",
            ));
        }
        if request.material.is_empty() || request.material.len() > self.max_secret_bytes {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret import material must be non-empty and within the configured byte limit",
            ));
        }
        if request.key_purpose.trim().is_empty() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "key purpose metadata must not be empty",
            ));
        }
        if request.engine_profile_id.trim().is_empty() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "engine profile id metadata must not be empty",
            ));
        }
        if request.redaction_status != HelperRedactionStatus::Redacted {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "manual and known-key imports must persist only redacted metadata",
            ));
        }

        let secret_path = self.checked_new_secret_path(request.secret_ref.name())?;
        let metadata_path = self.metadata_path_for_secret(request.secret_ref.name())?;
        write_secret_material_no_clobber(&secret_path, &request.material)?;

        let result = LocalKeyImportResult {
            schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
            import_id: deterministic_id("key-import", 87),
            secret_ref: request.secret_ref.clone(),
            key_purpose: request.key_purpose,
            engine_profile_id: request.engine_profile_id,
            source_hash: request.source_hash,
            material_hash: ProofHash::new(sha256_hash_bytes(&request.material))
                .expect("sha256_hash_bytes returns a canonical proof hash"),
            material_bytes: request.material.len(),
            redaction_status: request.redaction_status,
            source: request.source,
            stored_local_ref: true,
            diagnostics: vec![],
        }
        .redacted_for_report();

        let metadata = result.stable_json().map_err(|_| {
            KeyResolverError::store_unavailable("local key import metadata could not be serialized")
        })?;
        if let Err(error) = atomic_write_text(&metadata_path, &metadata) {
            let _ = fs::remove_file(&secret_path);
            return Err(KeyResolverError::store_unavailable(format!(
                "local key import metadata could not be written: {}",
                redact_for_log_or_report(&error.to_string())
            )));
        }
        Ok(result)
    }

    pub(crate) fn checked_new_secret_path(
        &self,
        local_secret_id: &str,
    ) -> Result<PathBuf, KeyResolverError> {
        let parts = safe_relative_path_parts(local_secret_id).map_err(|_| {
            KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret ids must map to safe relative store paths",
            )
        })?;
        ensure_real_directory(&self.root)?;
        let root = fs::canonicalize(&self.root).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store root could not be canonicalized",
            )
        })?;
        let mut parent = self.root.clone();
        for part in &parts[..parts.len().saturating_sub(1)] {
            parent.push(part);
            ensure_real_directory(&parent)?;
        }
        let canonical_parent = fs::canonicalize(&parent).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store parent could not be canonicalized",
            )
        })?;
        if !canonical_parent.starts_with(&root) {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material must remain under the configured store root",
            ));
        }
        let mut candidate = parent;
        candidate.push(
            parts
                .last()
                .expect("validated refs contain at least one part"),
        );
        if fs::symlink_metadata(&candidate).is_ok() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret import refuses to overwrite existing material",
            ));
        }
        Ok(candidate)
    }

    pub(crate) fn metadata_path_for_secret(
        &self,
        local_secret_id: &str,
    ) -> Result<PathBuf, KeyResolverError> {
        let mut path = safe_join_relative(&self.root, local_secret_id).map_err(|_| {
            KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret ids must map to safe relative store paths",
            )
        })?;
        let file_name = path
            .file_name()
            .ok_or_else(|| {
                KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret ids must include a final path component",
                )
            })?
            .to_string_lossy()
            .to_string();
        path.set_file_name(format!("{file_name}.kaifuu-key.json"));
        Ok(path)
    }

    pub(crate) fn checked_secret_path(
        &self,
        local_secret_id: &str,
    ) -> Result<Option<(PathBuf, fs::Metadata)>, KeyResolverError> {
        let parts = safe_relative_path_parts(local_secret_id).map_err(|_| {
            KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret ids must map to safe relative store paths",
            )
        })?;
        let root_metadata = fs::symlink_metadata(&self.root).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store root metadata could not be read",
            )
        })?;
        if root_metadata.file_type().is_symlink() || !root_metadata.file_type().is_dir() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local secret store root must be a real directory",
            ));
        }
        let root = fs::canonicalize(&self.root).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store root could not be canonicalized",
            )
        })?;
        let mut candidate = self.root.clone();
        for (index, part) in parts.iter().enumerate() {
            candidate.push(part);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(_) => {
                    return Err(KeyResolverError::store_unavailable(
                        "local secret store could not read secret metadata",
                    ));
                }
            };
            if metadata.file_type().is_symlink() {
                return Err(KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret paths must not contain symlink components",
                ));
            }
            let is_final = index + 1 == parts.len();
            if is_final {
                if !metadata.file_type().is_file() {
                    return Err(KeyResolverError::out_of_policy(
                        None,
                        Some(SecretRefScheme::LocalSecret),
                        "local-secret material must be stored in regular files",
                    ));
                }
                if metadata.len() > self.max_secret_bytes as u64 {
                    return Err(KeyResolverError::out_of_policy(
                        None,
                        Some(SecretRefScheme::LocalSecret),
                        "local-secret material exceeds the configured byte limit",
                    ));
                }
            } else if !metadata.file_type().is_dir() {
                return Err(KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret parent components must be real directories",
                ));
            }
        }
        let canonical_candidate = fs::canonicalize(&candidate).map_err(|_| {
            KeyResolverError::store_unavailable("local secret material could not be canonicalized")
        })?;
        if !canonical_candidate.starts_with(&root) {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material must remain under the configured store root",
            ));
        }
        let metadata = fs::metadata(&canonical_candidate).map_err(|_| {
            KeyResolverError::store_unavailable("local secret material metadata could not be read")
        })?;
        Ok(Some((canonical_candidate, metadata)))
    }
}

impl LocalSecretStore for LocalSecretDirectoryStore {
    fn read_secret(&self, local_secret_id: &str) -> Result<Option<Vec<u8>>, KeyResolverError> {
        let Some((path, preopen_metadata)) = self.checked_secret_path(local_secret_id)? else {
            return Ok(None);
        };
        let mut file = File::open(&path).map_err(|_| {
            KeyResolverError::store_unavailable("local secret store could not open secret material")
        })?;
        let open_metadata = file.metadata().map_err(|_| {
            KeyResolverError::store_unavailable("local secret store could not inspect open secret")
        })?;
        verify_opened_secret_matches_preopen_metadata(&preopen_metadata, &open_metadata)?;
        if open_metadata.len() > self.max_secret_bytes as u64 {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material exceeds the configured byte limit",
            ));
        }
        let mut material = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(self.max_secret_bytes as u64 + 1)
            .read_to_end(&mut material)
            .map_err(|_| {
                KeyResolverError::store_unavailable(
                    "local secret store could not read secret material",
                )
            })?;
        if material.len() > self.max_secret_bytes {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material exceeds the configured byte limit",
            ));
        }
        Ok(Some(material))
    }
}

impl fmt::Debug for LocalSecretDirectoryStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalSecretDirectoryStore")
            .field(
                "root",
                &format_args!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            )
            .field("max_secret_bytes", &self.max_secret_bytes)
            .finish()
    }
}

#[cfg(unix)]
pub(crate) fn verify_opened_secret_matches_preopen_metadata(
    preopen_metadata: &fs::Metadata,
    open_metadata: &fs::Metadata,
) -> Result<(), KeyResolverError> {
    use std::os::unix::fs::MetadataExt;

    if preopen_metadata.dev() == open_metadata.dev()
        && preopen_metadata.ino() == open_metadata.ino()
    {
        Ok(())
    } else {
        Err(KeyResolverError::out_of_policy(
            None,
            Some(SecretRefScheme::LocalSecret),
            "local-secret file changed while being opened",
        ))
    }
}

#[cfg(not(unix))]
pub(crate) fn verify_opened_secret_matches_preopen_metadata(
    _preopen_metadata: &fs::Metadata,
    open_metadata: &fs::Metadata,
) -> Result<(), KeyResolverError> {
    if open_metadata.file_type().is_file() {
        Ok(())
    } else {
        Err(KeyResolverError::out_of_policy(
            None,
            Some(SecretRefScheme::LocalSecret),
            "local-secret opened material is not a regular file",
        ))
    }
}

#[cfg(unix)]
pub(crate) fn local_secret_directory_support_boundary() -> &'static str {
    "component symlink rejection, canonical root containment, regular-file checks, and Unix device/inode recheck after open; no real keychain or prompt backend"
}

#[cfg(not(unix))]
pub(crate) fn local_secret_directory_support_boundary() -> &'static str {
    "component symlink rejection, canonical root containment, and regular-file checks; final device/inode recheck is unavailable on this platform in std"
}
