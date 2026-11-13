//! A file reference points at the user's original file and keeps a managed
//! backup in the library. Before a file is opened, transferred or read for AI,
//! a changed original refreshes the backup (and its searchable text). A missing
//! or unreachable original silently falls back to the backup.
//!
//! Mirrors `plugins/stashdock/server/original-files.mjs`; keep them in step.
use super::*;
use std::time::UNIX_EPOCH;

/// Same limit as chosen files; a larger original is used in place, not copied.
const MAX_ORIGINAL_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub(crate) struct Resolved {
    /// The file whose bytes are current: the refreshed backup, or the original
    /// when the backup could not be replaced (for example while it is open).
    pub current: PathBuf,
    /// What Open shows: the original when it is available, otherwise the backup.
    pub open: PathBuf,
}

/// Windows `canonicalize` returns verbatim paths (`\\?\D:\...`). Some apps and
/// shell drop targets mishandle them, so paths handed outside StashDock or
/// stored as the original's location use the ordinary form when it is equivalent.
pub(crate) fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let ordinary = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        Some(format!(r"\\{rest}"))
    } else {
        text.strip_prefix(r"\\?\")
            .filter(|rest| rest.as_bytes().get(1) == Some(&b':'))
            .map(str::to_string)
    };
    // Longer paths only work in verbatim form.
    match ordinary.filter(|value| value.len() < 260) {
        Some(value) => PathBuf::from(value),
        None => path,
    }
}

impl Resolved {
    fn new(current: PathBuf, open: PathBuf) -> Self {
        Resolved {
            current: plain(current),
            open: plain(open),
        }
    }
}

pub(crate) fn fingerprint(path: &Path) -> Option<(u64, i64)> {
    let metadata = fs::metadata(path).ok().filter(|value| value.is_file())?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some((metadata.len(), modified))
}

pub(crate) fn fingerprint_json(value: (u64, i64)) -> serde_json::Value {
    serde_json::json!({ "size": value.0, "modifiedMs": value.1 })
}

fn recorded(origin: &serde_json::Value) -> Option<(u64, i64)> {
    let value = origin.get("originalFingerprint")?;
    Some((
        value.get("size")?.as_u64()?,
        value.get("modifiedMs")?.as_i64()?,
    ))
}

fn same_extension(a: &Path, b: &Path) -> bool {
    let extension = |path: &Path| {
        path.extension()
            .map(|value| value.to_string_lossy().to_lowercase())
    };
    extension(a) == extension(b)
}

/// The original only counts when it is still a regular file of the same type.
fn available_original(raw: Option<&str>, managed: &Path) -> Option<PathBuf> {
    let path = Path::new(raw.filter(|value| !value.is_empty())?);
    if !path.is_absolute() || !same_extension(path, managed) {
        return None;
    }
    let path = path.canonicalize().ok()?;
    path.is_file().then_some(path)
}

