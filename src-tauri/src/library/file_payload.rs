use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    name: String,
    base64: String,
    title: String,
    content: String,
    #[serde(default)]
    preview: Option<String>,
}

fn prepare(
    files: Vec<FilePayload>,
    tags: Vec<String>,
    assets: &Path,
) -> Result<Vec<StashItem>, String> {
    let tags = clean_tags(tags)?;
    if files.is_empty() || files.len() > 10 {
        return Err("Choose 1 to 10 files.".into());
    }
    let mut total = 0;
    let inputs = files
        .into_iter()
        .map(|file| {
            if file.base64.len() > 6_666_668
                || file.title.trim().is_empty()
                || file.title.chars().count() > 500
                || file.content.chars().count() > 50_000
            {
                return Err("Check the file size, title and content, then retry.".to_string());
            }
            let bytes = STANDARD
                .decode(&file.base64)
                .map_err(|_| "The file data is invalid.")?;
            total += bytes.len();
            if STANDARD.encode(&bytes) != file.base64
                || bytes.len() > 5_000_000
                || total > 10_000_000
            {
                return Err("Choose files under 5 MB each and 10 MB total.".into());
            }
            let name = file
                .name
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .chars()
                .take(150)
                .map(|c| {
                    if c.is_control() || "<>:\"/\\|?*".contains(c) {
                        '-'
                    } else {
                        c
                    }
                })
                .collect::<String>();
            if name.trim_matches([' ', '.']).is_empty() {
                return Err("The file name is invalid.".into());
            }
            let cover = file
                .preview
                .as_deref()
                .map(crate::reference_cover::from_data_url)
                .transpose()?;
            Ok((file, bytes, name, cover))
        })
        .collect::<Result<Vec<_>, String>>()?;
    fs::create_dir_all(assets).map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    let result = (|| {
        inputs.into_iter().map(|(file, bytes, name, cover)| {
        let id = Uuid::new_v4().to_string();
        let path = assets.join(format!("{id}-{name}"));
        use std::io::Write;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
        written.push(path.clone()); output.write_all(&bytes).map_err(|e| e.to_string())?;
        let (kind, mime) = file_kind(Path::new(&name));
        let created = now()?;
        let mut origin = serde_json::json!({ "platform": "Local file", "importMethod": "local_file", "fileName": name, "importedAt": created });
        let staged = if is_text_mime(mime) {
            String::from_utf8_lossy(&bytes).chars().take(50_000).collect::<String>()
        } else { String::new() };
        if file.content != staged {
            origin["contentEdited"] = serde_json::json!(true);
        }
        if cover.is_some() { origin["previewKind"] = serde_json::json!("cover"); origin["previewSource"] = serde_json::json!("custom"); }
        Ok(StashItem { id, title: file.title.trim().to_string(), kind: kind.into(), source: "Local file".into(), url: None,
            excerpt: text_excerpt(&file.content), tags: tags.clone(), created_at: created.clone(), use_count: 0, favorite: false,
            preview: cover.or_else(|| if kind == "image" { crate::web_images::raster(&bytes, false).ok() } else { None }), preview_status: None,
            asset_path: Some(path.to_string_lossy().into_owned()), original_path: None, mime_type: Some(mime.into()), size_bytes: Some(bytes.len() as u64),
            content: Some(file.content), context_override: None,
            origin: Some(origin) })
    }).collect::<Result<Vec<_>, String>>()
    })();
    if result.is_err() {
        for path in written {
            let _ = fs::remove_file(path);
        }
    }
    result
}

pub fn import_file_payloads(
    files: Vec<FilePayload>,
    tags: Vec<String>,
    state: &LibraryState,
) -> Result<Vec<StashItem>, String> {
    let imported = prepare(files, tags, &state.assets_dir)?;
    let result = (|| {
        let mut connection = state
            .connection
            .lock()
            .map_err(|_| "The local library is busy.")?;
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        for item in &imported {
            upsert_item(&tx, item)?;
        }
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        // Only these newly created managed assets are removed on rollback.
        for item in &imported {
            if let Some(path) = &item.asset_path {
                let _ = fs::remove_file(path);
            }
        }
        return Err(error);
    }
    Ok(imported)
}

pub(crate) fn managed_asset_path(assets: &Path, raw: &str) -> Result<PathBuf, String> {
    let root = assets
        .canonicalize()
        .map_err(|_| "The file library is unavailable.")?;
    let path = Path::new(raw)
        .canonicalize()
        .map_err(|_| "This file is missing. Import it again.")?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("Only saved managed files can be transferred.".into());
    }
    Ok(path)
}

