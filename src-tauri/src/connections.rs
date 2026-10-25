//! Native credential ownership. IPC responses contain references, never API keys.
//! Cloud secure storage is macOS-only; Ollama does not touch auth metadata or Keychain.
//! Rotation retains superseded Keychain items as recovery orphans; deleting the
//! active credential invalidates all runtime sessions, but orphan garbage
//! collection is deliberately deferred rather than risking a failed-save key loss.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::Store;
use uuid::Uuid;

const MAX_RUNTIMES: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDefaults {
    gemini_model: String,
}

fn default_gemini_model() -> &'static str {
    static DEFAULTS: OnceLock<ProviderDefaults> = OnceLock::new();
    &DEFAULTS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../src/providerDefaults.json"))
                .expect("Bundled provider defaults must be valid JSON")
        })
        .gemini_model
}
const STALE: &str =
    "인증 정보가 다른 창에서 변경되었습니다. 설정을 새로고침한 뒤 다시 시도해주세요.";
const VAULT_ERROR: &str =
    "보안 저장소에 접근할 수 없습니다. macOS 키체인 잠금과 앱 접근 권한을 확인해주세요.";
const METADATA_ERROR: &str =
    "보안 인증 설정을 읽거나 저장할 수 없습니다. 기존 인증 정보는 유지됩니다.";
const MISSING_KEY: &str =
    "인증 설정이 가리키는 키를 키체인에서 찾을 수 없습니다. 설정에서 API 키를 다시 저장해주세요.";
