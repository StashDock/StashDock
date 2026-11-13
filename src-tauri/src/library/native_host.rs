//! Native Messaging uses the same canonical library and capture transactions.
//! Each browser request owns one bounded process; no listener or login service.
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const LIMIT: usize = 1_000_000;
const HOST_PREFIX: &str = "app.stashdock";

fn default_root() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base =
        std::env::var_os("HOME").map(|v| PathBuf::from(v).join("Library/Application Support"));
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|v| PathBuf::from(v).join(".local/share")));
    base.map(|v| v.join("app.stashdock.desktop"))
        .ok_or("The application-data folder is unavailable.".into())
}
fn location() -> Result<(crate::library_location::Registration, PathBuf, PathBuf), String> {
    let root = default_root()?;
    let registry = root.join("library-root-v1.json");
    let preferred = std::env::var_os("STASHDOCK_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(root);
    let registration = crate::library_location::locate(&preferred, &registry)?;
    let current = crate::library_location::resolve(&registration.anchor)?;
    Ok((registration, registry, current))
}
fn firefox_id() -> String {
    let links: Value =
        serde_json::from_str(include_str!("../../product-links.json")).expect("product links");
    links["browserExtensions"]["firefox"]["id"]
        .as_str()
        .expect("Firefox ID")
        .into()
}
fn allowed_chromium_ids() -> Vec<String> {
    // Exact packaged identity, independent of application startup, profile
    // scanning and library availability. No wildcard or caller-supplied ID.
    let links: Value =
        serde_json::from_str(include_str!("../../product-links.json")).expect("product links");
    let mut ids = Vec::new();
    for browser in ["chrome", "edge"] {
        let identity = &links["browserExtensions"][browser];
        let current = identity["id"].as_str().expect("Chromium extension ID");
        let legacy = identity["legacyIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        for id in std::iter::once(current).chain(legacy) {
            if id.len() == 32
                && id.bytes().all(|v| (b'a'..=b'p').contains(&v))
                && !ids.iter().any(|v| v == id)
            {
                ids.push(id.into());
            }
        }
    }
    ids
}
fn caller(args: &[String], allowed: &[String]) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if args.len() == 2 && args[0] == "--safari-extension" {
        let links: Value =
            serde_json::from_str(include_str!("../../product-links.json")).expect("product links");
        if links["browserExtensions"]["safari"]["id"].as_str() == Some(args[1].as_str()) {
            return Ok(args[1].clone());
        }
        return Err("This Safari extension is not authorized.".into());
    }
    let firefox = firefox_id();
    if args.get(1) == Some(&firefox) {
        return Ok(firefox);
    }
    let id = args
        .first()
        .and_then(|v| v.strip_prefix("chrome-extension://"))
        .and_then(|v| v.strip_suffix('/'))
        .ok_or("A registered browser extension is required.")?;
    if allowed.iter().any(|v| v == id) {
        Ok(id.into())
    } else {
        Err("This extension is not authorized.".into())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    path: String,
    #[serde(default)]
    body: Option<String>,
}

fn dispatch(request: Request, caller: &str) -> Result<Value, String> {
    if !["/health", "/setup", "/tags", "/capture/lookup", "/capture"]
        .contains(&request.path.as_str())
    {
        return Err("Unsupported browser operation.".into());
    }
    let (registration, registry, root) = location()?;
    fs::create_dir_all(root.join("assets")).map_err(|e| e.to_string())?;
    let mut db = Connection::open(root.join("stashdock.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    super::initialize_schema(&db).map_err(|e| e.to_string())?;
    crate::library_location::mark_ready(registration, &registry)?;
    let body = request.body.as_deref().unwrap_or("{}");
    match request.path.as_str() {
        "/health" => Ok(json!({"ok":true,"name":"StashDock","apiVersion":1})),
        "/setup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Setup {
                browser: String,
                version: String,
                extension_id: String,
            }
            let input: Setup = serde_json::from_str(body).map_err(|_| "Invalid setup request.")?;
            if input.extension_id != caller
                || !crate::integrations::valid_extension_id(&input.browser, caller)
                || (input.browser == "firefox") != (caller == firefox_id())
            {
                return Err("Invalid StashDock extension.".into());
            }
            crate::integrations::record_with_extension(
                &db,
                &input.browser,
                &input.version,
                None,
                Some(caller),
            )?;
            Ok(json!({"connected":true,"owner":"native","integrations":{"items":[]}}))
        }
        "/tags" => super::browser_capture::tags(&db),
        "/capture/lookup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Lookup {
                url: String,
                operation_id: Option<String>,
                digest: Option<String>,
            }
            let input: Lookup =
                serde_json::from_str(body).map_err(|_| "Invalid lookup request.")?;
            if body.len() > 16384 || input.url.len() > 8000 {
                return Err("Invalid lookup request.".into());
            }
            super::browser_capture::lookup(
                &db,
                &input.url,
                input.operation_id.as_deref(),
                input.digest.as_deref(),
            )
        }
        "/capture" => super::browser_capture::save(&mut db, body),
        _ => unreachable!(),
    }
}
fn read_message(input: &mut impl Read) -> Result<Request, String> {
    let mut size = [0u8; 4];
    input
        .read_exact(&mut size)
        .map_err(|_| "The browser request could not be read.")?;
    let size = u32::from_ne_bytes(size) as usize;
    if size == 0 || size > LIMIT {
        return Err("The browser request is too large.".into());
    }
    let mut bytes = vec![0u8; size];
    input
        .read_exact(&mut bytes)
        .map_err(|_| "The browser request is incomplete.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid browser request.".into())
}
fn respond(value: Value, output: &mut impl Write) -> Result<(), String> {
    let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err("The browser response is too large.".into());
    }
    output
        .write_all(&(bytes.len() as u32).to_ne_bytes())
        .and_then(|_| output.write_all(&bytes))
        .and_then(|_| output.flush())
        .map_err(|e| e.to_string())
}

