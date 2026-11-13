use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
#[cfg(not(target_os = "macos"))]
use std::path::Path;

fn configuration() -> Value {
    serde_json::from_str(include_str!("../product-links.json")).expect("valid product links")
}

pub(crate) fn registered_desktop(db: &Connection) -> Option<String> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM app_meta WHERE key='installation_desktop_v1'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()?;
    let value: Value = serde_json::from_str(raw.as_deref()?).ok()?;
    let path = value["path"].as_str()?;
    #[cfg(target_os = "macos")]
    {
        crate::macos_services::desktop_bundle(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        (Path::new(path).is_absolute()
            && Path::new(path).is_file()
            && Path::new(path)
                .file_name()?
                .to_str()?
                .eq_ignore_ascii_case("stashdock.exe"))
        .then(|| path.to_owned())
    }
}

#[cfg(windows)]
fn registry_value(key: &str, name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::*;
    let key: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut buffer = [0u16; 4096];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    let status = if status == 0 {
        status
    } else {
        bytes = std::mem::size_of_val(&buffer) as u32;
        unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        }
    };
    (status == 0).then(|| {
        String::from_utf16_lossy(
            &buffer[..buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len())],
        )
    })
}
#[cfg(windows)]
fn registered_protocol(scheme: &str) -> bool {
    use windows_sys::Win32::System::Registry::*;
    let key: Vec<u16> = format!("{scheme}\\shell\\open\\command")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut handle = std::ptr::null_mut();
    let found =
        unsafe { RegOpenKeyExW(HKEY_CLASSES_ROOT, key.as_ptr(), 0, KEY_READ, &mut handle) } == 0;
    if found {
        unsafe {
            RegCloseKey(handle);
        }
    }
    found
}
fn fallback(config: &Value, id: &str) -> Option<String> {
    config["applications"][id]["website"]
        .as_str()
        .or_else(|| config["installationUrls"][id].as_str())
        .map(str::to_owned)
        .or_else(|| {
            (id == "desktop")
                .then(crate::settings::github_repository)
                .flatten()
                .map(|repo| format!("https://github.com/{repo}"))
        })
}
pub(crate) fn target_with(
    config: &Value,
    id: &str,
    desktop: Option<String>,
    protocol: impl Fn(&str) -> bool,
    browser_executable: Option<String>,
) -> Result<(String, Option<String>), String> {
    let app = config["applications"]
        .get(id)
        .ok_or("Choose a supported StashDock app.")?;
    let website = fallback(config, id);
    if id == "desktop" {
        if let Some(path) = desktop {
            return Ok((path, website));
        }
    }
    if let Some(schemes) = app["protocols"].as_array() {
        for scheme in schemes.iter().filter_map(Value::as_str) {
            if protocol(scheme) {
                return Ok((
                    app["launchUrl"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{scheme}://")),
                    website,
                ));
            }
        }
    }
    if app["executable"].is_string() {
        if let Some(path) = browser_executable {
            return Ok((path, website));
        }
    }
    website
        .map(|url| (url, None))
        .ok_or("The StashDock Desktop download link is not available yet.".into())
}
#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let target: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err("The app could not be opened. Try again.".into())
    }
}
#[cfg(target_os = "macos")]
fn shell_open(target: &str) -> Result<(), String> {
    crate::macos_services::open(target)
}
#[cfg(not(any(windows, target_os = "macos")))]
fn shell_open(target: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|_| "The app could not be opened. Try again.".into())
}
pub(crate) fn launch(id: &str, desktop: Option<String>) -> Result<(), String> {
    let config = configuration();
    #[cfg(windows)]
    let browser_name = config["applications"][id]["executable"]
        .as_str()
        .unwrap_or_default();
    #[cfg(windows)]
    let browser_executable = (!browser_name.is_empty())
        .then(|| {
            registry_value(
                &format!("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{browser_name}"),
                "",
            )
        })
        .flatten()
        .map(|v| v.trim_matches('"').to_owned())
        .filter(|v| {
            Path::new(v).is_absolute()
                && Path::new(v).is_file()
                && Path::new(v)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case(browser_name))
        });
    #[cfg(target_os = "macos")]
    {
        let application = config["applications"]
            .get(id)
            .ok_or("Choose a supported StashDock app.")?;
        if id == "desktop" {
            if let Some(ref path) = desktop {
                return shell_open(path);
            }
        }
        let ids: Vec<_> = application["bundleIdentifiers"]
            .as_array()
            .map(|v| v.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if let Some(path) = crate::macos_services::application_path(&ids) {
            // Do not mask an installed client's failure by silently opening a website.
            return shell_open(&path);
        }
    }
    #[cfg(not(windows))]
    let browser_executable = None;
    let (target, fallback) = target_with(
        &config,
        id,
        desktop,
        |scheme| {
            #[cfg(windows)]
            {
                registered_protocol(scheme)
            }
            #[cfg(not(windows))]
            {
                let _ = scheme;
                false
            }
        },
        browser_executable,
    )?;
    shell_open(&target).or_else(|error| fallback.map_or(Err(error), |url| shell_open(&url)))
}
#[tauri::command]
pub async fn open_integration(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::library::LibraryState>();
        let desktop = {
            let db = state
                .connection
                .lock()
                .map_err(|_| "The library is busy.")?;
            registered_desktop(&db)
        };
        launch(&id, desktop)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_targets_prefer_registered_clients_and_use_official_fallbacks() {
        let config = configuration();
        assert_eq!(
            target_with(&config, "dsh", None, |scheme| scheme == "dsh", None)
                .unwrap()
                .0,
            "dsh://open"
        );
        assert_eq!(
            target_with(&config, "dsh", None, |_| false, None)
                .unwrap()
                .0,
            "https://deepseek.com/harness"
        );
        assert_eq!(
            target_with(&config, "codex", None, |scheme| scheme == "codex", None)
                .unwrap()
                .0,
            "codex://"
        );
        assert_eq!(
            target_with(&config, "claude", None, |_| false, None)
                .unwrap()
                .0,
            "https://claude.ai/"
        );
        assert_eq!(
            target_with(
                &config,
                "chrome",
                None,
                |_| false,
                Some("C:\\Chrome\\chrome.exe".into())
            )
            .unwrap()
            .0,
            "C:\\Chrome\\chrome.exe"
        );
        assert!(target_with(&config, "file:///secret", None, |_| true, None).is_err());
        assert_eq!(
            target_with(&config, "desktop", None, |_| false, None)
                .unwrap()
                .0,
            "https://stashdock.app/guide#install-desktop"
        );
    }
}
