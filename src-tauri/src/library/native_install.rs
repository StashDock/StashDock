//! Per-user browser manifests. Installation bundles remain sealed; only the
//! owning provider's current registration can be removed by its uninstaller.
use super::native_host::{has_usable_registration, Registration};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

fn directory(home: &Path, browser: &str) -> PathBuf {
    home.join("Library/Application Support")
        .join(match browser {
            "chrome" => "Google/Chrome/NativeMessagingHosts",
            "edge" => "Microsoft Edge/NativeMessagingHosts",
            "firefox" => "Mozilla/NativeMessagingHosts",
            _ => unreachable!(),
        })
}

fn remove_owned(path: &Path, executable: &Path) -> Result<(), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["path"].as_str() == executable.to_str() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn register(
    provider: &str,
    executable: &Path,
    mode: Registration,
) -> Result<(), String> {
    let executable = fs::canonicalize(executable).map_err(|e| e.to_string())?;
    if fs::metadata(&executable)
        .map_err(|e| e.to_string())?
        .permissions()
        .mode()
        & 0o111
        == 0
    {
        return Err("The browser save component is not executable.".into());
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home folder unavailable.")?);
    if !home.is_absolute() {
        return Err("Home folder unavailable.".into());
    }
    for browser in ["chrome", "edge", "firefox"] {
        let directory = directory(&home, browser);
        let path = directory.join(format!("app.stashdock.{provider}.json"));
        if mode == Registration::Remove {
            remove_owned(&path, &executable)?;
        } else {
            if mode == Registration::Ensure
                && has_usable_registration(&path, provider, browser == "firefox")
            {
                continue;
            }
            fs::create_dir_all(directory).map_err(|e| e.to_string())?;
            super::native_host::atomic_json(
                &path,
                &super::native_host::manifest(&executable, provider, browser == "firefox"),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_uninstaller_cannot_remove_new_registration() {
        let root =
            std::env::temp_dir().join(format!("stashdock-manifest-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("app.stashdock.plugin.json");
        let old = root.join("Old Plugin/stashdock-browser");
        let new = root.join("New Plugin/stashdock-browser");
        super::super::native_host::atomic_json(&path, &serde_json::json!({"path":new})).unwrap();
        remove_owned(&path, &old).unwrap();
        assert!(path.exists());
        remove_owned(&path, &new).unwrap();
        assert!(!path.exists());
        fs::remove_dir(root).unwrap();
    }
}
