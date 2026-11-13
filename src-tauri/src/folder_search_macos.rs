//! Thin in-process AppKit adapter. Only presentation crosses the C ABI; Rust's
//! existing library, placement, export and window policies remain authoritative.
use crate::{library, reference_drag, settings, window_geometry};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::{c_char, CStr, CString},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Emitter, Manager};

type DragKey = (String, String);
struct PendingDrag {
    file: crate::reference_transfer::Transfer,
    reference_id: String,
}
static DRAGS: OnceLock<Mutex<HashMap<DragKey, PendingDrag>>> = OnceLock::new();
fn drags() -> &'static Mutex<HashMap<DragKey, PendingDrag>> {
    DRAGS.get_or_init(Mutex::default)
}
fn finish_drag(key: &DragKey, dropped: bool) {
    if let Some(PendingDrag { file, reference_id }) = drags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(key)
    {
        tauri::async_runtime::spawn_blocking(move || {
            if dropped {
                if let Some(app) = APP.get() {
                    library::usage::record_transfer(app, &[reference_id]);
                }
                if let Some(path) = file.export_anchor() {
                    reference_drag::prune_exports(path);
                }
            } else {
                crate::reference_transfer::discard(&file);
            }
        });
    }
}
static APP: OnceLock<AppHandle> = OnceLock::new();
static WORK: crate::blocking_work::WorkLimit = crate::blocking_work::WorkLimit::new(4);
static ICON_WORK: crate::blocking_work::WorkLimit = crate::blocking_work::WorkLimit::new(2);
static QUERY: AtomicU64 = AtomicU64::new(0);
extern "C" {
    fn stashdock_search_install(callback: extern "C" fn(*const c_char));
    fn stashdock_search_attach(config: *const c_char);
    fn stashdock_search_hover(inside: bool);
    fn stashdock_search_focus();
    fn stashdock_search_folder_gesture(active: bool);
    fn stashdock_search_detach(hide: bool);
    fn stashdock_search_response(response: *const c_char);
    fn stashdock_search_offer_drag(response: *const c_char) -> bool;
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Event {
    Marks {
        session: String,
        token: String,
        ids: Vec<String>,
    },
    Search {
        session: String,
        query: String,
        token: String,
    },
    Copy {
        session: String,
        id: String,
    },
    PrepareDrag {
        session: String,
        id: String,
        token: String,
    },
    DragFinished {
        session: String,
        token: String,
        dropped: bool,
    },
    Open {
        session: String,
        query: String,
    },
    Visibility {
        session: String,
        visible: bool,
        #[serde(default, rename = "releaseDelay")]
        release_delay: f64,
    },
    Place {
        session: String,
    },
}
fn with_json(value: &Value, call: impl FnOnce(*const c_char)) {
    if let Ok(raw) = CString::new(value.to_string()) {
        call(raw.as_ptr())
    }
}
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        // Setup and every call into the Swift owner run on AppKit's main thread.
        unsafe { stashdock_search_install(event) }
    }
}
pub fn attach(app: &AppHandle) -> Result<(), String> {
    let folder = app
        .get_window("folder")
        .ok_or("The folder is unavailable.")?;
    if !folder.is_visible().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let position = folder.outer_position().map_err(|e| e.to_string())?;
    let size = folder.outer_size().map_err(|e| e.to_string())?;
    let monitor = folder
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("The display is unavailable.")?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let placement = window_geometry::centred_search_placement(
        (position.x, position.y),
        size.width as f64,
        window_geometry::WorkArea {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
            scale,
        },
    );
    let mtm = objc2::MainThreadMarker::new().ok_or("Search placement requires the UI thread.")?;
    let _ = mtm;
    let pointer = folder.ns_window().map_err(|e| e.to_string())?;
    let native = unsafe { pointer.cast::<objc2_app_kit::NSWindow>().as_ref() }
        .ok_or("The folder is unavailable.")?;
    let frame = native.frame();
    let prefs = settings::read(&app.state::<library::LibraryState>())?;
    let chinese = prefs.language == settings::Language::Zh
        || (prefs.language == settings::Language::System && settings::system_language() == "zh");
    let config = json!({
        "x": frame.origin.x + (placement.x - position.x) as f64 / scale,
        "y": frame.origin.y + frame.size.height - ((placement.y - position.y) as f64 + placement.height as f64) / scale,
        "anchor": placement.anchor_px / scale,
        "chinese": chinese, "theme": prefs.theme,
        "controls": native_icons().as_object().unwrap().iter().filter(|(key, _)| key.starts_with("control_")).map(|(key,value)| (key.clone(),value.clone())).collect::<serde_json::Map<_,_>>(),
    });
    with_json(&config, |raw| unsafe { stashdock_search_attach(raw) });
    Ok(())
}
pub fn hover(inside: bool) {
    unsafe { stashdock_search_hover(inside) }
}
pub fn focus() {
    unsafe { stashdock_search_focus() }
}
pub fn folder_gesture(active: bool) {
    unsafe { stashdock_search_folder_gesture(active) }
}
pub fn detach(_app: &AppHandle, hide: bool) {
    if hide {
        crate::folder_window::cancel_gesture();
    }
    unsafe { stashdock_search_detach(hide) }
}
fn respond(app: &AppHandle, response: Value) {
    let _ = app.run_on_main_thread(move || {
        with_json(&response, |raw| unsafe { stashdock_search_response(raw) })
    });
}
extern "C" fn event(raw: *const c_char) {
    if raw.is_null() {
        return;
    }
    // Only the compiled Swift module calls this ABI with a live C string.
    let bytes = unsafe { CStr::from_ptr(raw) }.to_bytes();
    if bytes.len() > 8192 {
        return;
    }
    let Ok(event) = serde_json::from_slice::<Event>(bytes) else {
        return;
    };
    let Some(app) = APP.get().cloned() else {
        return;
    };
    match event {
        Event::Marks {
            session,
            token,
            ids,
        } if session.len() <= 64
            && token.len() <= 64
            && ids.len() <= 5
            && ids.iter().all(|id| valid_id(id)) =>
        {
            let generation = QUERY.load(Ordering::Relaxed);
            tauri::async_runtime::spawn(async move {
                let handle = app.clone();
                let retry =
                    json!({"action":"marksRetry","session":session,"token":token,"ids":ids});
                let result = ICON_WORK
                    .run(move || enrich_marks(&handle, generation, &session, &token, ids))
                    .await;
                // Admission failure leaves the initial visible. A later user
                // action can retry; there is no timer or unbounded job queue.
                if result.is_err() {
                    respond(&app, retry);
                }
            });
        }
        Event::Visibility {
            session,
            visible,
            release_delay,
        } if session.len() <= 64 && (0.0..=1.0).contains(&release_delay) => {
            if !visible {
                QUERY.fetch_add(1, Ordering::Relaxed);
            }
            crate::folder_window::search_visible(&app, visible, release_delay);
        }
        Event::Place { session } if session.len() <= 64 => {
            let _ = attach(&app);
        }
        Event::Open { session, query } if session.len() <= 64 && query.chars().count() <= 500 => {
            tauri::async_runtime::spawn(async move {
                if crate::desktop_windows::open_panel(&app).await.is_ok() {
                    let _ = app.emit_to("main", "library-search", query);
                }
            });
        }
        Event::Search {
            session,
            query,
            token,
        } if session.len() <= 64 && token.len() <= 64 && query.chars().count() <= 500 => {
            let generation = QUERY.fetch_add(1, Ordering::Relaxed) + 1;
            tauri::async_runtime::spawn(async move {
                let handle = app.clone();
                let result = WORK
                    .run(move || {
                        let state = handle.state::<library::LibraryState>();
                        if QUERY.load(Ordering::Relaxed) != generation {
                            return Err("Search replaced.".into());
                        }
                        let ids = library::search_items(query, &state)?
                            .into_iter()
                            .take(24)
                            .collect();
                        library::get_items(ids, false, &state)?
                            .into_iter()
                            .map(|item| {
                                if QUERY.load(Ordering::Relaxed) != generation {
                                    return Err("Search replaced.".into());
                                }
                                card(&state, item)
                            })
                            .collect::<Result<Vec<_>, String>>()
                    })
                    .await;
                let mut response = json!({"action":"search", "session":session, "token":token});
                match result {
                    Ok(items) => response["items"] = items.into(),
                    Err(error) => response["error"] = error.into(),
                }
                respond(&app, response);
            });
        }
        Event::Copy { session, id } if session.len() <= 64 && valid_id(&id) => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let result =
                    crate::reference_clipboard::copy_ids(app.clone(), vec![id.clone()]).await;
                let mut response = json!({"action":"copy", "session":session, "id":id});
                if let Err(error) = result {
                    response["error"] = error.into();
                }
                respond(&handle, response);
            });
        }
        Event::PrepareDrag { session, id, token }
            if session.len() <= 64 && token.len() <= 64 && valid_id(&id) =>
        {
            tauri::async_runtime::spawn(async move {
                let handle = app.clone();
                let reference_id = id.clone();
                let result = WORK
                    .run(move || {
                        reference_drag::export_reference_file(
                            handle.state::<library::LibraryState>().database_path(),
                            &[id],
                            reference_drag::ExportKind::Drag,
                        )
                    })
                    .await;
                match result {
                    Ok(file) => {
                        let recovery = file.clone();
                        let key = (session.clone(), token.clone());
                        let response = match &file {
                            crate::reference_transfer::Transfer::Text(text) => {
                                json!({"session":session,"token":token,"text":text})
                            }
                            crate::reference_transfer::Transfer::Files { files, .. } => {
                                json!({"session":session,"token":token,"paths":files})
                            }
                        };
                        if app
                            .run_on_main_thread(move || {
                                let mut active = drags().lock().unwrap_or_else(|e| e.into_inner());
                                if active.len() >= 4 || active.contains_key(&key) {
                                    drop(active);
                                    tauri::async_runtime::spawn_blocking(move || {
                                        crate::reference_transfer::discard(&file)
                                    });
                                    return;
                                }
                                active.insert(key.clone(), PendingDrag { file, reference_id });
                                drop(active);
                                // Swift accepts only the still-held original gesture.
                                // Rejected/stale offers release their own copies now.
                                let accepted =
                                    CString::new(response.to_string()).is_ok_and(|raw| unsafe {
                                        stashdock_search_offer_drag(raw.as_ptr())
                                    });
                                if !accepted {
                                    finish_drag(&key, false);
                                }
                            })
                            .is_err()
                        {
                            crate::reference_transfer::discard(&recovery);
                        }
                    }
                    Err(error) => respond(
                        &app,
                        json!({"action":"prepareDrag","session":session,"token":token,"error":error}),
                    ),
                }
            });
        }
        Event::DragFinished {
            session,
            token,
            dropped,
        } if session.len() <= 64 && token.len() <= 64 => {
            finish_drag(&(session, token), dropped);
        }
        _ => {}
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 120 && !id.chars().any(char::is_control)
}
fn enrich_marks(
    app: &AppHandle,
    generation: u64,
    session: &str,
    token: &str,
    ids: Vec<String>,
) -> Result<(), String> {
    if QUERY.load(Ordering::Relaxed) != generation {
        return Ok(());
    }
    let state = app.state::<library::LibraryState>();
    let db =
        rusqlite::Connection::open(state.database_path()).map_err(|error| error.to_string())?;
    let _ = db.busy_timeout(std::time::Duration::from_millis(100));
    let items = library::get_items(ids, false, &state)?;
    for item in items
        .into_iter()
        .filter(|item| matches!(item.kind.as_str(), "web" | "repo"))
    {
        if QUERY.load(Ordering::Relaxed) != generation {
            break;
        }
        let saved = item
            .origin
            .as_ref()
            .and_then(|value| value["faviconUrl"].as_str());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        for candidate in favicon_candidates(item.url.as_deref(), saved) {
            if QUERY.load(Ordering::Relaxed) != generation || std::time::Instant::now() >= deadline
            {
                break;
            }
            let icon = if candidate.starts_with("data:") {
                candidate
                    .split_once(',')
                    .and_then(|(_, raw)| STANDARD.decode(raw).ok())
                    .and_then(|bytes| crate::web_images::raster(&bytes, true).ok())
            } else {
                crate::web_preview::cached_favicon(&db, &candidate, deadline)
            };
            if let Some(mark) = icon {
                respond(
                    app,
                    json!({"action":"mark","session":session,"token":token,"id":item.id,"mark":mark}),
                );
                break;
            }
        }
    }
    Ok(())
}
fn favicon_candidates(page: Option<&str>, saved: Option<&str>) -> Vec<String> {
    let base = page.and_then(|value| url::Url::parse(value).ok());
    let valid = |url: &url::Url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    };
    let mut candidates = Vec::new();
    if let Some(raw) = saved.filter(|raw| !raw.trim().is_empty() && raw.len() <= 32768) {
        let inline = raw.split_once(";base64,").is_some_and(|(mime, bytes)| {
            [
                "data:image/png",
                "data:image/jpeg",
                "data:image/webp",
                "data:image/gif",
                "data:image/x-icon",
                "data:image/vnd.microsoft.icon",
            ]
            .iter()
            .any(|value| mime.eq_ignore_ascii_case(value))
                && !bytes.is_empty()
                && bytes
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
        });
        if inline {
            candidates.push(raw.to_owned());
        } else if let Some(url) = url::Url::parse(raw)
            .ok()
            .or_else(|| base.as_ref()?.join(raw).ok())
            .filter(&valid)
        {
            candidates.push(url.to_string());
        }
    }
    if let Some(base) = base.filter(valid) {
        // Generated from the Windows SiteIdentity owner, not a parallel list.
        let paths: Vec<String> = serde_json::from_str(include_str!(
            "../../assets/generated/native-favicon-paths.json"
        ))
        .expect("Approved favicon paths");
        for path in paths {
            if let Ok(url) = base.join(&path) {
                let value = url.to_string();
                if !candidates.contains(&value) {
                    candidates.push(value);
                }
            }
        }
    }
    candidates
}
fn file_rules() -> &'static Value {
    static RULES: OnceLock<Value> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/reference-file-types.json"))
            .expect("Shared file type rules")
    })
}
fn icon_label(kind: &str) -> &str {
    match kind {
        "note" => "Note",
        "web" => "Web page",
        "repo" => "Repository",
        _ => file_rules()
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["visual"] == kind)
            .and_then(|rule| rule["label"].as_str())
            .unwrap_or("File"),
    }
}
fn icon_kind(item: &library::StashItem) -> &'static str {
    if item.kind == "note" {
        return "note";
    }
    if item.kind == "web" {
        return "web";
    }
    if item.kind == "repo" {
        return "repo";
    }
    let name = item
        .origin
        .as_ref()
        .and_then(|v| v["fileName"].as_str())
        .or(item.asset_path.as_deref())
        .unwrap_or(&item.title);
    let extension = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = item.mime_type.as_deref().unwrap_or("");
    let rules = file_rules();
    for rule in rules.as_array().unwrap() {
        let any = |key: &str, predicate: &dyn Fn(&str) -> bool| {
            rule[key]
                .as_array()
                .is_some_and(|values| values.iter().filter_map(Value::as_str).any(predicate))
        };
        if any("kinds", &|v| v == item.kind)
            || any("extensions", &|v| v == extension)
            || any("mimeStarts", &|v| mime.starts_with(v))
            || any("mimeIncludes", &|v| mime.contains(v))
            || any("mimeEquals", &|v| mime == v)
        {
            return rule["visual"].as_str().unwrap();
        }
    }
    "file"
}
fn native_icons() -> &'static Value {
    static ICONS: OnceLock<Value> = OnceLock::new();
    ICONS.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/native-reference-icons.json"
        )))
        .expect("Compiled reference icon catalog")
    })
}
fn card(state: &library::LibraryState, item: library::StashItem) -> Result<Value, String> {
    let icons = native_icons();
    let site = item
        .url
        .as_deref()
        .and_then(|v| url::Url::parse(v).ok())
        .and_then(|v| {
            v.host_str()
                .map(|v| v.trim_start_matches("www.").to_owned())
        })
        .unwrap_or_else(|| item.source.clone());
    let mark = item
        .origin
        .as_ref()
        .and_then(|v| v["faviconUrl"].as_str())
        .filter(|v| v.starts_with("data:image/") && v.len() <= 32768)
        .and_then(|raw| STANDARD.decode(raw.split_once(',')?.1).ok())
        .and_then(|bytes| crate::web_images::raster(&bytes, true).ok());
    let web_mark = matches!(item.kind.as_str(), "web" | "repo");
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The library is busy.")?;
    let preview: Option<String> = connection.query_row("SELECT CASE WHEN octet_length(preview)<=6666700 THEN preview END FROM stash_items WHERE id=?1", [&item.id], |r| r.get(0)).unwrap_or(None);
    drop(connection);
    // Never fetch a remote image on the UI thread. Bound decoded thumbnails
    // before crossing into AppKit; placeholders reuse the bundled shelf icons.
    let preview = preview.and_then(|raw| {
        let data = raw.strip_prefix("data:image/")?.split_once(',')?.1;
        let bytes = STANDARD.decode(data).ok()?;
        crate::web_images::native_thumbnail(&bytes).ok()
    });
    let visual = icon_kind(&item);
    Ok(json!({
        "id": item.id,
        "title": item.title,
        "preview": preview,
        "icon": icons[visual],
        "mark": if web_mark { mark.map(Value::from).unwrap_or(Value::Null) } else { icons[visual].clone() },
        "site": site,
        "webMark": web_mark,
        "visual": visual,
        "label": icon_label(visual),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn favicon_candidates_match_the_windows_identity_contract() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/site-favicon-candidates.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let actual = favicon_candidates(case["page"].as_str(), case["saved"].as_str());
            let expected: Vec<String> = serde_json::from_value(case["candidates"].clone()).unwrap();
            assert_eq!(actual, expected, "{case}");
        }
        for raw in [
            "file:///private",
            "javascript:alert(1)",
            "https://user:pass@example.com/icon",
            "data:image/svg+xml,<svg/>",
        ] {
            assert!(favicon_candidates(None, Some(raw)).is_empty());
        }
    }

    #[test]
    fn drag_completion_cleans_only_its_own_cancelled_group_and_retains_delivered_files() {
        let root =
            std::env::temp_dir().join(format!("stashdock-drag-leases-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let original = root.join("user-original.txt");
        std::fs::write(&original, b"original remains unchanged").unwrap();
        let group = || {
            let folder = root.join(format!("StashDock transfer - {}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&folder).unwrap();
            let context_file = folder.join("StashDock - QA.md");
            std::fs::write(&context_file, b"test context").unwrap();
            crate::reference_transfer::Transfer::Files {
                files: vec![context_file.clone()],
                context_file: Some(context_file),
            }
        };
        let cancelled = group();
        let cancelled_path = cancelled.context_file().unwrap().to_path_buf();
        let key = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        );
        drags().lock().unwrap().insert(
            key.clone(),
            PendingDrag {
                file: cancelled,
                reference_id: String::new(),
            },
        );
        finish_drag(&("different session".into(), key.1.clone()), false);
        assert!(cancelled_path.is_file());
        finish_drag(&key, false);
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while cancelled_path.exists() && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!cancelled_path.exists());
        let delivered = group();
        let delivered_path = delivered.context_file().unwrap().to_path_buf();
        drags().lock().unwrap().insert(
            key.clone(),
            PendingDrag {
                file: delivered,
                reference_id: String::new(),
            },
        );
        finish_drag(&key, true);
        assert!(delivered_path.is_file());
        assert!(!drags().lock().unwrap().contains_key(&key));
        assert_eq!(
            std::fs::read(original).unwrap(),
            b"original remains unchanged"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_reference_icons_match_the_shared_file_identity_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/reference-file-types.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let item: library::StashItem = serde_json::from_value(json!({
                "id":"fixture", "title":"User edited title", "kind":case["kind"],
                "source":"", "excerpt":"", "tags":[], "createdAt":"2026-10-24",
                "origin":{"fileName":case["name"]}, "mimeType":case["mime"],
            }))
            .unwrap();
            assert_eq!(icon_kind(&item), case["visual"].as_str().unwrap(), "{case}");
        }
    }
    #[test]
    fn native_events_accept_only_known_actions_and_typed_arguments() {
        assert!(serde_json::from_value::<Event>(
            json!({"action":"search","session":"s","query":"中文","token":"q"})
        )
        .is_ok());
        for bad in [
            json!({"action":"execute","path":"/tmp/arbitrary"}),
            json!({"action":"copy","session":"s","id":"a","path":"/tmp/arbitrary"}),
            json!({"action":"prepareDrag","session":"s","id":1,"token":"q"}),
        ] {
            assert!(serde_json::from_value::<Event>(bad).is_err());
        }
    }
}