const LEGACY_CONFLICT: &str =
    "키체인과 기존 설정의 인증 정보가 달라 자동 정리를 중단했습니다. 기존 키는 유지됩니다.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum CloudProvider {
    Gemini,
    OpenAi,
}
impl CloudProvider {
    fn parse(id: &str) -> Result<Self, String> {
        match id {
            "gemini-native" => Ok(Self::Gemini),
            "openai" => Ok(Self::OpenAi),
            _ => Err("지원하지 않는 보안 인증 공급자입니다.".into()),
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Gemini => "gemini-native",
            Self::OpenAi => "openai",
        }
    }
    fn endpoint(self) -> &'static str {
        match self {
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Self::OpenAi => "https://api.openai.com/v1",
        }
    }
    fn legacy_key(self) -> &'static str {
        match self {
            Self::Gemini => "apiKey",
            Self::OpenAi => "openaiApiKey",
        }
    }
    fn protocol(self) -> &'static str {
        match self {
            Self::Gemini => "gemini-native",
            Self::OpenAi => "openai-compatible",
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthProfile {
    provider_id: String,
    base_url: String,
    credential_ref: Option<String>,
    revision: String,
}
impl AuthProfile {
    fn validate(&self, provider: CloudProvider) -> Result<(), String> {
        if self.provider_id != provider.id()
            || self.base_url != provider.endpoint()
            || Uuid::parse_str(&self.revision).is_err()
        {
            return Err(METADATA_ERROR.into());
        }
        if let Some(reference) = &self.credential_ref {
            let prefix = format!("keychain:{}:", provider.id());
            if !reference
                .strip_prefix(&prefix)
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
            {
                return Err(METADATA_ERROR.into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AuthMetadata {
    version: u32,
    providers: BTreeMap<String, AuthProfile>,
}
impl Default for AuthMetadata {
    fn default() -> Self {
        Self {
            version: 1,
            providers: BTreeMap::new(),
        }
    }
}
impl AuthMetadata {
    fn profile(&self, provider: CloudProvider) -> Result<Option<&AuthProfile>, String> {
        if self.version != 1 {
            return Err(METADATA_ERROR.into());
        }
        let profile = self.providers.get(provider.id());
        if let Some(profile) = profile {
            profile.validate(provider)?;
        }
        Ok(profile)
    }
}

/// The environment boundary keeps fault tests away from user files and Keychain.
trait AuthEnvironment {
    fn secure_available(&self) -> Result<(), String>;
    fn read_metadata(&mut self) -> Result<AuthMetadata, String>;
    fn write_metadata(&mut self, metadata: &AuthMetadata) -> Result<(), String>;
    fn read_secret(
        &mut self,
        provider: CloudProvider,
        reference: &str,
    ) -> Result<Option<String>, String>;
    fn write_secret(
        &mut self,
        provider: CloudProvider,
        reference: &str,
        secret: &str,
    ) -> Result<(), String>;
    fn delete_secret(&mut self, provider: CloudProvider, reference: &str) -> Result<(), String>;
    fn legacy_secret(&mut self, provider: CloudProvider) -> Result<Option<String>, String>;
    fn remove_legacy(&mut self, provider: CloudProvider, expected: &str) -> Result<(), String>;
}

fn commit_metadata(
    env: &mut impl AuthEnvironment,
    previous: &AuthMetadata,
    next: &AuthMetadata,
) -> Result<(), String> {
    let commit = env.write_metadata(next).and_then(|_| {
        if env.read_metadata()? == *next {
            Ok(())
        } else {
            Err(METADATA_ERROR.into())
        }
    });
    if commit.is_err() {
        // Both old and newly verified Keychain items remain intact if rollback also fails.
        let _ = env.write_metadata(previous);
        return Err(METADATA_ERROR.into());
    }
    Ok(())
}

fn new_profile(provider: CloudProvider, credential_ref: Option<String>) -> AuthProfile {
    AuthProfile {
        provider_id: provider.id().into(),
        base_url: provider.endpoint().into(),
        credential_ref,
        revision: Uuid::new_v4().to_string(),
    }
}
fn write_verified_secret(
    env: &mut impl AuthEnvironment,
    provider: CloudProvider,
    secret: &str,
) -> Result<String, String> {
    let reference = format!("keychain:{}:{}", provider.id(), Uuid::new_v4());
    env.write_secret(provider, &reference, secret)?;
    if env.read_secret(provider, &reference)?.as_deref() != Some(secret) {
        return Err(VAULT_ERROR.into());
    }
    Ok(reference)
}
fn configured_secret(
    env: &mut impl AuthEnvironment,
    provider: CloudProvider,
    profile: &AuthProfile,
) -> Result<Option<String>, String> {
    match &profile.credential_ref {
        Some(reference) => env
            .read_secret(provider, reference)?
            .filter(|key| !key.is_empty())
            .map(Some)
            .ok_or_else(|| MISSING_KEY.into()),
        None => Ok(None),
    }
}

/// Migration is resumable at every boundary. A published ref is always verified
/// before plaintext is removed; a tombstone never revives a legacy credential.
fn migrate_provider(
    env: &mut impl AuthEnvironment,
    provider: CloudProvider,
) -> Result<(AuthMetadata, Option<AuthProfile>), String> {
    env.secure_available()?;
    let metadata = env.read_metadata()?;
    let existing = metadata.profile(provider)?.cloned();
    if let Some(profile) = &existing {
        if profile.credential_ref.is_none() {
            return Ok((metadata, existing));
        }
        let secret = configured_secret(env, provider, profile)?.ok_or(MISSING_KEY)?;
        if let Some(legacy) = env.legacy_secret(provider)? {
            if legacy != secret {
                return Err(LEGACY_CONFLICT.into());
            }
            env.remove_legacy(provider, &legacy)?;
        }
        return Ok((metadata, existing));
    }
    let Some(legacy) = env.legacy_secret(provider)? else {
        return Ok((metadata, None));
    };
    let reference = write_verified_secret(env, provider, &legacy)?;
    let profile = new_profile(provider, Some(reference));
    let mut next = metadata.clone();
    next.providers.insert(provider.id().into(), profile.clone());
    commit_metadata(env, &metadata, &next)?;
    // Keep the verified Keychain ref on cleanup failure, so a restart resumes here.
    env.remove_legacy(provider, &legacy)?;
    Ok((next, Some(profile)))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub configured: bool,
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
fn status(profile: Option<&AuthProfile>) -> CredentialStatus {
    CredentialStatus {
        configured: profile.is_some_and(|profile| profile.credential_ref.is_some()),
        revision: profile.map(|profile| profile.revision.clone()),
        error: None,
    }
}
fn credential_status(
    env: &mut impl AuthEnvironment,
    provider: CloudProvider,
) -> Result<CredentialStatus, String> {
    match migrate_provider(env, provider) {
        Ok((_, profile)) => Ok(status(profile.as_ref())),
        Err(error) if error == MISSING_KEY || error == LEGACY_CONFLICT => {
            // Keep a valid revision available for an explicit CAS repair, while
            // clearly distinguishing broken secure storage from unconfigured.
            let metadata = env.read_metadata()?;
            let profile = metadata.profile(provider)?.ok_or(METADATA_ERROR)?;
            let mut result = status(Some(profile));
            result.error = Some(error);
            Ok(result)
        }
        Err(error) => Err(error),
    }
}
fn check_revision(profile: Option<&AuthProfile>, expected: Option<&str>) -> Result<(), String> {
    if profile.map(|profile| profile.revision.as_str()) != expected {
        return Err(STALE.into());
    }
    Ok(())
}
fn save_credential(
    env: &mut impl AuthEnvironment,
    provider: CloudProvider,
    secret: &str,
    expected: Option<&str>,
) -> Result<CredentialStatus, String> {
    if secret.trim().is_empty() {
        return Err("저장할 API 키를 입력해주세요.".into());
    }
    env.secure_available()?;
    let metadata = env.read_metadata()?;
    let previous = metadata.profile(provider)?.cloned();
    check_revision(previous.as_ref(), expected)?;
    if let Some(profile) = &previous {
        match configured_secret(env, provider, profile) {
            Ok(_) => {}
            Err(error) if error == MISSING_KEY => {}
            Err(error) => return Err(error),
        }
    }
    let legacy = env.legacy_secret(provider)?;
    let reference = write_verified_secret(env, provider, secret)?;
    let profile = new_profile(provider, Some(reference));
    let mut next = metadata.clone();
    next.providers.insert(provider.id().into(), profile.clone());
    commit_metadata(env, &metadata, &next)?;
    if let Some(legacy) = legacy {
        env.remove_legacy(provider, &legacy)?;
    }
    Ok(status(Some(&profile)))
}
fn delete_credential(
    env: &mut impl AuthEnvironment,
    provider: CloudProvider,
    expected: Option<&str>,
) -> Result<CredentialStatus, String> {
    let (metadata, previous) = match migrate_provider(env, provider) {
        Ok(result) => result,
        Err(error) if error == MISSING_KEY || error == LEGACY_CONFLICT => {
            let metadata = env.read_metadata()?;
            let previous = metadata.profile(provider)?.cloned();
            (metadata, previous)
        }
        Err(error) => return Err(error),
    };
    check_revision(previous.as_ref(), expected)?;
    let previous_secret = if let Some(profile) = &previous {
        match configured_secret(env, provider, profile) {
            Ok(secret) => secret,
            Err(error) if error == MISSING_KEY => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let legacy = env.legacy_secret(provider)?;
    if let Some(legacy) = &legacy {
        // A missing/corrupt active item must not make cleanup of the final
        // remaining plaintext source irreversible on a later I/O failure.
        if previous_secret.as_deref() != Some(legacy) {
            let _ = write_verified_secret(env, provider, legacy)?;
        }
    }
    let profile = new_profile(provider, None);
    let mut next = metadata.clone();
    next.providers.insert(provider.id().into(), profile.clone());
    commit_metadata(env, &metadata, &next)?;
    if let Some(legacy) = legacy {
        if env.remove_legacy(provider, &legacy).is_err() {
            let _ = env.write_metadata(&metadata);
            return Err(METADATA_ERROR.into());
        }
    }
    if let Some(reference) = previous
        .as_ref()
        .and_then(|profile| profile.credential_ref.as_ref())
    {
        if env.delete_secret(provider, reference).is_err() {
            // Preserve the old key even if the platform failed after a partial delete.
            if let Some(secret) = previous_secret {
                let _ = env.write_secret(provider, reference, &secret);
            }
            let _ = env.write_metadata(&metadata);
            return Err(VAULT_ERROR.into());
        }
    }
    Ok(status(Some(&profile)))
}

#[derive(Clone, Serialize)]
pub struct ProfileAuth {
    pub kind: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub provider_id: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub auth: ProfileAuth,
    pub credential_ref: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshot {
    pub profile: ConnectionProfile,
    pub runtime_id: String,
}

// Intentionally no Debug/Serialize: these values must never cross IPC or logs.
pub struct RuntimeCredential {
    pub model: String,
    pub api_key: String,
}
struct RuntimeSession {
    snapshot: NativeSnapshot,
    credential: RuntimeCredential,
}
#[derive(Clone, Default)]
pub struct ConnectionManager {
    auth_lock: Arc<Mutex<()>>,
    sessions: Arc<Mutex<VecDeque<RuntimeSession>>>,
}
impl ConnectionManager {
    fn capture(
        &self,
        profile: ConnectionProfile,
        api_key: String,
    ) -> Result<NativeSnapshot, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AI 연결 세션 잠금 오류입니다.")?;
        if let Some(session) = sessions.iter().find(|session| {
            let old = &session.snapshot.profile;
            old.provider_id == profile.provider_id
                && old.base_url == profile.base_url
                && old.model == profile.model
                && old.credential_ref == profile.credential_ref
                && session.credential.api_key == api_key
        }) {
            return Ok(session.snapshot.clone());
        }
        let snapshot = NativeSnapshot {
            profile,
            runtime_id: Uuid::new_v4().to_string(),
        };
        let credential = RuntimeCredential {
            model: snapshot.profile.model.clone(),
            api_key,
        };
        sessions.push_back(RuntimeSession {
            snapshot: snapshot.clone(),
            credential,
        });
        while sessions.len() > MAX_RUNTIMES {
            sessions.pop_front();
        }
        Ok(snapshot)
    }
    fn invalidate(&self, provider: CloudProvider) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "AI 연결 세션 잠금 오류입니다.")?
            .retain(|session| session.snapshot.profile.provider_id != provider.id());
        Ok(())
    }
}
pub fn resolve_runtime(
    manager: &ConnectionManager,
    runtime_id: &str,
    expected_provider: &str,
) -> Result<RuntimeCredential, String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "AI 연결 세션 잠금 오류입니다.")?;
    let session = sessions
        .iter()
        .find(|session| session.snapshot.runtime_id == runtime_id)
        .ok_or("AI 연결 세션이 만료되었거나 삭제되었습니다. 설정을 확인한 뒤 다시 시도해주세요.")?;
    if session.snapshot.profile.provider_id != expected_provider {
        return Err("AI 연결 세션과 요청한 공급자가 일치하지 않습니다.".into());
    }
    if expected_provider != "ollama" && session.credential.api_key.is_empty() {
        return Err(
            "API 키가 설정되지 않았습니다. 설정에서 해당 공급자의 API 키를 저장해주세요.".into(),
        );
    }
    Ok(RuntimeCredential {
        model: session.credential.model.clone(),
        api_key: session.credential.api_key.clone(),
    })
}

fn delete_and_invalidate(
    env: &mut impl AuthEnvironment,
    manager: &ConnectionManager,
    provider: CloudProvider,
    expected: Option<&str>,
) -> Result<CredentialStatus, String> {
    let result = delete_credential(env, provider, expected)?;
    manager.invalidate(provider)?;
    Ok(result)
}

fn setting(entries: &BTreeMap<String, Value>, key: &str, fallback: &str) -> Result<String, String> {
    match entries.get(key) {
        None => Ok(fallback.into()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err("AI 연결 설정 형식이 올바르지 않습니다. 설정을 다시 저장해주세요.".into()),
    }
}
fn cloud_model(
    entries: &BTreeMap<String, Value>,
    provider: CloudProvider,
) -> Result<String, String> {
    let (key, fallback) = match provider {
        CloudProvider::Gemini => ("model", default_gemini_model()),
        CloudProvider::OpenAi => ("openaiModel", "gpt-4o-mini"),
    };
    let model = setting(entries, key, fallback)?.trim().to_string();
    if model.is_empty() {
        return Err("AI 모델 이름을 확인해주세요.".into());
    }
    Ok(model)
}

fn normalize_ollama_url(value: &str) -> Result<String, String> {
    let raw = value.trim();
    let invalid = || {
        "Ollama URL은 사용자 정보, 쿼리, 프래그먼트가 없는 http 또는 https 주소여야 합니다."
            .to_string()
    };
    if !raw.split_once("://").is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    }) {
        return Err(invalid());
    }
    let authority = raw
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""));
    if authority.is_some_and(|authority| authority.contains('@')) || raw.contains(['?', '#', '\\'])
    {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| invalid())?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(invalid());
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn capture_ollama(
    manager: &ConnectionManager,
    entries: &BTreeMap<String, Value>,
) -> Result<NativeSnapshot, String> {
    let model = setting(entries, "ollamaModel", "gemma3:4b")?
        .trim()
        .to_string();
    if model.is_empty() {
        return Err("Ollama 모델 이름을 확인해주세요.".into());
    }
    let base_url = normalize_ollama_url(&setting(
        entries,
        "ollamaBaseUrl",
        "http://localhost:11434",
    )?)?;
    manager.capture(
        ConnectionProfile {
            id: "legacy:ollama".into(),
            provider_id: "ollama".into(),
            protocol: "openai-compatible".into(),
            base_url,
            model,
            auth: ProfileAuth {
                kind: "none".into(),
            },
            credential_ref: None,
        },
        String::new(),
    )
}

struct NativeEnvironment {
    app: AppHandle,
    path: PathBuf,
    settings_path: PathBuf,
    store: Arc<Store<tauri::Wry>>,
}
impl NativeEnvironment {
    fn new(app: &AppHandle, store: Arc<Store<tauri::Wry>>) -> Result<Self, String> {
        let directory = app.path().app_data_dir().map_err(|_| METADATA_ERROR)?;
        Ok(Self {
            app: app.clone(),
            path: directory.join("auth-profiles.json"),
            settings_path: directory.join("settings.json"),
            store,
        })
    }
}
fn atomic_metadata(path: &Path, metadata: &AuthMetadata) -> Result<(), String> {
    let parent = path.parent().ok_or(METADATA_ERROR)?;
    fs::create_dir_all(parent).map_err(|_| METADATA_ERROR)?;
    let temporary = parent.join(format!(".auth-profiles-{}.tmp", Uuid::new_v4()));
    let write = (|| {
        let bytes = serde_json::to_vec(metadata).map_err(|_| METADATA_ERROR)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| METADATA_ERROR)?;
        file.write_all(&bytes).map_err(|_| METADATA_ERROR)?;
        file.sync_all().map_err(|_| METADATA_ERROR)?;
        fs::rename(&temporary, path).map_err(|_| METADATA_ERROR)?;
        fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| METADATA_ERROR)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write
}

#[cfg(target_os = "macos")]
fn password_options(
    provider: CloudProvider,
    reference: &str,
) -> security_framework::passwords::PasswordOptions {
    let service = format!("com.ykworx.transrator.auth.{}", provider.id());
    let mut options =
        security_framework::passwords::PasswordOptions::new_generic_password(&service, reference);
    options.set_access_synchronized(Some(false));
    options
}
impl AuthEnvironment for NativeEnvironment {
    fn secure_available(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("클라우드 API 키 보안 저장은 현재 macOS에서만 지원됩니다. 로컬 Ollama를 사용해주세요.".into())
        }
    }
    fn read_metadata(&mut self) -> Result<AuthMetadata, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| METADATA_ERROR.into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(AuthMetadata::default())
            }
            Err(_) => Err(METADATA_ERROR.into()),
        }
    }
    fn write_metadata(&mut self, metadata: &AuthMetadata) -> Result<(), String> {
        atomic_metadata(&self.path, metadata)
    }
    fn read_secret(
        &mut self,
        provider: CloudProvider,
        reference: &str,
    ) -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::generic_password(password_options(
                provider, reference,
            )) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| VAULT_ERROR.into()),
                Err(error) if error.code() == -25300 => Ok(None),
                Err(_) => Err(VAULT_ERROR.into()),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (provider, reference);
            self.secure_available()?;
            unreachable!()
        }
    }
    fn write_secret(
        &mut self,
        provider: CloudProvider,
        reference: &str,
        secret: &str,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            security_framework::passwords::set_generic_password_options(
                secret.as_bytes(),
                password_options(provider, reference),
            )
            .map_err(|_| VAULT_ERROR.into())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (provider, reference, secret);
            self.secure_available()
        }
    }
    fn delete_secret(&mut self, provider: CloudProvider, reference: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::delete_generic_password_options(password_options(
                provider, reference,
            )) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err(VAULT_ERROR.into()),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (provider, reference);
            self.secure_available()
        }
    }
    fn legacy_secret(&mut self, provider: CloudProvider) -> Result<Option<String>, String> {
        match self.store.get(provider.legacy_key()) {
            Some(Value::String(value)) if !value.is_empty() => return Ok(Some(value)),
            Some(Value::String(_)) | None => {}
            _ => return Err("기존 API 키 설정 형식이 올바르지 않습니다.".into()),
        }
        // A previous cleanup can remove the in-memory source and then fail to
        // flush. Inspect the disk residue rather than re-emitting a plaintext
        // credential through Store::set / store://change to restore memory.
        let bytes = match fs::read(&self.settings_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(METADATA_ERROR.into()),
        };
        let disk: BTreeMap<String, Value> =
            serde_json::from_slice(&bytes).map_err(|_| METADATA_ERROR)?;
        match disk.get(provider.legacy_key()) {
            None => Ok(None),
            Some(Value::String(value)) if value.is_empty() => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            _ => Err("기존 API 키 설정 형식이 올바르지 않습니다.".into()),
        }
    }
    fn remove_legacy(&mut self, provider: CloudProvider, expected: &str) -> Result<(), String> {
        if self.legacy_secret(provider)?.as_deref() != Some(expected) {
            return Err(STALE.into());
        }
        self.store.delete(provider.legacy_key());
        crate::settings_store::persist(&self.app).and_then(|_| {
            let bytes = fs::read(&self.settings_path).map_err(|_| METADATA_ERROR)?;
            let disk: BTreeMap<String, Value> =
                serde_json::from_slice(&bytes).map_err(|_| METADATA_ERROR)?;
            if disk
                .get(provider.legacy_key())
                .is_some_and(|value| value != "")
            {
                return Err(METADATA_ERROR.into());
            }
            Ok(())
        })
    }
}

