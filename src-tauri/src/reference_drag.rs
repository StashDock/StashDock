//! User-initiated outgoing file drags. No clipboard or conversation automation.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

pub struct ReferenceDragState {
    active: AtomicBool,
}

impl Default for ReferenceDragState {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DragStatus {
    Dropped,
    Rejected,
    Cancelled,
    ReleasedBeforeStart,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutcome {
    pub dropped: bool,
    pub status: DragStatus,
    pub elapsed_ms: u64,
    pub effect: u32,
    pub hresult: Option<i32>,
    pub preview_ready: bool,
    pub copy_target_seen: bool,
    pub queue_button_before: Option<bool>,
    pub query_count: u32,
    pub first_queue_button_down: Option<bool>,
    pub first_physical_button_down: Option<bool>,
}

impl DragOutcome {
    pub fn released() -> Self {
        Self {
            dropped: false,
            status: DragStatus::ReleasedBeforeStart,
            elapsed_ms: 0,
            effect: 0,
            hresult: None,
            preview_ready: false,
            copy_target_seen: false,
            queue_button_before: None,
            query_count: 0,
            first_queue_button_down: None,
            first_physical_button_down: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceDragRequest {
    pub item_ids: Vec<String>,
    pub preview: String,
    #[serde(default)]
    pub hotspot: Option<DragHotspot>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DragHotspot {
    pub x: i32,
    pub y: i32,
}

/// Only the local source window may start a native drag, never an HTTP sidebar.
#[tauri::command]
pub async fn drag_reference_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    library: tauri::State<'_, crate::library::LibraryState>,
    item_ids: Vec<String>,
    preview: String,
    hotspot: Option<DragHotspot>,
) -> Result<DragOutcome, String> {
    // The library panel and the folder search are local desktop windows.
    if !matches!(window.label(), "main" | "search") {
        return Err("Use the StashDock desktop window to drag a file.".into());
    }
    let database = library.database_path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        start(
            app,
            &database,
            ReferenceDragRequest {
                item_ids,
                preview,
                hotspot,
            },
        )
    })
    .await
    .map_err(|_| "Reference file drag was interrupted.".to_string())?
}

pub(crate) fn validate_ids(ids: &[String]) -> Result<(), String> {
    validate_selection(ids, 100)
}

pub(crate) fn validate_selection(ids: &[String], limit: usize) -> Result<(), String> {
    if ids.is_empty() || ids.len() > limit {
        return Err(format!("Select between 1 and {limit} references."));
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if id.is_empty()
            || id.len() > 120
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            || !seen.insert(id)
        {
            return Err("Invalid reference selection.".into());
        }
    }
    Ok(())
}

pub(crate) fn export_filename(context: &str, count: usize) -> String {
    let title = if count == 1 {
        context
            .lines()
            .find_map(|line| line.strip_prefix("## "))
            .unwrap_or("Reference")
    } else {
        "Selected references"
    };
    let title: String = title
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(64)
        .collect();
    // Each transfer has its own folder, so the name needs no unique suffix.
    let title = title.trim_matches([' ', '.']);
    format!(
        "StashDock - {}.md",
        if title.is_empty() { "Reference" } else { title }
    )
}

#[cfg(any(windows, target_os = "macos"))]
fn decode_preview(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let encoded = value
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid drag preview.")?;
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("Drag preview is too large.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid drag preview.")?;
    // Bound WIC decoding by validating the PNG header and raster dimensions first.
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("Invalid drag preview.".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0
        || height == 0
        || width > 2048
        || height > 1536
        || width as u64 * height as u64 > 2_000_000
    {
        return Err("Invalid drag preview dimensions.".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn left_button_down() -> bool {
    unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(1) < 0 }
}

#[cfg(windows)]
fn owns_foreground_input() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };
    let mut process = 0;
    let window = unsafe { GetForegroundWindow() };
    !window.is_null()
        && unsafe { GetWindowThreadProcessId(window, &mut process) } != 0
        && process == std::process::id()
}

struct ActiveGuard<'a>(&'a AtomicBool);
impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Called on a blocking worker; OLE stays on Tauri's UI thread.
fn start(
    app: AppHandle,
    database: &std::path::Path,
    request: ReferenceDragRequest,
) -> Result<DragOutcome, String> {
    let state = app.state::<ReferenceDragState>();
    validate_ids(&request.item_ids)?;
    #[cfg(windows)]
    if !owns_foreground_input() {
        return Err("Browser references must use the browser's own drag gesture.".into());
    }
    if state.active.swap(true, Ordering::AcqRel) {
        return Err("A reference drag is already active.".into());
    }
    let _guard = ActiveGuard(&state.active);
    let usage_ids = request.item_ids.clone();
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = database;
        Err("Native reference dragging is only available on Windows.".into())
    }
    #[cfg(windows)]
    {
        if !left_button_down() {
            return Ok(DragOutcome::released());
        }
        let image = decode_preview(&request.preview)?;
        let file = export_reference_file(database, &request.item_ids, ExportKind::Drag)?;
        let keep_file = file.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = if !owns_foreground_input() {
                Err("The drag source is no longer the foreground app.".into())
            } else if !left_button_down() {
                Ok(DragOutcome::released())
            } else {
                crate::reference_drag_windows::start(&file, &image, request.hotspot)
            };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        let result = rx
            .recv()
            .map_err(|_| "The reference drag was interrupted.".to_string())?;
        // A receiver may read the path later; successful exports survive the drop.
        if !result.as_ref().is_ok_and(|outcome| outcome.dropped) {
            crate::reference_transfer::discard(&keep_file);
        } else {
            crate::library::usage::record_transfer(&app, &usage_ids);
            if let Some(path) = keep_file.export_anchor() {
                prune_exports(path);
            }
        }
        result
    }
    #[cfg(target_os = "macos")]
    {
        let image = decode_preview(&request.preview)?;
        let file = export_reference_file(database, &request.item_ids, ExportKind::Drag)?;
        let keep = file.clone();
        let source = app
            .get_webview_window("main")
            .ok_or("The drag source window is unavailable.")?;
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let failure = tx.clone();
            if let Err(error) = crate::reference_transfer_macos::start_drag(
                &source,
                &file,
                &image,
                request.hotspot,
                tx,
            ) {
                let _ = failure.send(Err(error));
            }
        })
        .map_err(|e| e.to_string())?;
        let result = rx
            .recv()
            .map_err(|_| "The reference drag was interrupted.".to_string())?;
        if result.as_ref().is_ok_and(|outcome| outcome.dropped) {
            crate::library::usage::record_transfer(&app, &usage_ids);
            if let Some(path) = keep.export_anchor() {
                prune_exports(path);
            }
        } else {
            crate::reference_transfer::discard(&keep);
        }
        result
    }
}

