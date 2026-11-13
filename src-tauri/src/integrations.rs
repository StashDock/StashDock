use crate::library::LibraryState;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn safari_extension_id() -> String {
    let config: Value =
        serde_json::from_str(include_str!("../product-links.json")).expect("valid product links");
    config["browserExtensions"]["safari"]["id"]
        .as_str()
        .expect("Safari extension identifier")
        .to_owned()
}
fn pinned_chromium_extension(browser: &str, id: &str) -> bool {
    if !["chrome", "edge"].contains(&browser) || !valid_extension_id(browser, id) {
        return false;
    }
    let config: Value =
        serde_json::from_str(include_str!("../product-links.json")).expect("valid product links");
    config["browserExtensions"][browser]["id"].as_str() == Some(id)
        || config["browserExtensions"][browser]["compatibleIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)))
        || config["browserExtensions"][browser]["legacyIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)))
}
// Only the containing native extension emits this origin. Web-extension
// JavaScript cannot set an Origin header or send messages to another native app.
pub(crate) fn safari_native_origin(origin: &str) -> bool {
    cfg!(target_os = "macos")
        && origin == format!("stashdock-safari-native://{}", safari_extension_id())
}
pub(crate) fn valid_extension_id(browser: &str, id: &str) -> bool {
    if browser == "safari" {
        return id == safari_extension_id();
    }
    if browser == "firefox" {
        let config: Value = serde_json::from_str(include_str!("../product-links.json"))
            .expect("valid product links");
        return config["browserExtensions"]["firefox"]["id"].as_str() == Some(id);
    }
    ["chrome", "edge"].contains(&browser)
        && id.len() == 32
        && id.bytes().all(|v| (b'a'..=b'p').contains(&v))
}
pub(crate) fn browser_registration(
    browser: &str,
    origin: Option<&str>,
    reported: Option<&str>,
) -> Result<Option<String>, String> {
    if !["chrome", "edge", "firefox", "safari"].contains(&browser) {
        return Err("Unsupported browser.".into());
    }
    if browser == "safari" {
        if !origin.is_some_and(safari_native_origin)
            || !reported.is_some_and(|id| valid_extension_id(browser, id))
        {
            return Err("Invalid StashDock Safari extension.".into());
        }
        return Ok(reported.map(str::to_owned));
    }
    if browser == "firefox" {
        if origin.is_some_and(|value| {
            !crate::native_messaging::trusted_origin(value)
                && !value
                    .strip_prefix("moz-extension://")
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        }) || !reported.is_some_and(|id| valid_extension_id(browser, id))
        {
            return Err("Invalid StashDock extension.".into());
        }
        return Ok(reported.map(str::to_owned));
    }
    if origin.is_some_and(|value| !value.starts_with("chrome-extension://")) {
        return Err("Invalid StashDock extension.".into());
    }
    let origin_id = origin.and_then(|value| value.strip_prefix("chrome-extension://"));
    if origin_id.is_some() && reported.is_some() && origin_id != reported {
        return Err("Invalid StashDock extension.".into());
    }
    let id = origin_id.or(reported);
    if id.is_some_and(|id| !valid_extension_id(browser, id)) {
        return Err("Invalid StashDock extension.".into());
    }
    Ok(id.map(str::to_owned))
}

pub fn record(db: &Connection, id: &str, version: &str, path: Option<&str>) -> Result<(), String> {
    record_with_extension(db, id, version, path, None)
}
pub fn record_with_extension(
    db: &Connection,
    id: &str,
    version: &str,
    path: Option<&str>,
    extension_id: Option<&str>,
) -> Result<(), String> {
    if ![
        "desktop", "codex", "dsh", "chrome", "edge", "firefox", "safari",
    ]
    .contains(&id)
        || version.len() > 40
        || version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".+-_".contains(c))
    {
        return Err("Invalid StashDock installation.".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    if extension_id.is_some_and(|extension| !valid_extension_id(id, extension)) {
        return Err("Invalid StashDock extension.".into());
    }
    let mut value = json!({"version":version,"path":path,"seenAt":now,"extensionId":extension_id});
    // Native Messaging attests the extension ID rather than a profile Origin.
    // Retain already authenticated HTTP origins for that same ID on upgrade.
    if extension_id.is_some() {
        let previous = db
            .query_row(
                "SELECT value FROM app_meta WHERE key=?1",
                [format!("installation_{id}_v1")],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(previous) = previous
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .filter(|v| v["extensionId"].as_str() == extension_id)
        {
            if previous["origins"].is_array() {
                value["origins"] = previous["origins"].clone();
            }
        }
    }
    db.execute("INSERT INTO app_meta(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![format!("installation_{id}_v1"), value.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_browser_origin(
    db: &Connection,
    browser: &str,
    version: &str,
    extension_id: &str,
    origin: &str,
) -> Result<(), String> {
    record_browser_origin_with_presence(
        db,
        browser,
        version,
        extension_id,
        origin,
        crate::browser_presence::detected,
    )
}

fn record_browser_origin_with_presence(
    db: &Connection,
    browser: &str,
    version: &str,
    extension_id: &str,
    origin: &str,
    browser_enabled: impl FnOnce(&str, &str) -> bool,
) -> Result<(), String> {
    if version.is_empty()
        || version.len() > 40
        || !version
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".+-_".contains(character))
    {
        return Err("Invalid StashDock installation.".into());
    }
    let registered = browser_registration(browser, Some(origin), Some(extension_id))?
        .ok_or("Invalid StashDock extension.")?;
    if registered != extension_id {
        return Err("Invalid StashDock extension.".into());
    }
    // A pinned browser origin authenticates the request without reading a
    // private profile. Keep current metadata checks for older dev identities
    // and legacy Firefox; presence in Settings is a separate question.
    let native_firefox = browser == "firefox" && crate::native_messaging::trusted_origin(origin);
    if !native_firefox
        && !pinned_chromium_extension(browser, extension_id)
        && !browser_enabled(browser, extension_id)
    {
        return Err("StashDock is not enabled in this browser.".into());
    }
    let previous: Option<String> = db
        .query_row(
            "SELECT value FROM app_meta WHERE key=?1",
            [format!("installation_{browser}_v1")],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let previous = previous.and_then(|value| serde_json::from_str::<Value>(&value).ok());
    let mut origins: Vec<String> = previous
        .filter(|value| value["extensionId"].as_str() == Some(extension_id))
        .and_then(|value| serde_json::from_value(value["origins"].clone()).ok())
        .unwrap_or_default();
    origins.retain(|value| valid_extension_origin(browser, extension_id, value));
    if !origins.iter().any(|value| value == origin) {
        origins.push(origin.to_string());
    }
    if origins.len() > 16 {
        origins.drain(..origins.len() - 16);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let value =
        json!({"version":version,"seenAt":now,"extensionId":extension_id,"origins":origins});
    db.execute(
        "INSERT INTO app_meta(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![format!("installation_{browser}_v1"), value.to_string()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn valid_extension_origin(browser: &str, extension_id: &str, origin: &str) -> bool {
    if !valid_extension_id(browser, extension_id) {
        return false;
    }
    if browser == "safari" {
        return safari_native_origin(origin);
    }
    if browser == "firefox" {
        return crate::native_messaging::trusted_origin(origin)
            || origin
                .strip_prefix("moz-extension://")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
    }
    origin == format!("chrome-extension://{extension_id}")
}

pub fn browser_origin_allowed(db: &Connection, origin: &str) -> bool {
    ["chrome", "edge", "firefox", "safari"]
        .iter()
        .any(|browser| {
            let raw: Option<String> = db
                .query_row(
                    "SELECT value FROM app_meta WHERE key=?1",
                    [format!("installation_{browser}_v1")],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten();
            let Some(value) = raw.and_then(|value| serde_json::from_str::<Value>(&value).ok())
            else {
                return false;
            };
            let Some(extension_id) = value["extensionId"].as_str() else {
                return false;
            };
            valid_extension_origin(browser, extension_id, origin)
                && value["origins"].as_array().is_some_and(|origins| {
                    origins.iter().any(|value| value.as_str() == Some(origin))
                })
        })
}
fn dsh_plugin_detected(manifest: &std::path::Path) -> bool {
    fn package(path: &std::path::Path) -> Option<Value> {
        if std::fs::metadata(path).ok()?.len() > 2_000_000 {
            return None;
        }
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }
    if !manifest.is_absolute()
        || !manifest.is_file()
        || package(manifest).is_none_or(|value| value["name"].as_str() != Some("stashdock-dsh"))
        || !manifest
            .parent()
            .is_some_and(|parent| parent.join("index.mjs").is_file())
    {
        return false;
    }
    manifest
        .ancestors()
        .skip(2)
        .take(12)
        .find_map(|directory| {
            let value = package(&directory.join("package.json"))?;
            let profile = value.get("dsh")?.get("profile")?;
            Some(profile["bundles"].as_array().is_some_and(|bundles| {
                bundles
                    .iter()
                    .any(|item| item.as_str() == Some("stashdock-dsh"))
            }))
        })
        .unwrap_or(false)
}
pub fn read(db: &Connection) -> Result<Value, String> {
    let config: Value =
        serde_json::from_str(include_str!("../product-links.json")).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for id in [
        "chrome", "edge", "firefox", "safari", "codex", "dsh", "claude", "desktop",
    ] {
        // SafariServices owns current enablement. A first-time installation
        // need not have saved a page or registered a provider handshake yet.
        if id == "safari" {
            items.push(json!({"id":id,"detected":crate::browser_presence::detected(id, &safari_extension_id())}));
            continue;
        }
        let raw: Option<String> = db
            .query_row(
                "SELECT value FROM app_meta WHERE key=?1",
                [format!("installation_{id}_v1")],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let value = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let mut detected = value.as_ref().is_some_and(|v| {
            v["version"].is_string()
                && if let Some(path) = v["path"].as_str() {
                    std::path::Path::new(path).is_absolute()
                        && std::path::Path::new(path).is_file()
                        && (id != "codex"
                            || crate::codex_presence::detected(std::path::Path::new(path)))
                        && (id != "dsh" || dsh_plugin_detected(std::path::Path::new(path)))
                } else {
                    crate::browser_presence::detected(
                        id,
                        v["extensionId"].as_str().unwrap_or_default(),
                    )
                }
        });
        if id == "chrome" && !detected {
            let edge: Option<String> = db
                .query_row(
                    "SELECT value FROM app_meta WHERE key='installation_edge_v1'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let edge = edge.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
            detected = edge.is_some_and(|record| {
                record["version"].is_string()
                    && record["extensionId"] == config["browserExtensions"]["chrome"]["id"]
                    && crate::browser_presence::detected(
                        "edge",
                        record["extensionId"].as_str().unwrap_or_default(),
                    )
            });
        }
        items.push(json!({"id":id,"detected":detected}));
    }
    let mut links = config["installationUrls"].clone();
    if cfg!(target_os = "macos") {
        if let Some(overrides) = config["macInstallationUrls"].as_object() {
            for (id, url) in overrides {
                links[id] = url.clone();
            }
        }
    }
    Ok(
        json!({"items":items,"platform":std::env::consts::OS,"links":links,"githubUrl":crate::settings::github_repository().map(|repo|format!("https://github.com/{repo}"))}),
    )
}
#[tauri::command]
pub async fn get_integration_status(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let library = app.state::<LibraryState>();
        let db = library
            .connection
            .lock()
            .map_err(|_| "The library is busy.")?;
        read(&db)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dsh_presence_requires_the_registered_package_and_profile_bundle() {
        let root =
            std::env::temp_dir().join(format!("stashdock-dsh-presence-{}", uuid::Uuid::new_v4()));
        let directory = root.join("node_modules/stashdock-dsh");
        std::fs::create_dir_all(&directory).unwrap();
        let manifest = directory.join("package.json");
        std::fs::write(&manifest, r#"{"name":"stashdock-dsh","version":"1.1.0"}"#).unwrap();
        std::fs::write(directory.join("index.mjs"), "export {};").unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["stashdock-dsh"]}}}"#,
        )
        .unwrap();
        assert!(dsh_plugin_detected(&manifest));
        std::fs::write(
            root.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":[]}}}"#,
        )
        .unwrap();
        assert!(!dsh_plugin_detected(&manifest));
        std::fs::write(
            root.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["stashdock-dsh"]}}}"#,
        )
        .unwrap();
        std::fs::remove_file(directory.join("index.mjs")).unwrap();
        assert!(!dsh_plugin_detected(&manifest));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pinned_origins_register_without_reading_private_profiles() {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let config: Value = serde_json::from_str(include_str!("../product-links.json")).unwrap();
        for browser in ["chrome", "edge"] {
            let id = config["browserExtensions"][browser]["id"].as_str().unwrap();
            let origin = format!("chrome-extension://{id}");
            record_browser_origin_with_presence(&db, browser, "0.4.17", id, &origin, |_, _| {
                panic!("pinned registration must not read a browser profile")
            })
            .unwrap();
            assert!(browser_origin_allowed(&db, &origin));
            assert!(record_browser_origin_with_presence(
                &db,
                browser,
                "0.4.17",
                id,
                "https://example.org",
                |_, _| true
            )
            .is_err());
            let other = if browser == "edge" { "chrome" } else { "edge" };
            // Store IDs are distinct; only an explicitly shared upgrade ID may
            // be pinned for both browsers.
            if !pinned_chromium_extension(other, id) {
                assert!(record_browser_origin_with_presence(
                    &db,
                    other,
                    "0.4.21",
                    id,
                    &origin,
                    |_, _| false
                )
                .is_err());
            }
            for legacy in config["browserExtensions"][browser]["legacyIds"]
                .as_array()
                .unwrap()
            {
                let id = legacy.as_str().unwrap();
                let origin = format!("chrome-extension://{id}");
                record_browser_origin_with_presence(&db, browser, "0.4.19", id, &origin, |_, _| {
                    panic!("legacy pinned identity must not read a browser profile")
                })
                .unwrap();
                assert!(browser_origin_allowed(&db, &origin));
                if !pinned_chromium_extension(other, id) {
                    assert!(record_browser_origin_with_presence(
                        &db,
                        other,
                        "0.4.19",
                        id,
                        &origin,
                        |_, _| false
                    )
                    .is_err());
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn safari_requires_the_containing_native_extension_and_enabled_installation() {
        let id = safari_extension_id();
        let origin = format!("stashdock-safari-native://{id}");
        assert_eq!(
            browser_registration("safari", Some(&origin), Some(&id)).unwrap(),
            Some(id.clone())
        );
        for invalid in [
            "https://example.com",
            "safari-web-extension://00000000-0000-0000-0000-000000000000",
            "stashdock-safari-native://another.Extension",
        ] {
            assert!(browser_registration("safari", Some(invalid), Some(&id)).is_err());
        }
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);")
            .unwrap();
        assert!(record_browser_origin_with_presence(
            &db,
            "safari",
            "0.4.13",
            &id,
            &origin,
            |_, _| false
        )
        .is_err());
        assert!(!browser_origin_allowed(&db, &origin));
        record_browser_origin_with_presence(
            &db,
            "safari",
            "0.4.13",
            &id,
            &origin,
            |browser, extension| browser == "safari" && extension == id,
        )
        .unwrap();
        assert!(browser_origin_allowed(&db, &origin));
        assert!(!browser_origin_allowed(
            &db,
            "safari-web-extension://00000000-0000-0000-0000-000000000000"
        ));
    }
    #[test]
    fn native_registration_preserves_http_origins_only_for_the_same_extension_id() {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let id = "a".repeat(32);
        let origin = format!("chrome-extension://{id}");
        record_browser_origin_with_presence(&db, "chrome", "0.4.16", &id, &origin, |_, _| true)
            .unwrap();
        record_with_extension(&db, "chrome", "0.4.17", None, Some(&id)).unwrap();
        assert!(browser_origin_allowed(&db, &origin));
        record_with_extension(&db, "chrome", "0.4.17", None, Some(&"b".repeat(32))).unwrap();
        assert!(!browser_origin_allowed(&db, &origin));
    }
    #[test]
    fn firefox_runtime_identity_is_not_its_origin_uuid() {
        let config: Value = serde_json::from_str(include_str!("../product-links.json")).unwrap();
        let id = config["browserExtensions"]["firefox"]["id"]
            .as_str()
            .unwrap();
        let origin = "moz-extension://e9aefaf5-6844-473b-a647-9455e6346978";
        assert_eq!(
            browser_registration("firefox", Some(origin), Some(id)).unwrap(),
            Some(id.to_owned())
        );
        assert!(browser_registration("firefox", Some(origin), Some("other@addon")).is_err());
        assert!(browser_registration("edge", Some(origin), Some(id)).is_err());
        assert!(valid_extension_id("firefox", id));
        assert!(!valid_extension_id("chrome", id));
    }
    #[test]
    fn firefox_native_connection_does_not_read_profiles_or_imply_presence() {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let id = crate::native_messaging::extension_id();
        let origin = crate::native_messaging::origin();
        record_browser_origin_with_presence(&db, "firefox", "0.4.19", &id, &origin, |_, _| {
            panic!("native connection cannot inspect profiles")
        })
        .unwrap();
        assert!(browser_origin_allowed(&db, &origin));
        for (id, origin) in [
            ("other@addon".to_owned(), origin.clone()),
            (id.clone(), format!("{origin}-other")),
            (id.clone(), "https://example.org".into()),
        ] {
            assert!(record_browser_origin_with_presence(
                &db,
                "firefox",
                "0.4.19",
                &id,
                &origin,
                |_, _| false
            )
            .is_err());
        }
    }
    #[test]
    fn only_own_confirmed_browser_handshakes_are_detected() {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        record(&db, "chrome", "0.4.9", None).unwrap();
        assert!(record(&db, "arbitrary", "1", None).is_err());
        assert!(record(&db, "chrome", "bad version", None).is_err());
        let status = read(&db).unwrap();
        assert_eq!(
            status["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == "chrome")
                .unwrap()["detected"],
            false
        );
        assert_eq!(
            status["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == "codex")
                .unwrap()["detected"],
            false
        );
    }

    #[test]
    fn browser_data_access_is_bound_to_registered_origins() {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let chrome = "a".repeat(32);
        let chrome_origin = format!("chrome-extension://{chrome}");
        record_browser_origin_with_presence(
            &db,
            "chrome",
            "0.4.13",
            &chrome,
            &chrome_origin,
            |_, _| true,
        )
        .unwrap();
        assert!(browser_origin_allowed(&db, &chrome_origin));
        assert!(!browser_origin_allowed(
            &db,
            &format!("chrome-extension://{}", "b".repeat(32))
        ));
        let firefox = "stashdock@stashdock.app";
        let first = "moz-extension://e9aefaf5-6844-473b-a647-9455e6346978";
        let second = "moz-extension://a9aefaf5-6844-473b-a647-9455e6346978";
        record_browser_origin_with_presence(&db, "firefox", "0.4.13", firefox, first, |_, _| true)
            .unwrap();
        record_browser_origin_with_presence(&db, "firefox", "0.4.13", firefox, second, |_, _| true)
            .unwrap();
        assert!(browser_origin_allowed(&db, first));
        assert!(browser_origin_allowed(&db, second));
    }

    #[test]
    fn browser_registration_requires_current_enablement() {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let id = "a".repeat(32);
        let origin = format!("chrome-extension://{id}");
        assert!(record_browser_origin_with_presence(
            &db,
            "chrome",
            "0.4.13",
            &id,
            &origin,
            |_, _| false,
        )
        .is_err());
        assert!(!browser_origin_allowed(&db, &origin));
    }
}
