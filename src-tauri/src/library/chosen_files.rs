//! Files chosen in the system file dialog are saved as references to their
//! originals (see `originals.rs`). Choosing only stages a short-lived token;
//! the page never sends a path, and Save is a separate, explicit action.
use super::*;
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

const TOKEN_LIFETIME: Duration = Duration::from_secs(60 * 60);
const MAX_TOKENS: usize = 200;
const MAX_FILES: usize = 10;
/// Native imports copy from disk without sending file bytes through the WebView.
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 1024 * 1024 * 1024;
const STAGED_CHARACTERS: usize = 50_000;

static CHOSEN: Mutex<Vec<(String, PathBuf, Instant)>> = Mutex::new(Vec::new());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChosenFile {
    token: String,
    name: String,
    size: u64,
    mime_type: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChosenDraft {
    token: String,
    title: String,
    content: String,
    #[serde(default)]
    preview: Option<String>,
}

fn staged_text(path: &Path, mime: &str) -> Result<String, String> {
    Ok(extract_text(path, mime)?
        .map(|text| text.chars().take(STAGED_CHARACTERS).collect())
        .unwrap_or_default())
}

fn remember(path: PathBuf) -> String {
    let token = Uuid::new_v4().to_string();
    if let Ok(mut chosen) = CHOSEN.lock() {
        chosen.retain(|(_, _, at)| at.elapsed() < TOKEN_LIFETIME);
        if chosen.len() >= MAX_TOKENS {
            chosen.remove(0);
        }
        chosen.push((token.clone(), path, Instant::now()));
    }
    token
}

fn chosen_path(token: &str) -> Result<PathBuf, String> {
    let chosen = CHOSEN.lock().map_err(|_| "Choose the files again.")?;
    chosen
        .iter()
        .find(|(value, _, at)| value == token && at.elapsed() < TOKEN_LIFETIME)
        .map(|(_, path, _)| path.clone())
        .ok_or_else(|| "Choose the files again.".to_string())
}

pub(crate) fn describe(paths: Vec<PathBuf>) -> Result<Vec<ChosenFile>, String> {
    if paths.len() > MAX_FILES {
        return Err("Choose up to 10 files at a time.".into());
    }
    let mut total = 0;
    paths
        .into_iter()
        .map(|path| {
            let path = path
                .canonicalize()
                .map_err(|_| "A chosen file could not be read.")?;
            let metadata = fs::metadata(&path).map_err(|_| "A chosen file could not be read.")?;
            if !metadata.is_file() {
                return Err("Choose files, not folders.".to_string());
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err("Choose files up to 512 MB each.".into());
            }
            total += metadata.len();
            if total > MAX_BATCH_BYTES { return Err("Choose files up to 1 GB in total.".into()); }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or("A chosen file name is not supported.")?
                .to_string();
            let (_, mime) = file_kind(&path);
            Ok(ChosenFile {
                content: staged_text(&path, mime)?,
                token: remember(path),
                name,
                size: metadata.len(),
                mime_type: mime.into(),
            })
        })
        .collect()
}

fn prepare(
    drafts: Vec<ChosenDraft>,
    tags: Vec<String>,
    assets: &Path,
) -> Result<Vec<StashItem>, String> {
    let tags = clean_tags(tags)?;
    if drafts.is_empty() || drafts.len() > MAX_FILES {
        return Err("Choose 1 to 10 files.".into());
    }
    let mut prepared = Vec::new();
    for draft in drafts {
        if draft.title.trim().is_empty()
            || draft.title.chars().count() > 500
            || draft.content.chars().count() > STAGED_CHARACTERS
        {
            return Err("Check the file title and content, then retry.".into());
        }
        let original = chosen_path(&draft.token)?;
        let cover = draft
            .preview
            .as_deref()
            .map(crate::reference_cover::from_data_url)
            .transpose()?;
        prepared.push((draft, original, cover));
    }
    let mut written: Vec<PathBuf> = Vec::new();
    let mut total = 0;
    let result = prepared
        .into_iter()
        .map(|(draft, original, cover)| {
            let fingerprint = originals::fingerprint(&original).ok_or("A chosen file is no longer available. Choose it again.")?;
            if fingerprint.0 > MAX_FILE_BYTES {
                return Err("Choose files up to 512 MB each.".to_string());
            }
            total += fingerprint.0;
            if total > MAX_BATCH_BYTES { return Err("Choose files up to 1 GB in total.".into()); }
            let name: String = original
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("File")
                .chars()
                .take(150)
                .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '-' } else { c })
                .collect();
            let id = Uuid::new_v4().to_string();
            let folder = assets.join(&id);
            fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let backup = folder.join(&name);
            written.push(folder.clone());
            fs::copy(&original, &backup).map_err(|_| "A chosen file could not be copied. Choose it again.")?;
            let (kind, mime) = file_kind(&original);
            // Unedited text stays derived from the file and follows later edits.
            let staged = staged_text(&backup, mime)?;
            let edited = draft.content != staged;
            let content = if edited {
                Some(draft.content.clone()).filter(|value| !value.is_empty())
            } else {
                extract_text(&backup, mime)?
            };
            let image = (kind == "image" && fingerprint.0 <= 20_000_000)
                .then(|| fs::read(&backup).ok())
                .flatten()
                .and_then(|bytes| crate::web_images::raster(&bytes, false).ok());
            let created = now()?;
            let mut origin = serde_json::json!({
                "platform": "Local file", "importMethod": "local_file", "fileName": name, "importedAt": created,
                "originalFingerprint": originals::fingerprint_json(fingerprint),
            });
            if edited {
                origin["contentEdited"] = serde_json::json!(true);
            }
            if cover.is_some() {
                origin["previewKind"] = serde_json::json!("cover");
                origin["previewSource"] = serde_json::json!("custom");
            }
            Ok(StashItem {
                id,
                title: draft.title.trim().to_string(),
                kind: kind.into(),
                source: "Local file".into(),
                url: None,
                excerpt: content.as_deref().map(text_excerpt).filter(|value| !value.is_empty())
                    .unwrap_or_else(|| format!("{mime} · {}", format_size(fingerprint.0))),
                tags: tags.clone(),
                created_at: created,
                use_count: 0,
                favorite: false,
                preview: cover.or(image),
                preview_status: None,
                asset_path: Some(backup.to_string_lossy().into_owned()),
                original_path: Some(originals::plain(original.clone()).to_string_lossy().into_owned()),
                mime_type: Some(mime.into()),
                size_bytes: Some(fingerprint.0),
                content,
                context_override: None,
                origin: Some(origin),
            })
        })
        .collect::<Result<Vec<_>, String>>();
    if result.is_err() {
        for folder in written {
            let _ = fs::remove_dir_all(folder);
        }
    }
    result
}

