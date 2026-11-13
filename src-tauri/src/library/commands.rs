//! Tauri adapters: disk/SQLite/image work never runs on the window thread.
//! The reservation bounds blocking workers and retained command payloads.
use super::preview_protocol;
use super::*;
static WORK: crate::blocking_work::WorkLimit = crate::blocking_work::WorkLimit::new(4);
pub(crate) async fn run<T: Send + 'static>(
    app: AppHandle,
    task: impl FnOnce(&LibraryState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    WORK.run(move || task(app.state::<LibraryState>().inner()))
        .await
}

#[tauri::command]
pub async fn initialize_library(app: AppHandle, items: Vec<StashItem>) -> Result<(), String> {
    run(app, move |s| super::initialize_library(items, s)).await
}
#[tauri::command]
pub async fn save_items(app: AppHandle, items: Vec<StashItem>) -> Result<(), String> {
    run(app, move |s| super::save_items(items, s)).await
}
#[tauri::command]
pub async fn replace_saved_link(app: AppHandle, item: StashItem) -> Result<(), String> {
    run(app, move |s| super::replace_saved_link(item, s)).await
}
#[tauri::command]
pub async fn list_items(app: AppHandle) -> Result<Vec<StashItem>, String> {
    run(app, super::list_items)
        .await
        .map(preview_protocol::for_webview)
}
/// Shelf metadata for a few references (`full` adds bodies and edited context).
#[tauri::command]
pub async fn get_items(
    app: AppHandle,
    ids: Vec<String>,
    full: bool,
) -> Result<Vec<StashItem>, String> {
    run(app, move |s| super::get_items(ids, full, s))
        .await
        .map(preview_protocol::for_webview)
}
#[tauri::command]
pub async fn search_items(app: AppHandle, query: String) -> Result<Vec<String>, String> {
    run(app, move |s| super::search_items(query, s)).await
}
#[tauri::command]
pub async fn set_item_favorite(app: AppHandle, id: String, favorite: bool) -> Result<(), String> {
    run(app, move |s| super::set_item_favorite(id, favorite, s)).await
}
#[tauri::command]
pub async fn delete_item(app: AppHandle, id: String) -> Result<bool, String> {
    run(app, move |s| super::delete_item(id, s)).await
}
#[tauri::command]
pub async fn delete_items(app: AppHandle, ids: Vec<String>) -> Result<usize, String> {
    run(app, move |s| super::delete_items(ids, s)).await
}
#[tauri::command]
pub async fn edit_item(
    app: AppHandle,
    id: String,
    title: String,
    tags: Vec<String>,
    cover: Option<CoverEdit>,
) -> Result<Vec<StashItem>, String> {
    run(app, move |s| super::edit_item(id, title, tags, cover, s))
        .await
        .map(preview_protocol::for_webview)
}
#[tauri::command]
pub async fn edit_item_content(
    app: AppHandle,
    id: String,
    content: String,
) -> Result<Vec<StashItem>, String> {
    run(app, move |s| super::edit_item_content(id, content, s))
        .await
        .map(preview_protocol::for_webview)
}
#[tauri::command]
pub async fn list_pinned_tags(app: AppHandle) -> Result<Vec<String>, String> {
    run(app, super::list_pinned_tags).await
}
#[tauri::command]
pub async fn set_tag_pinned(
    app: AppHandle,
    name: String,
    pinned: bool,
) -> Result<Vec<String>, String> {
    run(app, move |s| super::set_tag_pinned(name, pinned, s)).await
}
#[tauri::command]
pub async fn change_library_tag(
    app: AppHandle,
    name: String,
    replacement: Option<String>,
) -> Result<Vec<StashItem>, String> {
    run(app, move |s| {
        super::change_library_tag(name, replacement, s)
    })
    .await
    .map(preview_protocol::for_webview)
}
#[tauri::command]
pub async fn import_file_payloads(
    app: AppHandle,
    files: Vec<file_payload::FilePayload>,
    tags: Vec<String>,
) -> Result<Vec<StashItem>, String> {
    run(app, move |s| {
        file_payload::import_file_payloads(files, tags, s)
    })
    .await
    .map(preview_protocol::for_webview)
}
/// The system dialog waits for the user, so it never holds a library work slot.
#[tauri::command]
pub async fn choose_reference_files(
    app: AppHandle,
) -> Result<Vec<chosen_files::ChosenFile>, String> {
    tauri::async_runtime::spawn_blocking(move || chosen_files::choose(&app))
        .await
        .map_err(|_| "The file dialog could not open.".to_string())?
}
#[tauri::command]
pub async fn import_chosen_files(
    app: AppHandle,
    files: Vec<chosen_files::ChosenDraft>,
    tags: Vec<String>,
) -> Result<Vec<StashItem>, String> {
    run(app, move |s| chosen_files::import(files, tags, s))
        .await
        .map(preview_protocol::for_webview)
}
#[tauri::command]
pub async fn open_reference_file(app: AppHandle, id: String) -> Result<(), String> {
    let opener = app.clone();
    run(app, move |s| {
        file_payload::open_reference_file(id, opener, s)
    })
    .await
}

#[tauri::command]
pub async fn get_library_sort(app: AppHandle) -> Result<String, String> {
    run(app, |s| {
        super::usage::get_sort(&s.connection.lock().unwrap())
    })
    .await
}
#[tauri::command]
pub async fn set_library_sort(app: AppHandle, sort: String) -> Result<(), String> {
    run(app, move |s| {
        super::usage::set_sort(&s.connection.lock().unwrap(), &sort)
    })
    .await
}