#[tauri::command]
pub async fn capture_connection(
    app: AppHandle,
    state: State<'_, ConnectionManager>,
) -> Result<NativeSnapshot, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = crate::settings_store::store(&app)?;
        let entries: BTreeMap<String, Value> = store.entries().into_iter().collect();
        let provider_id = setting(&entries, "llmBackendId", "gemini-native")?;
        if provider_id == "ollama" {
            return capture_ollama(&manager, &entries);
        }
        let provider = CloudProvider::parse(&provider_id)?;
        let _guard = manager
            .auth_lock
            .lock()
            .map_err(|_| "보안 인증 작업 잠금 오류입니다.")?;
        // A credential mutation may have completed while this worker waited.
        // Recapture the non-secret settings under the auth lock, rather than
        // combining a pre-rotation model with the newly committed credential.
        let entries: BTreeMap<String, Value> = store.entries().into_iter().collect();
        if setting(&entries, "llmBackendId", "gemini-native")? != provider.id() {
            return Err("준비 중 AI 공급자가 변경되었습니다. 다시 시도해주세요.".into());
        }
        let model = cloud_model(&entries, provider)?;
        let mut env = NativeEnvironment::new(&app, store)?;
        let (_, auth_profile) = migrate_provider(&mut env, provider)?;
        let api_key = match &auth_profile {
            Some(profile) => configured_secret(&mut env, provider, profile)?.unwrap_or_default(),
            None => String::new(),
        };
        manager.capture(
            ConnectionProfile {
                id: format!("legacy:{}", provider.id()),
                provider_id,
                protocol: provider.protocol().into(),
                base_url: provider.endpoint().into(),
                model,
                auth: ProfileAuth {
                    kind: "api-key".into(),
                },
                credential_ref: auth_profile.and_then(|profile| profile.credential_ref),
            },
            api_key,
        )
    })
    .await
    .map_err(|_| "AI 연결 설정 캡처에 실패했습니다.")?
}