fn replace_backup(original: &Path, managed: &Path) -> Result<(), String> {
    let parent = managed.parent().ok_or("The file library is unavailable.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".{}.refresh", Uuid::new_v4()));
    let result = fs::copy(original, &temporary)
        .map_err(|e| e.to_string())
        .and_then(|_| fs::rename(&temporary, managed).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn synchronize(
    connection: &Connection,
    assets: &Path,
    id: &str,
) -> Result<Resolved, String> {
    let (asset, original, origin, mime): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT asset_path, original_path, origin_json, mime_type FROM stash_items WHERE id=?1 AND kind<>'note'",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "The saved file was not found.".to_string())?;
    let raw = asset
        .filter(|value| !value.is_empty())
        .ok_or("This reference has no saved file.")?;
    let mut origin: serde_json::Value = origin
        .and_then(|value| serde_json::from_str(&value).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    // The backup path must stay inside the library even when its file is gone.
    let root = assets
        .canonicalize()
        .map_err(|_| "The file library is unavailable.")?;
    let backup = Path::new(&raw);
    let managed = match backup.canonicalize() {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
        _ => {
            let parent = backup.parent().and_then(|value| value.canonicalize().ok());
            match (parent, backup.file_name()) {
                (Some(parent), Some(name)) if parent.starts_with(&root) => parent.join(name),
                _ => return Err("This file is missing. Import it again.".into()),
            }
        }
    };
    let Some(original) = available_original(original.as_deref(), &managed) else {
        if !managed.is_file() {
            return Err("This file is missing. Import it again.".into());
        }
        return Ok(Resolved::new(managed.clone(), managed));
    };
    let backup_fingerprint = fingerprint(&managed);
    let Some(current) = fingerprint(&original) else {
        let fallback = if backup_fingerprint.is_some() {
            managed
        } else {
            original
        };
        return Ok(Resolved::new(fallback.clone(), fallback));
    };
    if backup_fingerprint.is_some() && recorded(&origin) == Some(current) {
        return Ok(Resolved::new(managed, original));
    }
    // Older references have no fingerprint. A backup edited after the original
    // (through the previous Open behaviour) is the user's newer version.
    if recorded(&origin).is_none()
        && backup_fingerprint.is_some_and(|(_, modified)| modified > current.1)
    {
        return Ok(Resolved::new(managed.clone(), managed));
    }
    if current.0 > MAX_ORIGINAL_BYTES {
        return Ok(Resolved::new(original.clone(), original));
    }
    if replace_backup(&original, &managed).is_err() {
        // The backup may be open elsewhere; the original still has current bytes.
        return Ok(Resolved::new(original.clone(), original));
    }
    origin["originalFingerprint"] = fingerprint_json(current);
    let edited = origin
        .get("contentEdited")
        .and_then(|value| value.as_bool())
        == Some(true);
    let mime = mime.unwrap_or_default();
    // Text files re-derive their searchable text unless the user wrote it.
    let refresh = !edited && is_text_mime(&mime);
    let content = if refresh {
        extract_text(&managed, &mime)?
    } else {
        None
    };
    connection
        .execute(
            "UPDATE stash_items SET size_bytes=?1, origin_json=?2, updated_at=?3,
               content=CASE WHEN ?4 THEN ?5 ELSE content END,
               excerpt=CASE WHEN ?4 THEN ?6 ELSE excerpt END
             WHERE id=?7",
            params![
                current.0 as i64,
                origin.to_string(),
                now()?,
                refresh,
                content,
                content.as_deref().map(text_excerpt).unwrap_or_default(),
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(Resolved::new(managed, original))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    struct Fixture {
        root: PathBuf,
        connection: Connection,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn touch(path: &Path, seconds: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }
    fn fixture(original_text: &str, fingerprinted: bool) -> (Fixture, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("stashdock-originals-{}", Uuid::new_v4()));
        let assets = root.join("assets");
        fs::create_dir_all(assets.join("item")).unwrap();
        let original = root.join("Notes.md");
        let managed = assets.join("item").join("Notes.md");
        fs::write(&original, original_text).unwrap();
        fs::write(&managed, original_text).unwrap();
        touch(&original, 1_000);
        touch(&managed, 1_000);
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let origin = if fingerprinted {
            serde_json::json!({ "originalFingerprint": fingerprint_json(fingerprint(&original).unwrap()) })
        } else {
            serde_json::json!({})
        };
        connection
            .execute(
                "INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,asset_path,original_path,mime_type,size_bytes,content,origin_json,updated_at)
                 VALUES('item','Notes.md','file','Local file','',?1,'now',?2,?3,'text/markdown',?4,?5,?6,'now')",
                params!["[]", managed.to_string_lossy(), original.to_string_lossy(), original_text.len() as i64, original_text, origin.to_string()],
            )
            .unwrap();
        (
            Fixture { root, connection },
            // Resolved paths are handed out in ordinary (non-verbatim) form.
            plain(original.canonicalize().unwrap()),
            plain(managed.canonicalize().unwrap()),
        )
    }

    #[test]
    fn verbatim_windows_paths_become_ordinary_paths() {
        assert_eq!(
            plain(PathBuf::from(r"\\?\D:\Pictures\a.png")),
            PathBuf::from(r"D:\Pictures\a.png")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share\a.png")),
            PathBuf::from(r"\\server\share\a.png")
        );
        assert_eq!(
            plain(PathBuf::from("/home/a.png")),
            PathBuf::from("/home/a.png")
        );
        let long = format!(r"\\?\D:\{}", "x".repeat(300));
        assert_eq!(plain(PathBuf::from(&long)), PathBuf::from(&long));
    }

    #[test]
    fn unchanged_original_opens_the_original_and_uses_the_backup() {
        let (f, original, managed) = fixture("alpha", true);
        let resolved = synchronize(&f.connection, &f.root.join("assets"), "item").unwrap();
        assert_eq!(
            resolved,
            Resolved {
                current: managed,
                open: original
            }
        );
    }

    #[test]
    fn edited_original_refreshes_backup_text_and_search() {
        let (f, original, managed) = fixture("alpha", true);
        fs::write(&original, "bravo updated").unwrap();
        touch(&original, 2_000);
        let resolved = synchronize(&f.connection, &f.root.join("assets"), "item").unwrap();
        assert_eq!(resolved.current, managed);
        assert_eq!(fs::read_to_string(&managed).unwrap(), "bravo updated");
        let (content, size): (String, i64) = f
            .connection
            .query_row(
                "SELECT content,size_bytes FROM stash_items WHERE id='item'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((content.as_str(), size), ("bravo updated", 13));
        assert_eq!(
            super::super::search::search_ids(&f.connection, "updated")
                .unwrap()
                .unwrap(),
            vec!["item"]
        );
        // The next use sees the recorded fingerprint and does no copy.
        fs::write(&managed, "bravo updated").unwrap();
        assert_eq!(
            synchronize(&f.connection, &f.root.join("assets"), "item")
                .unwrap()
                .open,
            original
        );
    }

    #[test]
    fn user_edited_import_text_is_kept_while_bytes_refresh() {
        let (f, original, managed) = fixture("alpha", true);
        f.connection
            .execute("UPDATE stash_items SET content='my words', origin_json=json_set(origin_json,'$.contentEdited',json('true'))", [])
            .unwrap();
        fs::write(&original, "bravo").unwrap();
        touch(&original, 2_000);
        synchronize(&f.connection, &f.root.join("assets"), "item").unwrap();
        assert_eq!(fs::read_to_string(&managed).unwrap(), "bravo");
        let content: String = f
            .connection
            .query_row("SELECT content FROM stash_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(content, "my words");
    }

    #[test]
    fn missing_original_falls_back_to_backup_and_missing_backup_is_restored() {
        let (f, original, managed) = fixture("alpha", true);
        fs::remove_file(&managed).unwrap();
        let resolved = synchronize(&f.connection, &f.root.join("assets"), "item").unwrap();
        assert_eq!(
            resolved,
            Resolved {
                current: managed.clone(),
                open: original.clone()
            }
        );
        assert_eq!(fs::read_to_string(&managed).unwrap(), "alpha");
        fs::remove_file(&original).unwrap();
        let resolved = synchronize(&f.connection, &f.root.join("assets"), "item").unwrap();
        assert_eq!(
            resolved,
            Resolved {
                current: managed.clone(),
                open: managed
            }
        );
    }

    #[test]
    fn legacy_backup_edited_after_its_original_stays_authoritative() {
        let (f, _original, managed) = fixture("alpha", false);
        fs::write(&managed, "edited backup").unwrap();
        touch(&managed, 3_000);
        let resolved = synchronize(&f.connection, &f.root.join("assets"), "item").unwrap();
        assert_eq!(
            resolved,
            Resolved {
                current: managed.clone(),
                open: managed.clone()
            }
        );
        assert_eq!(fs::read_to_string(&managed).unwrap(), "edited backup");
    }

    #[test]
    fn an_original_of_another_type_or_outside_path_is_ignored() {
        let (f, _original, managed) = fixture("alpha", true);
        let other = f.root.join("Notes.exe");
        fs::write(&other, "x").unwrap();
        f.connection
            .execute(
                "UPDATE stash_items SET original_path=?1",
                [other.to_string_lossy()],
            )
            .unwrap();
        assert_eq!(
            synchronize(&f.connection, &f.root.join("assets"), "item")
                .unwrap()
                .open,
            managed
        );
        f.connection
            .execute(
                "UPDATE stash_items SET asset_path=?1",
                [f.root.join("elsewhere.md").to_string_lossy()],
            )
            .unwrap();
        assert!(synchronize(&f.connection, &f.root.join("assets"), "item").is_err());
    }
}
