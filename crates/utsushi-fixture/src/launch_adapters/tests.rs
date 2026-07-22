use super::*;
use std::io::Write;
use std::sync::{
    Mutex, MutexGuard,
    atomic::{AtomicU64, Ordering},
};

static TEST_TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);
static BROWSER_PROBE_ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_browser_probe_env() -> MutexGuard<'static, ()> {
    BROWSER_PROBE_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn supported_test_chromium_version() -> super::browser_detection::ChromiumVersion {
    super::browser_detection::ChromiumVersion::Parsed {
        major: 124,
        minor: 0,
        patch: 6367,
    }
}

#[cfg(unix)]
fn fake_browser_adapter(fake_browser: PathBuf) -> BrowserLaunchAdapter {
    BrowserLaunchAdapter::with_browser_program_and_version(
        fake_browser,
        supported_test_chromium_version(),
    )
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = TEST_TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = env::temp_dir().join(format!(
        "utsushi-launch-adapter-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_browser_smoke_fixture(root: &Path) {
    fs::write(
        root.join("source.json"),
        r#"{
  "gameId": "browser-smoke-fixture",
  "title": "Browser Smoke Fixture",
  "sourceLocale": "ja-JP",
  "units": [
{
  "sourceUnitKey": "browser.smoke.001",
  "speaker": "Narrator",
  "textSurface": "dialogue",
  "sourceText": "ブラウザ起動確認。",
  "targetText": "Browser launch confirmed.",
  "protectedSpans": []
}
  ]
}
"#,
    )
    .unwrap();
    fs::write(
        root.join("index.html"),
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Utsushi Browser Smoke</title></head><body><main>Browser launch confirmed.</main></body></html>\n",
    )
    .unwrap();
}

#[cfg(unix)]
fn fake_browser(root: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = root.join("fake-browser.sh");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(body.as_bytes()).unwrap();
    let mut permissions = file.metadata().unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

#[cfg(unix)]
fn shell_quote_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[path = "tests_descriptor_and_capture.rs"]
mod descriptor_and_capture;

#[path = "tests_availability_and_policy.rs"]
mod availability_and_policy;

#[path = "tests_display_and_observation.rs"]
mod display_and_observation;