#[tauri::command]
pub async fn get_credential_status(
    app: AppHandle,
    state: State<'_, ConnectionManager>,
    provider_id: String,
) -> Result<CredentialStatus, String> {
    if provider_id == "ollama" {
        return Ok(CredentialStatus {
            configured: false,
            revision: None,
            error: None,
        });
    }
    let provider = CloudProvider::parse(&provider_id)?;
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = manager
            .auth_lock
            .lock()
            .map_err(|_| "보안 인증 작업 잠금 오류입니다.")?;
        let store = crate::settings_store::store(&app)?;
        credential_status(&mut NativeEnvironment::new(&app, store)?, provider)
    })
    .await
    .map_err(|_| "보안 인증 상태 확인에 실패했습니다.")?
}

#[tauri::command]
pub async fn save_provider_credential(
    app: AppHandle,
    state: State<'_, ConnectionManager>,
    provider_id: String,
    api_key: String,
    expected_revision: Option<String>,
) -> Result<CredentialStatus, String> {
    let provider = CloudProvider::parse(&provider_id)?;
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = manager
            .auth_lock
            .lock()
            .map_err(|_| "보안 인증 작업 잠금 오류입니다.")?;
        let store = crate::settings_store::store(&app)?;
        save_credential(
            &mut NativeEnvironment::new(&app, store)?,
            provider,
            &api_key,
            expected_revision.as_deref(),
        )
    })
    .await
    .map_err(|_| "보안 인증 저장에 실패했습니다.")?
}

