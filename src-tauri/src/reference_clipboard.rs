//! User-initiated copying of the same payload used by native drag.
//! No automatic paste, host IPC, focus changes, or library mutations.
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn copy_reference_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    _library: tauri::State<'_, crate::library::LibraryState>,
    item_ids: Vec<String>,
) -> Result<(), String> {
    // The library panel and the folder search are local desktop windows.
    if !matches!(window.label(), "main" | "search") {
        return Err("Use the StashDock desktop window to copy a file.".into());
    }
    copy_ids(app, item_ids).await
}

/// Shared native clipboard action for the WebView shelf and AppKit accessory.
pub(crate) async fn copy_ids(app: AppHandle, item_ids: Vec<String>) -> Result<(), String> {
    crate::reference_drag::validate_selection(&item_ids, 10_000)?;
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("File clipboard copying is only available on Windows.".into())
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        let usage_ids = item_ids.clone();
        let database = app
            .state::<crate::library::LibraryState>()
            .database_path()
            .to_path_buf();
        let file = tauri::async_runtime::spawn_blocking(move || {
            crate::reference_drag::export_reference_file(
                &database,
                &item_ids,
                crate::reference_drag::ExportKind::Clipboard,
            )
        })
        .await
        .map_err(|_| "Reference file export was interrupted.".to_string())??;
        let keep = file.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            #[cfg(windows)]
            let _ = tx.send(crate::reference_drag_windows::copy_to_clipboard(&file));
            #[cfg(target_os = "macos")]
            let _ = tx.send(crate::reference_transfer_macos::copy_to_clipboard(&file));
        })
        .map_err(|_| "Could not start clipboard copying.".to_string())?;
        let result = tauri::async_runtime::spawn_blocking(move || rx.recv())
            .await
            .map_err(|_| "Clipboard copying was interrupted.".to_string())?
            .map_err(|_| "Clipboard copying was interrupted.".to_string())?;
        if result.is_ok() {
            let usage_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::library::usage::record_transfer(&usage_app, &usage_ids)
            });
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(path) = keep.export_anchor() {
                    crate::reference_drag::prune_exports(path);
                }
            });
        }
        // Retain the generated file even if flushing failed after clipboard ownership
        // changed. A receiver might already have obtained its path.
        result
    }
}