pub fn import(
    drafts: Vec<ChosenDraft>,
    tags: Vec<String>,
    state: &LibraryState,
) -> Result<Vec<StashItem>, String> {
    let imported = prepare(drafts, tags, &state.assets_dir)?;
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
        for item in &imported {
            if let Some(folder) = item
                .asset_path
                .as_deref()
                .and_then(|path| Path::new(path).parent())
            {
                let _ = fs::remove_dir_all(folder);
            }
        }
        return Err(error);
    }
    Ok(imported)
}

pub fn choose(app: &AppHandle) -> Result<Vec<ChosenFile>, String> {
    let mut dialog = app.dialog().file().set_title("Choose files");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let paths = dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    describe(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chosen_files_reference_their_originals_and_keep_unedited_text_derived() {
        let root = std::env::temp_dir().join(format!("stashdock-chosen-{}", Uuid::new_v4()));
        let assets = root.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let note = root.join("Plan.md");
        let pdf = root.join("Paper.pdf");
        fs::write(&note, "# Plan\nShip it").unwrap();
        fs::write(&pdf, b"%PDF-1.7 bytes").unwrap();
        let chosen = describe(vec![note.clone(), pdf.clone()]).unwrap();
        assert_eq!(chosen[0].content, "# Plan\nShip it");
        assert_eq!(chosen[1].content, "");
        let drafts = vec![
            ChosenDraft {
                token: chosen[0].token.clone(),
                title: "Plan".into(),
                content: chosen[0].content.clone(),
                preview: None,
            },
            ChosenDraft {
                token: chosen[1].token.clone(),
                title: "Paper".into(),
                content: "My summary".into(),
                preview: None,
            },
        ];
        let items = prepare(drafts, vec!["Work".into()], &assets).unwrap();
        assert_eq!(
            items[0].original_path.as_deref(),
            Some(
                originals::plain(note.canonicalize().unwrap())
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(items[0]
            .asset_path
            .as_deref()
            .unwrap()
            .starts_with(assets.to_string_lossy().as_ref()));
        assert_eq!(
            fs::read_to_string(items[0].asset_path.as_ref().unwrap()).unwrap(),
            "# Plan\nShip it"
        );
        let origin = items[0].origin.as_ref().unwrap();
        assert!(origin.get("contentEdited").is_none());
        assert!(origin["originalFingerprint"]["size"].as_u64().is_some());
        assert_eq!(items[1].content.as_deref(), Some("My summary"));
        assert_eq!(items[1].origin.as_ref().unwrap()["contentEdited"], true);
        assert_eq!(items[1].kind, "pdf");
        assert!(prepare(
            vec![ChosenDraft {
                token: "unknown".into(),
                title: "x".into(),
                content: String::new(),
                preview: None
            }],
            vec![],
            &assets
        )
        .is_err());
        assert!(describe(vec![root.clone()]).is_err(), "folders are refused");
        let _ = fs::remove_dir_all(root);
    }
}