#[tauri::command]
pub async fn delete_provider_credential(
    app: AppHandle,
    state: State<'_, ConnectionManager>,
    provider_id: String,
    expected_revision: Option<String>,
) -> Result<CredentialStatus, String> {
    let provider = CloudProvider::parse(&provider_id)?;
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = manager
            .auth_lock
            .lock()
            .map_err(|_| "보안 인증 작업 잠금 오류입니다.")?;
        let store = crate::settings_store::store(&app)?;
        delete_and_invalidate(
            &mut NativeEnvironment::new(&app, store)?,
            &manager,
            provider,
            expected_revision.as_deref(),
        )
    })
    .await
    .map_err(|_| "보안 인증 삭제에 실패했습니다.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemoryEnvironment {
        metadata: AuthMetadata,
        vault: BTreeMap<(String, String), String>,
        legacy: BTreeMap<String, String>,
        locked: bool,
        metadata_read_fails: bool,
        metadata_write_fails_once: bool,
        metadata_write_fails_after_commit_once: bool,
        metadata_verify_fails_once: bool,
        pending_metadata_verify_failure: bool,
        secret_verify_wrong: bool,
        cleanup_fails: bool,
        delete_fails_after_removal: bool,
        vault_reads: usize,
        vault_writes: usize,
    }
    impl AuthEnvironment for MemoryEnvironment {
        fn secure_available(&self) -> Result<(), String> {
            Ok(())
        }
        fn read_metadata(&mut self) -> Result<AuthMetadata, String> {
            if self.metadata_read_fails {
                return Err(METADATA_ERROR.into());
            }
            if self.pending_metadata_verify_failure {
                self.pending_metadata_verify_failure = false;
                return Err(METADATA_ERROR.into());
            }
            Ok(self.metadata.clone())
        }
        fn write_metadata(&mut self, value: &AuthMetadata) -> Result<(), String> {
            if self.metadata_write_fails_once {
                self.metadata_write_fails_once = false;
                return Err(METADATA_ERROR.into());
            }
            self.metadata = value.clone();
            if self.metadata_write_fails_after_commit_once {
                self.metadata_write_fails_after_commit_once = false;
                return Err(METADATA_ERROR.into());
            }
            if self.metadata_verify_fails_once {
                self.metadata_verify_fails_once = false;
                self.pending_metadata_verify_failure = true;
            }
            Ok(())
        }
        fn read_secret(
            &mut self,
            provider: CloudProvider,
            reference: &str,
        ) -> Result<Option<String>, String> {
            self.vault_reads += 1;
            if self.locked {
                return Err(VAULT_ERROR.into());
            }
            if self.secret_verify_wrong {
                return Ok(Some("not-the-requested-secret".into()));
            }
            Ok(self
                .vault
                .get(&(provider.id().into(), reference.into()))
                .cloned())
        }
        fn write_secret(
            &mut self,
            provider: CloudProvider,
            reference: &str,
            secret: &str,
        ) -> Result<(), String> {
            if self.locked {
                return Err(VAULT_ERROR.into());
            }
            self.vault_writes += 1;
            self.vault
                .insert((provider.id().into(), reference.into()), secret.into());
            Ok(())
        }
        fn delete_secret(
            &mut self,
            provider: CloudProvider,
            reference: &str,
        ) -> Result<(), String> {
            if self.locked {
                return Err(VAULT_ERROR.into());
            }
            self.vault.remove(&(provider.id().into(), reference.into()));
            if self.delete_fails_after_removal {
                return Err(VAULT_ERROR.into());
            }
            Ok(())
        }
        fn legacy_secret(&mut self, provider: CloudProvider) -> Result<Option<String>, String> {
            Ok(self
                .legacy
                .get(provider.id())
                .cloned()
                .filter(|key| !key.is_empty()))
        }
        fn remove_legacy(&mut self, provider: CloudProvider, expected: &str) -> Result<(), String> {
            if self.cleanup_fails {
                return Err(METADATA_ERROR.into());
            }
            if self.legacy.get(provider.id()).map(String::as_str) != Some(expected) {
                return Err(STALE.into());
            }
            self.legacy.remove(provider.id());
            Ok(())
        }
    }
    fn legacy_env() -> MemoryEnvironment {
        let mut env = MemoryEnvironment::default();
        env.legacy
            .insert("gemini-native".into(), "old-test-secret".into());
        env
    }
    fn cloud_profile(reference: Option<String>, model: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: "legacy:gemini-native".into(),
            provider_id: "gemini-native".into(),
            protocol: "gemini-native".into(),
            base_url: CloudProvider::Gemini.endpoint().into(),
            model: model.into(),
            auth: ProfileAuth {
                kind: "api-key".into(),
            },
            credential_ref: reference,
        }
    }

    #[test]
    fn cloud_defaults_only_apply_when_the_saved_model_is_absent() {
        let mut entries = BTreeMap::new();
        assert_eq!(
            cloud_model(&entries, CloudProvider::Gemini).unwrap(),
            "gemini-3.8-flash"
        );
        assert_eq!(
            cloud_model(&entries, CloudProvider::OpenAi).unwrap(),
            "gpt-4o-mini"
        );
        entries.insert("model".into(), Value::String("gemini-2.0-flash".into()));
        assert_eq!(
            cloud_model(&entries, CloudProvider::Gemini).unwrap(),
            "gemini-2.0-flash"
        );
        entries.insert("model".into(), Value::String(" ".into()));
        assert!(cloud_model(&entries, CloudProvider::Gemini).is_err());
        entries.insert("model".into(), Value::Null);
        assert!(cloud_model(&entries, CloudProvider::Gemini).is_err());
    }

    #[test]
    fn migration_verifies_vault_and_metadata_before_removing_plaintext() {
        let mut env = legacy_env();
        let result = credential_status(&mut env, CloudProvider::Gemini).unwrap();
        assert!(result.configured);
        assert!(result.revision.is_some());
        assert!(!env.legacy.contains_key("gemini-native"));
        let profile = env
            .metadata
            .profile(CloudProvider::Gemini)
            .unwrap()
            .unwrap()
            .clone();
        assert!(
            configured_secret(&mut env, CloudProvider::Gemini, &profile)
                .unwrap()
                .as_deref()
                == Some("old-test-secret")
        );
        let json = serde_json::to_string(&env.metadata).unwrap();
        assert!(!json.contains("old-test-secret"));
        assert!(!json.contains("model"));
    }

    #[test]
    fn legacy_cleanup_failure_resumes_without_replacing_the_verified_ref() {
        let mut env = legacy_env();
        env.cleanup_fails = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        let reference = env.metadata.providers["gemini-native"]
            .credential_ref
            .clone();
        assert!(env.legacy.contains_key("gemini-native"));
        env.cleanup_fails = false;
        assert!(
            credential_status(&mut env, CloudProvider::Gemini)
                .unwrap()
                .configured
        );
        assert!(env.metadata.providers["gemini-native"].credential_ref == reference);
        assert_eq!(env.vault_writes, 1);
        assert!(env.legacy.is_empty());
    }

    #[test]
    fn metadata_write_failure_keeps_plaintext_and_only_orphans_a_verified_secret() {
        let mut env = legacy_env();
        env.metadata_write_fails_once = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert!(env.metadata.providers.is_empty());
        assert!(env.legacy.contains_key("gemini-native"));
        assert_eq!(env.vault.len(), 1);
        assert!(
            credential_status(&mut env, CloudProvider::Gemini)
                .unwrap()
                .configured
        );
    }

    #[test]
    fn metadata_commit_then_io_failure_rolls_back_without_losing_legacy_key() {
        let mut env = legacy_env();
        env.metadata_write_fails_after_commit_once = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert!(env.metadata.providers.is_empty());
        assert!(env.legacy.contains_key("gemini-native"));
        assert_eq!(env.vault.len(), 1);
    }

    #[test]
    fn metadata_readback_failure_rolls_back_before_plaintext_cleanup() {
        let mut env = legacy_env();
        env.metadata_verify_fails_once = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert!(env.metadata.providers.is_empty());
        assert!(env.legacy.contains_key("gemini-native"));
    }

    #[test]
    fn vault_readback_mismatch_never_publishes_metadata_or_removes_source() {
        let mut env = legacy_env();
        env.secret_verify_wrong = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert!(env.metadata.providers.is_empty());
        assert!(env.legacy.contains_key("gemini-native"));
    }

    #[test]
    fn locked_vault_does_not_fall_back_to_plaintext() {
        let mut env = legacy_env();
        env.locked = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert!(env.metadata.providers.is_empty());
        assert!(env.legacy.contains_key("gemini-native"));
        assert_eq!(env.vault_writes, 0);
    }

    #[test]
    fn missing_referenced_key_is_an_error_not_unconfigured_status() {
        let mut env = legacy_env();
        credential_status(&mut env, CloudProvider::Gemini).unwrap();
        env.vault.clear();
        let status = credential_status(&mut env, CloudProvider::Gemini).unwrap();
        assert!(status.configured);
        assert!(status.error.as_deref() == Some(MISSING_KEY));
        assert!(migrate_provider(&mut env, CloudProvider::Gemini).is_err());
    }

    #[test]
    fn known_missing_key_can_be_explicitly_repaired_with_the_matching_revision() {
        let mut env = MemoryEnvironment::default();
        let first = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        let old_reference = env.metadata.providers["gemini-native"]
            .credential_ref
            .clone();
        env.vault.clear();
        let broken = credential_status(&mut env, CloudProvider::Gemini).unwrap();
        assert!(broken.revision == first.revision);
        assert!(broken.error.is_some());
        let repaired = save_credential(
            &mut env,
            CloudProvider::Gemini,
            "replacement",
            broken.revision.as_deref(),
        )
        .unwrap();
        assert!(repaired.configured && repaired.error.is_none());
        assert!(env.metadata.providers["gemini-native"].credential_ref != old_reference);
        assert!(credential_status(&mut env, CloudProvider::Gemini)
            .unwrap()
            .error
            .is_none());
    }

    #[test]
    fn known_missing_key_can_be_deleted_without_hiding_a_stale_revision() {
        let mut env = MemoryEnvironment::default();
        let first = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        env.vault.clear();
        assert!(delete_credential(&mut env, CloudProvider::Gemini, None).is_err());
        let deleted =
            delete_credential(&mut env, CloudProvider::Gemini, first.revision.as_deref()).unwrap();
        assert!(!deleted.configured);
        assert!(deleted.revision != first.revision);
    }

    #[test]
    fn explicit_save_repairs_legacy_conflict_without_borrowing_the_plaintext_key() {
        let mut env = MemoryEnvironment::default();
        let first = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        env.legacy
            .insert("gemini-native".into(), "different-source".into());
        let conflict = credential_status(&mut env, CloudProvider::Gemini).unwrap();
        assert!(conflict.error.as_deref() == Some(LEGACY_CONFLICT));
        assert!(conflict.revision == first.revision);
        save_credential(
            &mut env,
            CloudProvider::Gemini,
            "explicit-replacement",
            conflict.revision.as_deref(),
        )
        .unwrap();
        let profile = env.metadata.providers["gemini-native"].clone();
        assert!(
            configured_secret(&mut env, CloudProvider::Gemini, &profile)
                .unwrap()
                .as_deref()
                == Some("explicit-replacement")
        );
        assert!(env.legacy.is_empty());
    }

    #[test]
    fn stale_window_cannot_overwrite_or_delete_a_rotated_credential() {
        let mut env = MemoryEnvironment::default();
        let initial = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        let rotated = save_credential(
            &mut env,
            CloudProvider::Gemini,
            "second",
            initial.revision.as_deref(),
        )
        .unwrap();
        let writes = env.vault_writes;
        assert!(save_credential(
            &mut env,
            CloudProvider::Gemini,
            "third",
            initial.revision.as_deref()
        )
        .is_err());
        assert!(
            delete_credential(&mut env, CloudProvider::Gemini, initial.revision.as_deref())
                .is_err()
        );
        assert_eq!(env.vault_writes, writes);
        assert!(
            credential_status(&mut env, CloudProvider::Gemini)
                .unwrap()
                .revision
                == rotated.revision
        );
    }

    #[test]
    fn deletion_tombstone_blocks_stale_none_and_legacy_resurrection() {
        let mut env = MemoryEnvironment::default();
        let first = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        let deleted =
            delete_credential(&mut env, CloudProvider::Gemini, first.revision.as_deref()).unwrap();
        assert!(!deleted.configured);
        assert!(deleted.revision.is_some());
        env.legacy
            .insert("gemini-native".into(), "stale-plaintext".into());
        env.locked = true;
        let status = credential_status(&mut env, CloudProvider::Gemini).unwrap();
        assert!(!status.configured);
        assert!(status.revision == deleted.revision);
        env.locked = false;
        assert!(save_credential(&mut env, CloudProvider::Gemini, "stale", None).is_err());
    }

    #[test]
    fn delete_failure_restores_metadata_and_original_secret() {
        let mut env = MemoryEnvironment::default();
        let saved = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        let before = env.metadata.clone();
        env.delete_fails_after_removal = true;
        assert!(
            delete_credential(&mut env, CloudProvider::Gemini, saved.revision.as_deref()).is_err()
        );
        assert!(env.metadata == before);
        assert!(
            credential_status(&mut env, CloudProvider::Gemini)
                .unwrap()
                .configured
        );
    }

    #[test]
    fn failed_delete_preserves_existing_runtimes_and_successful_retry_revokes_them() {
        let mut env = MemoryEnvironment::default();
        let saved = save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        let manager = ConnectionManager::default();
        let reference = env.metadata.providers["gemini-native"]
            .credential_ref
            .clone();
        let snapshot = manager
            .capture(cloud_profile(reference, "model"), "first".into())
            .unwrap();
        let local = capture_ollama(&manager, &BTreeMap::new()).unwrap();
        env.delete_fails_after_removal = true;
        assert!(delete_and_invalidate(
            &mut env,
            &manager,
            CloudProvider::Gemini,
            saved.revision.as_deref()
        )
        .is_err());
        assert!(resolve_runtime(&manager, &snapshot.runtime_id, "gemini-native").is_ok());
        env.delete_fails_after_removal = false;
        delete_and_invalidate(
            &mut env,
            &manager,
            CloudProvider::Gemini,
            saved.revision.as_deref(),
        )
        .unwrap();
        assert!(resolve_runtime(&manager, &snapshot.runtime_id, "gemini-native").is_err());
        assert!(resolve_runtime(&manager, &local.runtime_id, "ollama").is_ok());
    }

    #[test]
    fn unconfigured_cloud_runtime_cannot_resolve_into_an_authenticated_request() {
        let manager = ConnectionManager::default();
        let snapshot = manager
            .capture(cloud_profile(None, "model"), String::new())
            .unwrap();
        assert!(
            resolve_runtime(&manager, &snapshot.runtime_id, "gemini-native")
                .err()
                .unwrap()
                .contains("API 키")
        );
    }

    #[test]
    fn provider_migration_does_not_touch_the_inactive_plaintext_key() {
        let mut env = legacy_env();
        env.legacy
            .insert("openai".into(), "inactive-test-secret".into());
        credential_status(&mut env, CloudProvider::Gemini).unwrap();
        assert!(env.legacy.contains_key("openai"));
        assert!(!env.metadata.providers.contains_key("openai"));
        assert_eq!(env.vault.len(), 1);
    }

    #[test]
    fn corrupt_auth_metadata_fails_closed_before_keychain_or_source_changes() {
        let mut env = legacy_env();
        env.metadata_read_fails = true;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert_eq!(env.vault_reads, 0);
        assert_eq!(env.vault_writes, 0);
        assert!(env.legacy.contains_key("gemini-native"));
        env.metadata_read_fails = false;
        env.metadata.version = 99;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
    }

    #[test]
    fn credential_references_cannot_cross_provider_or_endpoint_boundaries() {
        let mut env = MemoryEnvironment::default();
        save_credential(&mut env, CloudProvider::Gemini, "first", None).unwrap();
        let mut profile = env.metadata.providers["gemini-native"].clone();
        profile.base_url = "https://other.invalid/v1".into();
        env.metadata
            .providers
            .insert("gemini-native".into(), profile);
        let reads = env.vault_reads;
        assert!(credential_status(&mut env, CloudProvider::Gemini).is_err());
        assert_eq!(env.vault_reads, reads);
    }

    #[test]
    fn snapshots_are_opaque_stable_immutable_and_exclude_secrets_from_ipc() {
        let manager = ConnectionManager::default();
        let first = manager
            .capture(
                cloud_profile(Some("ref-one".into()), "first-model"),
                "first-secret".into(),
            )
            .unwrap();
        let repeated = manager
            .capture(first.profile.clone(), "first-secret".into())
            .unwrap();
        assert_eq!(first.runtime_id, repeated.runtime_id);
        let second = manager
            .capture(
                cloud_profile(Some("ref-two".into()), "second-model"),
                "second-secret".into(),
            )
            .unwrap();
        assert_ne!(first.runtime_id, second.runtime_id);
        let old = resolve_runtime(&manager, &first.runtime_id, "gemini-native").unwrap();
        assert!(old.model == "first-model" && old.api_key == "first-secret");
        assert!(resolve_runtime(&manager, &second.runtime_id, "openai").is_err());
        let json = serde_json::to_string(&first).unwrap();
        assert!(!json.contains("first-secret"));
        assert!(!first.runtime_id.contains("ref-one"));
    }

    #[test]
    fn runtime_limit_expires_old_ids_and_explicit_delete_invalidates_only_its_provider() {
        let manager = ConnectionManager::default();
        let first = manager
            .capture(cloud_profile(None, "old"), "key".into())
            .unwrap();
        for index in 0..MAX_RUNTIMES {
            manager
                .capture(cloud_profile(None, &format!("model-{index}")), "key".into())
                .unwrap();
        }
        assert!(
            resolve_runtime(&manager, &first.runtime_id, "gemini-native")
                .err()
                .unwrap()
                .contains("만료")
        );
        let local = capture_ollama(&manager, &BTreeMap::new()).unwrap();
        manager.invalidate(CloudProvider::Gemini).unwrap();
        assert!(resolve_runtime(&manager, &local.runtime_id, "ollama").is_ok());
        assert_eq!(manager.sessions.lock().unwrap().len(), 1);
    }

    #[test]
    fn ollama_capture_ignores_cloud_auth_lock_and_bad_inactive_settings() {
        let manager = ConnectionManager::default();
        let _cloud_operation = manager.auth_lock.lock().unwrap();
        let mut entries = BTreeMap::new();
        entries.insert("apiKey".into(), Value::Bool(false));
        entries.insert("openaiApiKey".into(), Value::Null);
        entries.insert(
            "ollamaBaseUrl".into(),
            Value::String("HTTP://192.168.1.4:11434/team///".into()),
        );
        let first = capture_ollama(&manager, &entries).unwrap();
        let second = capture_ollama(&manager, &entries).unwrap();
        assert_eq!(first.runtime_id, second.runtime_id);
        assert_eq!(first.profile.base_url, "http://192.168.1.4:11434/team");
        assert!(first.profile.credential_ref.is_none());
    }

    #[test]
    fn ollama_url_rejects_authority_secrets_queries_and_fragments() {
        for invalid in [
            "file:///tmp/models",
            "http://user:pass@localhost:11434",
            "http://@localhost:11434",
            "http://localhost:11434?",
            "http://localhost:11434#",
            "http://localhost\\evil",
        ] {
            assert!(normalize_ollama_url(invalid).is_err());
        }
        assert_eq!(
            normalize_ollama_url("https://[::1]:11434/team/").unwrap(),
            "https://[::1]:11434/team"
        );
    }
}