pub(super) fn manifest(path: &Path, provider: &str, firefox: bool) -> Value {
    let mut value = json!({"name":format!("{HOST_PREFIX}.{provider}"),"description":"StashDock local page saver","path":path,"type":"stdio"});
    if firefox {
        value["allowed_extensions"] = json!([firefox_id()]);
    } else {
        value["allowed_origins"] = json!(allowed_chromium_ids()
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect::<Vec<_>>());
    }
    value
}
#[cfg(any(windows, target_os = "macos", test))]
pub(super) fn has_usable_registration(path: &Path, provider: &str, firefox: bool) -> bool {
    let Some(value) = fs::File::open(path).ok().and_then(|file| {
        let mut bytes = Vec::new();
        file.take(65_537).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 65_536 {
            return None;
        }
        serde_json::from_slice::<Value>(&bytes).ok()
    }) else {
        return false;
    };
    let Some(executable) = value["path"].as_str().map(Path::new) else {
        return false;
    };
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        if !fs::metadata(executable).is_ok_and(|entry| entry.permissions().mode() & 0o111 != 0) {
            return false;
        }
    }
    let allowed = if firefox {
        "allowed_extensions"
    } else {
        "allowed_origins"
    };
    let expected = manifest(executable, provider, firefox);
    executable.is_absolute()
        && executable.is_file()
        && value["name"] == expected["name"]
        && value["type"] == expected["type"]
        && value[allowed].as_array().is_some_and(|current| {
            expected[allowed]
                .as_array()
                .is_some_and(|required| required.iter().all(|identity| current.contains(identity)))
        })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Registration {
    Replace,
    Ensure,
    Remove,
}