pub(super) fn managed_path(assets: &Path, raw: &str) -> Result<PathBuf, String> {
    openable(&managed_asset_path(assets, raw)?)
}

/// Only document/media types open directly; executables and scripts never do.
fn openable(path: &Path) -> Result<PathBuf, String> {
    let path = path.to_path_buf();
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic", "txt", "md", "mdx",
        "csv", "json", "log", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx",
        "odp", "zip", "mp3", "wav", "m4a", "ogg", "flac", "mp4", "mov", "webm", "avi",
    ]
    .contains(&extension.as_str())
    {
        return Err("Open this file type from your file manager.".into());
    }
    Ok(path)
}

pub fn open_reference_file(id: String, app: AppHandle, state: &LibraryState) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.")?;
    // Open shows the user's original when it is still available, else the backup.
    let resolved = super::originals::synchronize(&connection, &state.assets_dir, &id)?;
    drop(connection);
    let path = openable(&resolved.open)?;
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|_| "This file could not be opened. Check that its app is installed and the file still exists.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staged_payload_saves_edits_without_modifying_file_bytes() {
        let root = std::env::temp_dir().join(format!("stashdock-payload-{}", Uuid::new_v4()));
        let file = FilePayload {
            name: "../notes.txt".into(),
            base64: STANDARD.encode(b"Original bytes"),
            title: "Edited title".into(),
            content: "Edited context".into(),
            preview: None,
        };
        let saved = prepare(vec![file], vec!["UI".into()], &root).unwrap();
        assert_eq!(saved[0].title, "Edited title");
        assert_eq!(saved[0].content.as_deref(), Some("Edited context"));
        assert_eq!(
            fs::read(saved[0].asset_path.as_ref().unwrap()).unwrap(),
            b"Original bytes"
        );
        assert_eq!(saved[0].origin.as_ref().unwrap()["fileName"], "notes.txt");
        assert!(managed_path(&root, saved[0].asset_path.as_ref().unwrap()).is_ok());
        let executable = root.join("script.ps1");
        fs::write(&executable, "exit").unwrap();
        assert!(managed_path(&root, executable.to_str().unwrap()).is_err());
        assert!(managed_path(&root, std::env::current_exe().unwrap().to_str().unwrap()).is_err());
        fs::remove_file(saved[0].asset_path.as_ref().unwrap()).unwrap();
        fs::remove_file(executable).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn invalid_payload_does_not_create_assets() {
        let root =
            std::env::temp_dir().join(format!("stashdock-invalid-payload-{}", Uuid::new_v4()));
        let file = FilePayload {
            name: "a.txt".into(),
            base64: "invalid!".into(),
            title: "Title".into(),
            content: "Content".into(),
            preview: None,
        };
        assert!(prepare(vec![file], vec![], &root).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn custom_covers_persist_without_modifying_original_files_and_invalid_covers_are_atomic() {
        let root = std::env::temp_dir().join(format!("stashdock-cover-payload-{}", Uuid::new_v4()));
        let payload = |cover: &str| FilePayload {
            name: "notes.txt".into(),
            base64: STANDARD.encode(b"Original file"),
            title: "Reference".into(),
            content: "User context".into(),
            preview: Some(cover.into()),
        };
        assert!(prepare(
            vec![payload("data:image/png;base64,aHRtbA==")],
            vec![],
            &root
        )
        .is_err());
        assert!(!root.exists());
        let mut png = Vec::new();
        image::DynamicImage::new_rgb8(80, 50)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let cover = format!("data:image/png;base64,{}", STANDARD.encode(png));
        let saved = prepare(vec![payload(&cover)], vec![], &root).unwrap();
        assert!(saved[0]
            .preview
            .as_deref()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert_eq!(saved[0].origin.as_ref().unwrap()["previewKind"], "cover");
        assert_eq!(
            fs::read(saved[0].asset_path.as_ref().unwrap()).unwrap(),
            b"Original file"
        );
        let mut db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let tx = db.transaction().unwrap();
        upsert_item(&tx, &saved[0]).unwrap();
        tx.commit().unwrap();
        let loaded = read_items(&db).unwrap();
        assert_eq!(loaded[0].preview, saved[0].preview);
        assert_eq!(loaded[0].content, saved[0].content);
        fs::remove_file(saved[0].asset_path.as_ref().unwrap()).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