/// One snapshot/file writer for both native drag and Copy for AI.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) enum ExportKind {
    Drag,
    Clipboard,
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn export_reference_file(
    database: &std::path::Path,
    ids: &[String],
    kind: ExportKind,
) -> Result<crate::reference_transfer::Transfer, String> {
    validate_selection(ids, 10_000)?;
    let folder = std::env::temp_dir().join(match kind {
        ExportKind::Drag => "stashdock-reference-drags",
        ExportKind::Clipboard => "stashdock-reference-copies",
    });
    crate::reference_transfer::export(database, ids, &folder)
}

/// Only after a new successful transfer. Never prune its active file.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn prune_exports(keep: &std::path::Path) {
    let Some(folder) = keep.parent().and_then(|folder| folder.parent()) else {
        return;
    };
    crate::reference_transfer::prune(folder, keep);
    // Flat names from older versions (title plus a UUID) only. Never delete a
    // directory or an original asset.
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let generated = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| s.starts_with("StashDock - "))
            .and_then(|s| s.rsplit(" - ").next())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_some();
        if path != keep
            && generated
            && path.extension().is_some_and(|e| e == "md")
            && entry.file_type().is_ok_and(|t| t.is_file())
        {
            if entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 7 * 86400)
            {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_has_no_paths_duplicates_or_unbounded_batches() {
        assert!(validate_ids(&["valid-id".into()]).is_ok());
        for ids in [
            vec![],
            vec!["../../secret".into()],
            vec!["a".into(), "a".into()],
            vec!["".into()],
            vec!["x".repeat(121)],
            vec!["a".into(); 101],
        ] {
            assert!(validate_ids(&ids).is_err());
        }
        let many: Vec<_> = (0..101).map(|i| format!("id-{i}")).collect();
        assert!(validate_ids(&many).is_err());
        assert!(validate_selection(&many, 10_000).is_ok());
    }
    #[test]
    fn broker_schema_does_not_accept_arbitrary_files_or_commands() {
        let json = r#"{"token":"test","itemIds":["a"],"preview":"png","path":"C:/secret"}"#;
        assert!(serde_json::from_str::<ReferenceDragRequest>(json).is_err());
    }
    #[test]
    fn exported_names_are_recognizable_without_becoming_file_paths() {
        let name = export_filename("# StashDock context\n\n## CON: / example <test>", 1);
        assert_eq!(name, "StashDock - CON  example test.md");
        assert_eq!(
            export_filename("## First", 2),
            "StashDock - Selected references.md"
        );
        assert_eq!(export_filename("## ...", 1), "StashDock - Reference.md");
    }
    #[test]
    fn preview_requires_a_small_png() {
        #[cfg(any(windows, target_os = "macos"))]
        {
            use base64::Engine;
            assert!(decode_preview("data:image/svg+xml,<svg/>").is_err());
            let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
            png.extend(300_u32.to_be_bytes());
            png.extend(112_u32.to_be_bytes());
            let data = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png)
            );
            assert!(decode_preview(&data).is_ok());
            png[16..20].copy_from_slice(&10000_u32.to_be_bytes());
            let data = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png)
            );
            assert!(decode_preview(&data).is_err());
        }
    }
}