pub(super) fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if fs::read(path).ok().as_deref() == Some(&bytes) {
        return Ok(());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    let result = fs::rename(&temporary, path).map_err(|e| e.to_string());
    let _ = fs::remove_file(temporary);
    result
}
#[cfg(windows)]
fn physical_path(path: &Path) -> Result<PathBuf, String> {
    // MSIX can redirect AppData even when the child has no package identity.
    // Registration is consumed outside that context, so publish the actual file.
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    Ok(PathBuf::from(crate::library_location::display_path(&path)))
}
#[cfg(windows)]
fn registry_manifest(key: &str) -> Result<Option<PathBuf>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Registry::*;
    let key = key.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut bytes = 0;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            std::ptr::null(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if status == 2 {
        return Ok(None);
    }
    if status != 0 || bytes == 0 || bytes > 65536 || bytes % 2 != 0 {
        return Err(format!(
            "Browser host registration could not be read ({status})."
        ));
    }
    let mut value = vec![0u16; bytes as usize / 2];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            std::ptr::null(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            value.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != 0 {
        return Err(format!(
            "Browser host registration could not be read ({status})."
        ));
    }
    value.truncate(bytes as usize / 2);
    while value.last() == Some(&0) {
        value.pop();
    }
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(&value))))
}
#[cfg(windows)]
fn registry_set(key: &str, value: Option<&Path>) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::*;
    let wide = |v: &str| v.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let name = wide(key);
    unsafe {
        if let Some(path) = value {
            let mut handle = std::ptr::null_mut();
            let result = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                name.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            );
            if result != 0 {
                return Err(format!("Browser host registration failed ({result})."));
            }
            let data = wide(&path.to_string_lossy());
            let result = RegSetValueExW(
                handle,
                std::ptr::null(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            );
            RegCloseKey(handle);
            if result != 0 {
                return Err(format!("Browser host registration failed ({result})."));
            }
        } else {
            let result = RegDeleteKeyW(HKEY_CURRENT_USER, name.as_ptr());
            if result != 0 && result != 2 {
                return Err(format!("Browser host removal failed ({result})."));
            }
        }
    }
    Ok(())
}
#[cfg(windows)]
fn registry_remove_owned(key: &str, expected: &Path) -> Result<(), String> {
    if registry_manifest(key)?.as_deref() == Some(expected) {
        registry_set(key, None)?;
    }
    Ok(())
}
pub(crate) fn register(
    provider: &str,
    executable: &Path,
    mode: Registration,
) -> Result<(), String> {
    if !["desktop", "plugin"].contains(&provider)
        || !executable.is_absolute()
        || !executable.is_file()
    {
        return Err("Invalid browser host installation.".into());
    }
    if std::env::var("STASHDOCK_NATIVE_HOST_REGISTRATION").as_deref() == Ok("off") {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        return super::native_install::register(provider, executable, mode);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = mode;
        Err("Native host installation must be integrated and verified on this platform.".into())
    }
    #[cfg(windows)]
    {
        let executable = physical_path(executable)?;
        // Each installation owns its manifests beside its helper. AppData from
        // an AI host may be private/redirected and must not own Desktop's files.
        let root = executable
            .parent()
            .ok_or("Invalid browser host installation.")?
            .join("browser-hosts");
        let remove = mode == Registration::Remove;
        if !remove {
            fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        }
        for browser in ["chrome", "edge", "firefox"] {
            let file = root.join(format!("{provider}.{browser}.json"));
            let vendor = match browser {
                "chrome" => "Google\\Chrome",
                "edge" => "Microsoft\\Edge",
                _ => "Mozilla",
            };
            let key = format!("Software\\{vendor}\\NativeMessagingHosts\\{HOST_PREFIX}.{provider}");
            if mode == Registration::Ensure
                && registry_manifest(&key)
                    .ok()
                    .flatten()
                    .is_some_and(|existing| {
                        has_usable_registration(&existing, provider, browser == "firefox")
                    })
            {
                continue;
            }
            if remove {
                // An older uninstaller must not remove a newer installation.
                let ours = fs::read(&file)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .is_some_and(|v| v["path"].as_str() == executable.to_str());
                if ours {
                    // A previous installation may still own its old files,
                    // but it must not delete a newer installation's registry.
                    registry_remove_owned(&key, &physical_path(&file)?)?;
                    fs::remove_file(&file).map_err(|e| e.to_string())?;
                }
            } else {
                atomic_json(
                    &file,
                    &manifest(&executable, provider, browser == "firefox"),
                )?;
                registry_set(&key, Some(&physical_path(&file)?))?;
            }
        }
        if remove {
            let _ = fs::remove_dir(root);
        }
        Ok(())
    }
}
pub(crate) fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let [operation, provider] = args.as_slice() {
        let mode = match operation.as_str() {
            "--register" => Some(Registration::Replace),
            "--ensure" => Some(Registration::Ensure),
            "--unregister" => Some(Registration::Remove),
            _ => None,
        };
        if let Some(mode) = mode {
            return register(
                provider,
                &std::env::current_exe().map_err(|e| e.to_string())?,
                mode,
            );
        }
    }
    // Bounds an interrupted pipe, blocked disk and database work without a
    // permanently resident process. SQLite transactions remain atomic on exit.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(12));
        std::process::exit(1);
    });
    let caller = caller(&args, &allowed_chromium_ids())?;
    let result =
        read_message(&mut std::io::stdin().lock()).and_then(|request| dispatch(request, &caller));
    respond(
        match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        },
        &mut std::io::stdout().lock(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn uninstall_cannot_remove_another_installations_registration() {
        struct TestKey(String);
        impl Drop for TestKey {
            fn drop(&mut self) {
                let _ = registry_set(&self.0, None);
            }
        }
        // Isolated test key, never an installed browser's NativeMessagingHosts.
        let key = TestKey(format!(
            "Software\\StashDock\\NativeHostTests\\{}",
            uuid::Uuid::new_v4()
        ));
        let old = Path::new(r"C:\StashDock old\browser-hosts\plugin.chrome.json");
        let new = Path::new(r"C:\StashDock new\browser-hosts\plugin.chrome.json");
        assert!(registry_manifest(&key.0).unwrap().is_none());
        registry_set(&key.0, Some(new)).unwrap();
        registry_remove_owned(&key.0, old).unwrap();
        assert_eq!(registry_manifest(&key.0).unwrap().as_deref(), Some(new));
        registry_remove_owned(&key.0, new).unwrap();
        assert!(registry_manifest(&key.0).unwrap().is_none());
    }
    #[test]
    fn strict_frames_and_authorized_callers_only() {
        assert!(read_message(&mut &0u32.to_ne_bytes()[..]).is_err());
        assert!(read_message(&mut &((LIMIT + 1) as u32).to_ne_bytes()[..]).is_err());
        assert!(read_message(&mut &[12, 0, 0, 0, b'{'][..]).is_err());
        let allowed = allowed_chromium_ids();
        assert!(caller(&["https://example.org/".into()], &allowed).is_err());
        assert!(caller(
            &[format!("chrome-extension://{}/", "a".repeat(32))],
            &allowed
        )
        .is_err());
        for id in &allowed {
            assert_eq!(
                caller(&[format!("chrome-extension://{id}/")], &allowed).unwrap(),
                *id
            );
        }
        assert_eq!(
            caller(&["manifest.json".into(), firefox_id()], &allowed).unwrap(),
            firefox_id()
        );
        let mut bytes = Vec::new();
        respond(json!({"ok":true}), &mut bytes).unwrap();
        assert_eq!(
            u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
    }

    #[test]
    fn both_store_identities_are_authorized_by_each_provider() {
        let ids = allowed_chromium_ids();
        assert_eq!(
            ids.iter().collect::<std::collections::HashSet<_>>().len(),
            ids.len()
        );
        for provider in ["desktop", "plugin"] {
            let value = manifest(Path::new("stashdock-browser"), provider, false);
            let origins = value["allowed_origins"].as_array().unwrap();
            for id in [
                "bbglcpbhnobjhgccjinejnnlcefelkee",
                "fgipdcmmnimccgdepghiecnngnakoeok",
            ] {
                assert!(ids.iter().any(|candidate| candidate == id));
                assert!(origins.contains(&json!(format!("chrome-extension://{id}/"))));
            }
            assert_eq!(origins.len(), ids.len());
        }
    }

    #[test]
    fn ensure_recognizes_a_valid_provider_and_rejects_missing_or_stale_manifests() {
        let root = std::env::temp_dir().join(format!("stashdock-ensure-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("plugin.chrome.json");
        let helper = std::env::current_exe().unwrap();
        assert!(!has_usable_registration(&path, "plugin", false));
        let mut data = manifest(&helper, "plugin", false);
        atomic_json(&path, &data).unwrap();
        assert!(has_usable_registration(&path, "plugin", false));
        assert!(!has_usable_registration(&path, "desktop", false));
        data["path"] = json!(root.join("missing-helper"));
        atomic_json(&path, &data).unwrap();
        assert!(!has_usable_registration(&path, "plugin", false));
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
