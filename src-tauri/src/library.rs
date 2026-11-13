mod asset_paths;
mod bridge;
mod browser_capture;
pub(crate) mod native_host;
#[cfg(target_os = "macos")]
mod native_install;
mod chosen_files;
pub mod commands;
mod context;
pub mod file_payload;
mod legacy;
mod note_files;
mod originals;
pub mod preview_protocol;
mod search;
pub(crate) mod usage;
#[cfg(test)]
use bridge::json_response;
pub use bridge::start_extension_server;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;
use uuid::Uuid;

const INITIALIZED_KEY: &str = "library_initialized_v1";
const EXTENSION_IMPORT_LIMIT: usize = 500;

/// The shared library connection. A panic while it is held must not leave
/// every later command reporting "busy": SQLite stays usable (an open
/// transaction rolls back when it drops), so the lock is recovered.
pub(crate) struct LibraryConnection(Mutex<Connection>);
impl LibraryConnection {
    pub(crate) fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, std::convert::Infallible> {
        Ok(self.0.lock().unwrap_or_else(|poisoned| {
            self.0.clear_poison();
            poisoned.into_inner()
        }))
    }
}

pub struct LibraryState {
    pub(crate) connection: LibraryConnection,
    assets_dir: PathBuf,
    database_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub source: String,
    pub url: Option<String>,
    pub excerpt: String,
    pub tags: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub use_count: u64,
    #[serde(default)]
    pub favorite: bool,
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_status: Option<String>,
    pub asset_path: Option<String>,
    pub original_path: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub context_override: Option<String>,
    #[serde(default)]
    pub origin: Option<serde_json::Value>,
}

impl LibraryState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let registry = app.path().app_data_dir()?.join("library-root-v1.json");
        let root = std::env::var_os("STASHDOCK_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(app.path().app_data_dir()?);
        let registration =
            crate::library_location::locate(&root, &registry).map_err(std::io::Error::other)?;
        let root = crate::library_location::resolve(&registration.anchor)
            .map_err(std::io::Error::other)?;
        let assets_dir = root.join("assets");
        fs::create_dir_all(&assets_dir)?;

        let database_path = root.join("stashdock.sqlite3");
        let connection = Connection::open(&database_path)?;
        initialize_schema(&connection)?;
        asset_paths::repair_moved_backups(&connection, &assets_dir)
            .map_err(std::io::Error::other)?;
        legacy::remove_untouched_demo_references(&connection, &assets_dir)
            .map_err(std::io::Error::other)?;
        backfill_text_content(&connection).map_err(std::io::Error::other)?;
        note_files::migrate(&connection).map_err(std::io::Error::other)?;
        let executable = std::env::current_exe()?;
        crate::integrations::record(
            &connection,
            "desktop",
            env!("CARGO_PKG_VERSION"),
            Some(&executable.to_string_lossy()),
        )
        .map_err(std::io::Error::other)?;
        crate::library_location::mark_ready(registration, &registry)
            .map_err(std::io::Error::other)?;

        Ok(Self {
            connection: LibraryConnection(Mutex::new(connection)),
            assets_dir,
            database_path,
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }
}

fn initialize_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(include_str!("../../plugins/stashdock/server/schema.sql"))?;

    let columns = {
        let mut statement = connection.prepare("PRAGMA table_info(stash_items)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        columns.collect::<Result<Vec<_>, _>>()?
    };

    if !columns.iter().any(|column| column == "content") {
        connection.execute("ALTER TABLE stash_items ADD COLUMN content TEXT", [])?;
    }
    if !columns.iter().any(|column| column == "origin_json") {
        connection.execute("ALTER TABLE stash_items ADD COLUMN origin_json TEXT", [])?;
    }
    if !columns.iter().any(|column| column == "context_override") {
        connection.execute(
            "ALTER TABLE stash_items ADD COLUMN context_override TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "preview_version") {
        connection.execute(
            "ALTER TABLE stash_items ADD COLUMN preview_version INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    connection.execute_batch(include_str!("../../plugins/stashdock/server/preview-version.sql"))?;

    // One transaction: an interrupted upgrade must not leave the index half-built.
    let transaction = connection.unchecked_transaction()?;
    search::prepare_index(&transaction)?;
    transaction.commit()
}

#[cfg(test)]
pub(crate) fn install_search_index(connection: &Connection) -> rusqlite::Result<()> {
    search::prepare_index(connection)
}

fn backfill_text_content(connection: &Connection) -> Result<(), String> {
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT id, asset_path, mime_type
                 FROM stash_items
                 WHERE content IS NULL AND asset_path IS NOT NULL AND mime_type IS NOT NULL",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    // The search index follows content updates through its triggers.
    for (id, asset_path, mime_type) in candidates {
        let path = PathBuf::from(asset_path);
        if !path.is_file() {
            continue;
        }
        if let Some(content) = extract_text(&path, &mime_type)? {
            connection
                .execute(
                    "UPDATE stash_items SET content = ?1 WHERE id = ?2",
                    params![content, id],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn now() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| error.to_string())
}

fn upsert_item(connection: &Connection, item: &StashItem) -> Result<(), String> {
    let updated_at = now()?;
    let tags_json = serde_json::to_string(&item.tags).map_err(|error| error.to_string())?;
    let origin_json = item
        .origin
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO stash_items (
               id, title, kind, source, url, excerpt, tags_json, created_at,
               favorite, preview, asset_path, original_path, mime_type,
               size_bytes, content, origin_json, updated_at, context_override
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               kind = excluded.kind,
               source = excluded.source,
               url = excluded.url,
               excerpt = excluded.excerpt,
               tags_json = excluded.tags_json,
               created_at = excluded.created_at,
               favorite = excluded.favorite,
               preview = excluded.preview,
               asset_path = COALESCE(excluded.asset_path, stash_items.asset_path),
               original_path = COALESCE(excluded.original_path, stash_items.original_path),
               mime_type = COALESCE(excluded.mime_type, stash_items.mime_type),
               size_bytes = COALESCE(excluded.size_bytes, stash_items.size_bytes),
               content = COALESCE(excluded.content, stash_items.content),
               origin_json = COALESCE(excluded.origin_json, stash_items.origin_json),
               context_override = COALESCE(stash_items.context_override, excluded.context_override),
               updated_at = excluded.updated_at",
            params![
                item.id,
                item.title,
                item.kind,
                item.source,
                item.url,
                item.excerpt,
                tags_json,
                item.created_at,
                item.favorite as i64,
                item.preview,
                item.asset_path,
                item.original_path,
                item.mime_type,
                item.size_bytes.map(|value| value as i64),
                item.content,
                origin_json,
                updated_at,
                item.context_override,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Confirmed Replace writes the new capture, including removing a prior final
/// context or cover. Ordinary upserts deliberately preserve omitted fields.
fn replace_link_item(connection: &Connection, item: &StashItem) -> Result<(), String> {
    let url = item.url.as_deref().and_then(canonicalize_web_url)
        .ok_or("Use an http or https URL without credentials.")?;
    if !matches!(item.kind.as_str(), "web" | "repo") || item.title.trim().is_empty()
        || item.title.encode_utf16().count() > 500 || item.tags.len() > 12
        || item.tags.iter().any(|tag| tag_too_long(tag)) {
        return Err("Invalid page capture.".into());
    }
    let previous_url: Option<String> = connection.query_row(
        "SELECT url FROM stash_items WHERE id=?1", [&item.id], |row| row.get(0)
    ).optional().map_err(|error| error.to_string())?.flatten();
    if previous_url.as_deref().and_then(canonicalize_web_url).as_deref() != Some(url.as_str()) {
        return Err("The reference changed. Save the page again.".into());
    }
    let tags = serde_json::to_string(&item.tags).map_err(|error| error.to_string())?;
    let origin = serde_json::to_string(item.origin.as_ref().unwrap_or(&serde_json::json!({})))
        .map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE stash_items SET title=?1,kind=?2,source=?3,url=?4,excerpt=?5,tags_json=?6,
         content=?7,preview=?8,origin_json=?9,context_override=NULL,favorite=0,
         asset_path=NULL,original_path=NULL,mime_type=NULL,size_bytes=NULL,updated_at=?10 WHERE id=?11",
        params![item.title.trim(), item.kind, item.source, url, item.excerpt, tags,
            item.content.as_deref().unwrap_or(""), item.preview, origin, now()?, item.id]
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<StashItem> {
    let kind: String = row.get(2)?;
    let file = kind != "note";
    let tags_json: String = row.get(6)?;
    let size_bytes: Option<i64> = row.get(13)?;
    let origin_json: Option<String> = row.get(15)?;
    Ok(StashItem {
        id: row.get(0)?,
        title: row.get(1)?,
        kind,
        source: row.get(3)?,
        url: row.get(4)?,
        excerpt: row.get(5)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        created_at: row.get(7)?,
        use_count: 0,
        favorite: row.get::<_, i64>(8)? != 0,
        preview: row.get(9)?,
        preview_status: None,
        asset_path: if file { row.get(10)? } else { None },
        original_path: if file { row.get(11)? } else { None },
        mime_type: if file { row.get(12)? } else { None },
        size_bytes: size_bytes.filter(|_| file).map(|value| value.max(0) as u64),
        content: row.get(14)?,
        context_override: row.get(16)?,
        origin: origin_json.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

const ITEM_COLUMNS: &str = "id, title, kind, source, url, excerpt, tags_json,
    created_at, favorite, preview, asset_path, original_path,
    mime_type, size_bytes, content, origin_json, context_override";
// The shelf shows titles, covers and tags. Bodies and edited context are read
// by ID when the user opens, copies or edits a reference. Stored screenshots
// (often 100 KB or more) are not read either: only a version marker, which
// preview_protocol turns into the cover's URL.
const SHELF_COLUMNS: &str = "id, title, kind, source, url, excerpt, tags_json,
    created_at, favorite,
    CASE WHEN octet_length(preview) > 4096
      THEN 'stashdock-cover:' || preview_version || '-' || octet_length(preview)
      ELSE preview END,
    asset_path, original_path,
    mime_type, size_bytes, NULL, origin_json, NULL";

fn read_all(connection: &Connection, columns: &str) -> Result<Vec<StashItem>, String> {
    note_files::migrate(connection)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {columns} FROM stash_items ORDER BY created_at DESC, rowid"
        ))
        .map_err(|error| error.to_string())?;
    let mut items = statement
        .query_map([], row_to_item)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    usage::annotate(connection, &mut items)?;
    crate::web_preview::annotate(connection, &mut items).map_err(|error| error.to_string())?;
    Ok(items)
}

/// Every field, including bodies, for tests. Production reads use the shelf
/// list or `read_by_id`.
#[cfg(test)]
fn read_items(connection: &Connection) -> Result<Vec<StashItem>, String> {
    read_all(connection, ITEM_COLUMNS)
}

/// The library as the shelf shows it: no bodies or edited context.
fn read_shelf(connection: &Connection) -> Result<Vec<StashItem>, String> {
    let mut items = read_all(connection, SHELF_COLUMNS)?;
    usage::sort(connection, &mut items)?;
    Ok(items)
}

/// The listed references that still exist, in the given order. `full` adds
/// bodies and edited context after refreshing changed original files.
fn read_by_id(
    connection: &Connection,
    assets: &Path,
    ids: &[String],
    full: bool,
) -> Result<Vec<StashItem>, String> {
    if ids.len() > 500 {
        return Err("Read at most 500 references at a time.".into());
    }
    if full {
        note_files::migrate(connection)?;
    }
    let columns = if full { ITEM_COLUMNS } else { SHELF_COLUMNS };
    let mut query = connection
        .prepare(&format!("SELECT {columns} FROM stash_items WHERE id = ?1"))
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for id in ids {
        if full {
            // A changed original refreshes its backup and derived text first.
            let has_original: bool = connection
                .query_row("SELECT original_path IS NOT NULL AND asset_path IS NOT NULL FROM stash_items WHERE id=?1", [id], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(false);
            if has_original {
                let _ = originals::synchronize(connection, assets, id);
            }
        }
        if let Some(item) = query
            .query_row([id], row_to_item)
            .optional()
            .map_err(|e| e.to_string())?
        {
            items.push(item);
        }
    }
    usage::annotate(connection, &mut items)?;
    crate::web_preview::annotate(connection, &mut items).map_err(|error| error.to_string())?;
    Ok(items)
}

pub fn get_items(
    ids: Vec<String>,
    full: bool,
    state: &LibraryState,
) -> Result<Vec<StashItem>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    read_by_id(&connection, &state.assets_dir, &ids, full)
}

#[cfg(test)]
fn reference_drag_context(database: &Path, ids: &[String]) -> Result<String, String> {
    let connection = Connection::open(database).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    build_drag_context(&connection, ids)
}

#[cfg(test)]
fn build_drag_context(connection: &Connection, ids: &[String]) -> Result<String, String> {
    note_files::migrate(connection)?;
    build_selected_context(read_selected_items(connection, ids)?)
}

fn read_selected_items(connection: &Connection, ids: &[String]) -> Result<Vec<StashItem>, String> {
    let mut query = connection.prepare(
        "SELECT id, title, kind, source, url, excerpt, tags_json,
            created_at, favorite, NULL, asset_path, original_path,
            mime_type, size_bytes, content, origin_json, context_override FROM stash_items WHERE id = ?1"
    ).map_err(|e| e.to_string())?;
    ids.iter()
        .map(|id| {
            query
                .query_row([id], row_to_item)
                .map_err(|_| "A selected reference no longer exists.".to_string())
        })
        .collect()
}

/// Metadata and context come from one read transaction, not two racing queries.
pub(crate) fn reference_transfer_snapshot(
    database: &Path,
    ids: &[String],
) -> Result<Vec<StashItem>, String> {
    let connection =
        Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    note_files::migrate(&connection)?;
    // Send the current bytes of changed originals. A reference whose files are
    // both gone keeps its existing error path in the exporter.
    if let Some(assets) = database.parent().map(|root| root.join("assets")) {
        for id in ids {
            let _ = originals::synchronize(&connection, &assets, id);
        }
    }
    let tx = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let items = read_selected_items(&tx, ids)?;
    Ok(items)
}

pub(crate) fn reference_transfer_context(items: &[StashItem]) -> Result<String, String> {
    context::build(items)
}

pub(crate) fn native_reference_context(items: &[StashItem]) -> Result<String, String> {
    context::native(items)
}

#[cfg(test)]
fn build_selected_context(items: Vec<StashItem>) -> Result<String, String> {
    context::build(&items)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionImportRequest {
    items: Vec<StashItem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionImportResult {
    imported: usize,
    updated: usize,
    skipped: usize,
    total: usize,
}

fn truncate_text(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

/// Tag length is counted in UTF-16 code units, as the shared JavaScript
/// validators, input `maxLength` and MCP schemas count it, so a tag with emoji
/// is accepted or refused the same way in every host.
pub(crate) const TAG_LIMIT: usize = 48;
pub(crate) fn tag_too_long(tag: &str) -> bool {
    tag.encode_utf16().count() > TAG_LIMIT
}
fn truncate_tag(tag: &str) -> String {
    let mut units = 0;
    tag.trim()
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= TAG_LIMIT
        })
        .collect()
}

fn canonicalize_web_url(raw_url: &str) -> Option<String> {
    let mut parsed = Url::parse(raw_url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }

    parsed.set_fragment(None);
    let original_pairs = parsed.query_pairs().count();
    let kept_pairs = parsed
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !key.starts_with("utm_")
                && !matches!(
                    key.as_str(),
                    "fbclid" | "gclid" | "dclid" | "mc_cid" | "mc_eid" | "igshid"
                )
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if kept_pairs.len() != original_pairs {
        parsed.query_pairs_mut().clear().extend_pairs(kept_pairs);
    }
    if parsed.query() == Some("") {
        parsed.set_query(None);
    }

    if parsed.path().len() > 1 {
        let trimmed = parsed.path().trim_end_matches('/').to_string();
        parsed.set_path(&trimmed);
    }

    Some(parsed.into())
}

fn sanitize_preview(preview: Option<String>) -> Option<String> {
    preview.and_then(|preview| {
        let preview = preview.trim();
        if (preview.starts_with("https://") || preview.starts_with("http://"))
            && preview.chars().count() <= 4_000
        {
            return Some(preview.to_string());
        }
        let is_supported_data_image = preview.starts_with("data:image/jpeg;base64,")
            || preview.starts_with("data:image/png;base64,")
            || preview.starts_with("data:image/webp;base64,");
        (is_supported_data_image && preview.len() <= 750_000).then(|| preview.to_string())
    })
}

fn import_extension_items(
    connection: &mut Connection,
    items: Vec<StashItem>,
) -> Result<ExtensionImportResult, String> {
    if items.len() > EXTENSION_IMPORT_LIMIT {
        return Err(format!(
            "An extension import can contain at most {EXTENSION_IMPORT_LIMIT} items."
        ));
    }

    let total = items.len();
    let mut known_urls = {
        let mut statement = connection
            .prepare("SELECT id, url FROM stash_items WHERE url IS NOT NULL")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.filter_map(Result::ok)
            .filter_map(|(id, url)| canonicalize_web_url(&url).map(|url| (url, id)))
            .collect::<HashMap<_, _>>()
    };

    let imported_at = now()?;
    let mut accepted = Vec::new();
    let mut asset_updates = Vec::new();
    for mut item in items {
        let Some(canonical_url) = item.url.as_deref().and_then(canonicalize_web_url) else {
            continue;
        };
        item.preview = sanitize_preview(item.preview.take());
        let favicon = item
            .origin
            .as_ref()
            .and_then(|origin| origin.get("faviconUrl"))
            .and_then(|value| value.as_str())
            .filter(|value| value.len() <= 32_768)
            .and_then(|value| sanitize_preview(Some(value.to_string())));
        if let Some(existing_id) = known_urls.get(&canonical_url) {
            let captured = item
                .content
                .as_deref()
                .map(|value| truncate_text(value, 20_000))
                .filter(|value| !value.is_empty());
            let missing_body: bool = connection.query_row(
                "SELECT COALESCE(TRIM(content),'')='' AND context_override IS NULL FROM stash_items WHERE id=?1",
                [existing_id], |row| row.get(0),
            ).unwrap_or(false);
            let body = if missing_body { captured } else { None };
            if item.preview.is_some() || favicon.is_some() || body.is_some() {
                asset_updates.push((
                    existing_id.clone(),
                    item.preview.take(),
                    favicon,
                    body,
                    item.origin.take(),
                ));
            }
            continue;
        }

        let parsed = Url::parse(&canonical_url).map_err(|error| error.to_string())?;
        let platform = truncate_text(
            item.origin
                .as_ref()
                .and_then(|origin| origin.get("platform"))
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| parsed.host_str().unwrap_or("Web")),
            80,
        );
        let mut origin = item
            .origin
            .take()
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        origin["platform"] = serde_json::json!(platform);
        origin["importMethod"] = serde_json::json!("browser_extension");
        origin["externalId"] = serde_json::json!(canonical_url);
        origin["importedAt"] = serde_json::json!(imported_at);

        item.id = if item.id.trim().is_empty() || item.id.len() > 120 {
            format!("ext-{}", Uuid::new_v4())
        } else {
            truncate_text(&item.id, 120)
        };
        item.title = truncate_text(&item.title, 300);
        if item.title.is_empty() {
            item.title = parsed.host_str().unwrap_or("Saved page").to_string();
        }
        item.kind = if item.kind == "repo" { "repo" } else { "web" }.to_string();
        item.source = truncate_text(&item.source, 100);
        if item.source.is_empty() {
            item.source = platform.clone();
        }
        item.url = Some(canonical_url.clone());
        item.excerpt = truncate_text(&item.excerpt, 2_000);
        item.created_at = if item.created_at.trim().is_empty() {
            imported_at.clone()
        } else {
            truncate_text(&item.created_at, 64)
        };
        let mut known_tags = HashSet::new();
        item.tags = item
            .tags
            .into_iter()
            .map(|tag| truncate_tag(&tag))
            .filter(|tag| !tag.is_empty() && known_tags.insert(tag.to_lowercase()))
            .take(12)
            .collect();
        item.content = item.content.map(|content| truncate_text(&content, 20_000));
        item.context_override = None;
        item.asset_path = None;
        item.original_path = None;
        item.mime_type = None;
        item.size_bytes = None;
        item.origin = Some(origin);
        known_urls.insert(canonical_url, item.id.clone());
        accepted.push(item);
    }

    let imported = accepted.len();
    let updated = asset_updates.len();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for item in &accepted {
        upsert_item(&transaction, item)?;
    }
    for (id, preview, favicon, body, captured_origin) in &asset_updates {
        // Refresh identity without replacing the user's title, tags or origin.
        let (origin_json, next_preview) =
            if favicon.is_some() || body.is_some() || preview.is_some() {
                let stored: Option<String> = transaction
                    .query_row(
                        "SELECT origin_json FROM stash_items WHERE id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let mut origin = stored
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                    .filter(serde_json::Value::is_object)
                    .unwrap_or_else(|| serde_json::json!({}));
                let custom_cover = origin["previewSource"].as_str() == Some("custom");
                if let Some(favicon) = favicon {
                    origin["faviconUrl"] = serde_json::json!(favicon);
                }
                if let Some(captured) = captured_origin {
                    if body.is_some() {
                        for key in ["author", "publishedAt", "captureMethod", "truncated"] {
                            if let Some(value) = captured.get(key) {
                                origin[key] = value.clone();
                            }
                        }
                    }
                    if preview.is_some() && !custom_cover {
                        if let Some(value) = captured.get("previewKind") {
                            origin["previewKind"] = value.clone();
                        }
                    }
                }
                (
                    Some(origin.to_string()),
                    if custom_cover { None } else { preview.clone() },
                )
            } else {
                (None, preview.clone())
            };
        transaction
            .execute(
                "UPDATE stash_items SET preview = COALESCE(?1, preview), origin_json = COALESCE(?2, origin_json), updated_at = ?3, content = COALESCE(?5, content) WHERE id = ?4",
                params![next_preview, origin_json, imported_at, id, body],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;

    Ok(ExtensionImportResult {
        imported,
        updated,
        skipped: total.saturating_sub(imported + updated),
        total,
    })
}

fn delete_item_by_id(connection: &mut Connection, id: &str) -> Result<bool, String> {
    Ok(delete_items_by_id(connection, &[id.to_string()])? > 0)
}

fn delete_items_by_id(connection: &mut Connection, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty()
        || ids.len() > 10_000
        || ids.iter().any(|id| id.trim().is_empty() || id.len() > 120)
    {
        return Err("Select between 1 and 10,000 valid references.".into());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut deleted = 0;
    let mut backups = Vec::new();
    {
        let mut asset = transaction
            .prepare("SELECT asset_path FROM stash_items WHERE id = ?1 AND COALESCE(asset_path,'') != ''")
            .map_err(|error| error.to_string())?;
        let mut items = transaction
            .prepare("DELETE FROM stash_items WHERE id = ?1")
            .map_err(|error| error.to_string())?;
        for id in ids.iter().collect::<HashSet<_>>() {
            if let Some(path) = asset
                .query_row([id], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|error| error.to_string())?
            {
                backups.push(path);
            }
            deleted += items.execute([id]).map_err(|error| error.to_string())?;
        }
        // Another reference may share a backup (for example an old duplicate).
        let mut shared = transaction
            .prepare("SELECT 1 FROM stash_items WHERE asset_path = ?1 LIMIT 1")
            .map_err(|error| error.to_string())?;
        backups.retain(|path| !shared.exists([path]).unwrap_or(true));
    }
    transaction.commit().map_err(|error| error.to_string())?;
    remove_backups(connection, &backups);
    Ok(deleted)
}

/// Deleting a reference removes StashDock's managed copy, never the user's
/// original file. Only paths inside the library's assets folder are touched.
fn remove_backups(connection: &Connection, paths: &[String]) {
    let Some(assets) = connection
        .path()
        .filter(|path| !path.is_empty() && *path != ":memory:")
        .and_then(|path| Path::new(path).parent().map(|root| root.join("assets")))
    else {
        return;
    };
    let Ok(root) = assets.canonicalize() else {
        return;
    };
    for raw in paths {
        let Ok(path) = file_payload::managed_asset_path(&assets, raw) else {
            continue;
        };
        if fs::remove_file(&path).is_ok() {
            // Desktop imports keep each backup in its own folder; drop it when empty.
            if let Some(parent) = path.parent().filter(|parent| *parent != root.as_path()) {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}

/// Ordered IDs matching every query term; see `library/search.rs`.
pub fn search_items(query: String, state: &LibraryState) -> Result<Vec<String>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    note_files::migrate(&connection)?;
    match search::search_ids(&connection, &query)? {
        Some(ids) => Ok(ids),
        None => connection
            .prepare("SELECT id FROM stash_items ORDER BY created_at DESC, rowid")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| error.to_string()),
    }
}

pub fn initialize_library(items: Vec<StashItem>, state: &LibraryState) -> Result<(), String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    let initialized = connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            [INITIALIZED_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();

    if !initialized {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for item in &items {
            upsert_item(&transaction, item)?;
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, ?2)",
                params![INITIALIZED_KEY, now()?],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub fn save_items(items: Vec<StashItem>, state: &LibraryState) -> Result<(), String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for item in &items {
        upsert_item(&transaction, item)?;
    }
    note_files::migrate(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn replace_saved_link(item: StashItem, state: &LibraryState) -> Result<(), String> {
    let mut connection = state.connection.lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    replace_link_item(&transaction, &item)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn list_items(state: &LibraryState) -> Result<Vec<StashItem>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    read_shelf(&connection)
}

fn update_favorite(connection: &Connection, id: &str, favorite: bool) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE stash_items SET favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i64, now()?, id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("This reference no longer exists.".to_string());
    }
    Ok(())
}

pub fn set_item_favorite(id: String, favorite: bool, state: &LibraryState) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    update_favorite(&connection, &id, favorite)
}

pub fn delete_item(id: String, state: &LibraryState) -> Result<bool, String> {
    if id.trim().is_empty() || id.len() > 120 {
        return Err("The item id is invalid.".to_string());
    }
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    delete_item_by_id(&mut connection, &id)
}

pub fn delete_items(ids: Vec<String>, state: &LibraryState) -> Result<usize, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    delete_items_by_id(&mut connection, &ids)
}

fn clean_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 12 {
        return Err("Use at most 12 tags.".into());
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag_too_long(tag) {
            return Err("Use at most 12 tags, each up to 48 characters.".into());
        }
        if !tag.is_empty() && seen.insert(tag.to_lowercase()) {
            result.push(tag.to_string());
        }
    }
    Ok(result)
}

fn edit_metadata(
    connection: &Connection,
    id: &str,
    title: &str,
    tags: Vec<String>,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 500 {
        return Err("Use a title between 1 and 500 characters.".into());
    }
    let tags = clean_tags(tags)?;
    let changed = connection
        .execute(
            "UPDATE stash_items SET title=?1, tags_json=?2, updated_at=?3,origin_json=CASE WHEN json_valid(origin_json) THEN json_remove(origin_json,'$.pendingTitle') ELSE origin_json END WHERE id=?4",
            params![
                title,
                serde_json::to_string(&tags).map_err(|e| e.to_string())?,
                now()?,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("This reference no longer exists.".into());
    }
    Ok(())
}

pub fn edit_item(
    id: String,
    title: String,
    tags: Vec<String>,
    cover: Option<CoverEdit>,
    state: &LibraryState,
) -> Result<Vec<StashItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    edit_metadata(&transaction, &id, &title, tags)?;
    if let Some(cover) = cover {
        edit_cover(&transaction, &state.assets_dir, &id, cover)?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    read_shelf(&connection)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverEdit {
    pub preview: Option<String>,
}

fn edit_cover(
    connection: &Connection,
    assets: &Path,
    id: &str,
    cover: CoverEdit,
) -> Result<(), String> {
    let (kind, asset, origin): (String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT kind,asset_path,origin_json FROM stash_items WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "This reference no longer exists.")?;
    let mut origin: serde_json::Value = origin
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .filter(|value: &serde_json::Value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let preview = if let Some(value) = cover.preview {
        let prepared = crate::reference_cover::from_data_url(&value)?;
        origin["previewKind"] = serde_json::json!("cover");
        origin["previewSource"] = serde_json::json!("custom");
        Some(prepared)
    } else {
        origin.as_object_mut().unwrap().remove("previewKind");
        origin.as_object_mut().unwrap().remove("previewSource");
        // Never accept a user-supplied path. Restore from the original managed asset only.
        let restored = if kind == "image" {
            asset
                .as_deref()
                .and_then(|raw| file_payload::managed_path(assets, raw).ok())
                .filter(|path| {
                    path.metadata()
                        .is_ok_and(|metadata| metadata.len() <= 5_000_000)
                })
                .and_then(|path| fs::read(path).ok())
                .and_then(|bytes| crate::web_images::cover(&bytes).ok())
        } else {
            None
        };
        if connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name='web_preview_jobs'",
                [],
                |_| Ok(()),
            )
            .is_ok()
        {
            connection
                .execute("DELETE FROM web_preview_jobs WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        }
        restored
    };
    connection
        .execute(
            "UPDATE stash_items SET preview=?1,origin_json=?2 WHERE id=?3",
            params![preview, origin.to_string(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn edit_content(connection: &Connection, id: &str, content: &str) -> Result<(), String> {
    if content.encode_utf16().count() > 200_000 {
        return Err("Use at most 200,000 characters.".into());
    }
    let changed = connection
        .execute(
            "UPDATE stash_items SET context_override=?1, updated_at=?2 WHERE id=?3",
            params![content, now()?, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("This reference no longer exists.".into());
    }
    Ok(())
}

pub fn edit_item_content(
    id: String,
    content: String,
    state: &LibraryState,
) -> Result<Vec<StashItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    edit_content(&transaction, &id, &content)?;
    transaction.commit().map_err(|e| e.to_string())?;
    read_shelf(&connection)
}

fn change_tag(
    connection: &mut Connection,
    name: &str,
    replacement: Option<&str>,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Choose a tag to change.".into());
    }
    let replacement = replacement.map(str::trim);
    if replacement.is_some_and(str::is_empty) {
        return Err("Enter a tag name.".into());
    }
    if let Some(value) = replacement {
        clean_tags(vec![value.to_string()])?;
    }
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for item in read_shelf(&transaction)? {
        if !item
            .tags
            .iter()
            .any(|tag| tag.to_lowercase() == name.to_lowercase())
        {
            continue;
        }
        let tags = item
            .tags
            .into_iter()
            .flat_map(|tag| {
                if tag.to_lowercase() == name.to_lowercase() {
                    replacement.map(str::to_string)
                } else {
                    Some(tag)
                }
            })
            .collect();
        // Only the current title/tags are written; unrelated fields are untouched.
        edit_metadata(&transaction, &item.id, &item.title, tags)?;
    }
    let pins = read_pinned_tags(&transaction)?
        .into_iter()
        .flat_map(|tag| {
            if tag.to_lowercase() == name.to_lowercase() {
                replacement.map(str::to_string)
            } else {
                Some(tag)
            }
        })
        .collect();
    write_pinned_tags(&transaction, pins)?;
    transaction.commit().map_err(|e| e.to_string())
}

const PINNED_TAGS_KEY: &str = "desktop_pinned_tags_v1";

fn read_pinned_tags(connection: &Connection) -> Result<Vec<String>, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM app_meta WHERE key=?1",
            [PINNED_TAGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    value
        .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .unwrap_or(Ok(Vec::new()))
}

fn write_pinned_tags(connection: &Connection, tags: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let tags: Vec<String> = tags
        .into_iter()
        .filter(|tag| seen.insert(tag.to_lowercase()))
        .collect();
    connection
        .execute(
            "INSERT OR REPLACE INTO app_meta (key,value) VALUES (?1,?2)",
            params![
                PINNED_TAGS_KEY,
                serde_json::to_string(&tags).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(tags)
}

fn pin_tag(connection: &mut Connection, name: &str, pinned: bool) -> Result<Vec<String>, String> {
    let name = clean_tags(vec![name.to_string()])?
        .into_iter()
        .next()
        .ok_or("Choose a tag to pin.")?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let canonical = read_shelf(&transaction)?
        .into_iter()
        .flat_map(|item| item.tags)
        .find(|tag| tag.to_lowercase() == name.to_lowercase());
    if pinned && canonical.is_none() {
        return Err("This tag no longer exists. Refresh the library.".into());
    }
    let mut tags = read_pinned_tags(&transaction)?;
    tags.retain(|tag| tag.to_lowercase() != name.to_lowercase());
    if pinned {
        tags.push(canonical.unwrap_or(name));
    }
    let tags = write_pinned_tags(&transaction, tags)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(tags)
}

pub fn list_pinned_tags(state: &LibraryState) -> Result<Vec<String>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    read_pinned_tags(&connection)
}

pub fn set_tag_pinned(
    name: String,
    pinned: bool,
    state: &LibraryState,
) -> Result<Vec<String>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    pin_tag(&mut connection, &name, pinned)
}

pub fn change_library_tag(
    name: String,
    replacement: Option<String>,
    state: &LibraryState,
) -> Result<Vec<StashItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "The local library is busy.".to_string())?;
    change_tag(&mut connection, &name, replacement.as_deref())?;
    read_shelf(&connection)
}

fn file_kind(path: &Path) -> (&'static str, &'static str) {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" => ("file", "video/mp4"),
        "mov" => ("file", "video/quicktime"),
        "webm" => ("file", "video/webm"),
        "avi" => ("file", "video/x-msvideo"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        "pdf" => ("pdf", "application/pdf"),
        "docx" => (
            "file",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        "doc" => ("file", "application/msword"),
        "xlsx" => (
            "file",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "pptx" => (
            "file",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        "md" | "mdx" => ("file", "text/markdown"),
        "txt" | "log" => ("file", "text/plain"),
        "json" => ("file", "application/json"),
        "csv" => ("file", "text/csv"),
        "toml" => ("file", "text/x-toml"),
        "yaml" | "yml" => ("file", "text/yaml"),
        "xml" => ("file", "application/xml"),
        "html" | "htm" => ("file", "text/html"),
        "css" => ("file", "text/css"),
        "js" | "mjs" | "cjs" => ("file", "text/javascript"),
        "ts" | "tsx" => ("file", "text/typescript"),
        "jsx" => ("file", "text/jsx"),
        "rs" => ("file", "text/x-rust"),
        "py" => ("file", "text/x-python"),
        "go" => ("file", "text/x-go"),
        "java" => ("file", "text/x-java-source"),
        "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" => ("file", "text/x-c"),
        "sql" => ("file", "text/x-sql"),
        "sh" | "bash" => ("file", "text/x-shellscript"),
        "ps1" => ("file", "text/x-powershell"),
        _ => ("file", "application/octet-stream"),
    }
}

fn is_text_mime(mime_type: &str) -> bool {
    mime_type.starts_with("text/")
        || matches!(
            mime_type,
            "application/json" | "application/xml" | "image/svg+xml"
        )
}

fn extract_text(path: &Path, mime_type: &str) -> Result<Option<String>, String> {
    if !is_text_mime(mime_type) {
        return Ok(None);
    }

    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let content = String::from_utf8_lossy(&bytes)
        .chars()
        .take(200_000)
        .collect::<String>();
    let content = content.trim().to_string();
    Ok((!content.is_empty()).then_some(content))
}

fn text_excerpt(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

fn format_size(size: u64) -> String {
    if size >= 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    } else if size >= 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else {
        format!("{size} B")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        backfill_text_content, canonicalize_web_url, clean_tags, delete_item_by_id, file_kind,
        format_size, import_extension_items, initialize_schema, json_response, read_by_id,
        read_items, read_shelf, search, truncate_tag, update_favorite, upsert_item, StashItem,
    };
    use rusqlite::{params, Connection};
    use std::{fs, path::Path};
    use uuid::Uuid;

    fn reference_fixture() -> StashItem {
        serde_json::from_value(serde_json::json!({
            "id": "fixture", "title": "Reference", "kind": "web", "source": "Test",
            "excerpt": "Saved reference", "tags": ["Test"], "createdAt": "2026-10-01T00:00:00Z",
            "content": "searchablebody", "preview": "data:image/png;base64,dGVzdA=="
        }))
        .expect("reference fixture")
    }

    #[test]
    fn a_panic_while_holding_the_library_does_not_block_later_commands() {
        let shared = std::sync::Arc::new(super::LibraryConnection(std::sync::Mutex::new(
            Connection::open_in_memory().unwrap(),
        )));
        let held = shared.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("simulated failure while holding the library");
        })
        .join();
        let connection = shared.lock().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn tag_length_counts_utf16_units_like_every_javascript_host() {
        let fits = "😀".repeat(24); // 48 UTF-16 units, 24 characters
        assert_eq!(clean_tags(vec![fits.clone()]).unwrap(), vec![fits.clone()]);
        assert!(clean_tags(vec!["😀".repeat(25)]).is_err());
        assert!(clean_tags(vec!["a".repeat(49)]).is_err());
        assert_eq!(
            truncate_tag(&"😀".repeat(30)),
            fits,
            "never splits a character"
        );
    }
    #[test]
    fn the_shelf_omits_bodies_and_reads_them_by_id_on_demand() {
        let root = std::env::temp_dir().join(format!("stashdock-shelf-{}", Uuid::new_v4()));
        let assets = root.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        for (id, created) in [("a", "2026-01-02T00:00:00Z"), ("b", "2026-01-01T00:00:00Z")] {
            connection.execute("INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,content,context_override,updated_at) VALUES(?1,?1,'web','example.org','Short','[\"Tag\"]',?2,'Long body','My context','now')", params![id, created]).unwrap();
        }
        let shelf = read_shelf(&connection).unwrap();
        assert_eq!(
            shelf
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(shelf
            .iter()
            .all(|item| item.content.is_none() && item.context_override.is_none()));
        assert_eq!(
            (shelf[0].excerpt.as_str(), shelf[0].tags.clone()),
            ("Short", vec!["Tag".to_string()])
        );
        let ids = vec!["b".to_string(), "missing".to_string(), "a".to_string()];
        let compact = read_by_id(&connection, &assets, &ids, false).unwrap();
        assert_eq!(
            compact
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"],
            "missing references are left out, order kept"
        );
        assert!(compact[0].content.is_none());
        let full = read_by_id(&connection, &assets, &ids, true).unwrap();
        assert_eq!(
            (
                full[0].content.as_deref(),
                full[0].context_override.as_deref()
            ),
            (Some("Long body"), Some("My context"))
        );
        assert!(read_by_id(&connection, &assets, &vec!["a".to_string(); 501], false).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn favorite_updates_do_not_rewrite_content_preview_or_search_index() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        let changes = connection.total_changes();
        update_favorite(&connection, &item.id, true).unwrap();
        assert_eq!(connection.total_changes() - changes, 1);
        let stored = read_items(&connection).unwrap();
        assert!(stored[0].favorite);
        assert_eq!(stored[0].preview, item.preview);
        assert_eq!(stored[0].content, item.content);
        assert!(update_favorite(&connection, "deleted-item", true).is_err());
        assert_eq!(read_items(&connection).unwrap().len(), 1);
    }

    #[test]
    fn metadata_edits_preserve_content_and_update_fts() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        update_favorite(&connection, &item.id, true).unwrap();
        super::edit_metadata(
            &connection,
            &item.id,
            "Renamed reference",
            vec!["Newtag".into(), "newtag".into()],
        )
        .unwrap();
        let saved = &read_items(&connection).unwrap()[0];
        assert_eq!(saved.title, "Renamed reference");
        assert_eq!(saved.tags, vec!["Newtag"]);
        assert_eq!(saved.content, item.content);
        assert_eq!(saved.preview, item.preview);
        assert!(saved.favorite);
        let matches: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'Newtag'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(matches, 1);
        assert!(super::edit_metadata(&connection, "missing", "Valid", vec![]).is_err());
    }

    #[test]
    fn content_edits_update_authoritative_drag_and_fts_without_touching_metadata() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        let body = "\n# Edited context\n\n  Keep indentation\nnewbodytoken";
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        super::edit_content(&tx, &item.id, body).unwrap();
        tx.commit().unwrap();
        let saved = &read_items(&connection).unwrap()[0];
        assert_eq!(saved.context_override.as_deref(), Some(body));
        assert_eq!(saved.content, item.content);
        assert_eq!(saved.excerpt, item.excerpt);
        assert_eq!(saved.title, item.title);
        assert_eq!(saved.tags, item.tags);
        assert_eq!(saved.url, item.url);
        assert_eq!(saved.preview, item.preview);
        assert_eq!(saved.asset_path, item.asset_path);
        assert_eq!(saved.favorite, item.favorite);
        let drag = super::build_drag_context(&connection, &[item.id.clone()]).unwrap();
        assert_eq!(drag, body);
        assert!(!drag.contains("searchablebody"));
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'newbodytoken'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let old: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'searchablebody'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);
        super::edit_content(&connection, &item.id, "").unwrap();
        let cleared = &read_items(&connection).unwrap()[0];
        assert_eq!(cleared.context_override.as_deref(), Some(""));
        assert_eq!(cleared.content, item.content);
        assert_eq!(
            super::build_drag_context(&connection, &[item.id.clone()]).unwrap(),
            ""
        );
    }

    #[test]
    fn cover_edits_are_atomic_and_restore_without_changing_context_or_identity() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        super::edit_content(&connection, &item.id, "Extra context").unwrap();
        let image = image::DynamicImage::new_rgb8(64, 40);
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let preview = crate::web_images::cover(&bytes).unwrap();
        super::edit_cover(
            &connection,
            Path::new("unused"),
            &item.id,
            super::CoverEdit {
                preview: Some(preview.clone()),
            },
        )
        .unwrap();
        super::edit_metadata(&connection, &item.id, "Title only", vec!["UI".into()]).unwrap();
        let selected = read_items(&connection).unwrap().remove(0);
        assert!(selected
            .preview
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert_eq!(selected.origin.unwrap()["previewSource"], "custom");
        {
            let tx = connection.transaction().unwrap();
            super::edit_metadata(&tx, &item.id, "Must roll back", vec![]).unwrap();
            assert!(super::edit_cover(
                &tx,
                Path::new("unused"),
                &item.id,
                super::CoverEdit {
                    preview: Some("data:image/png;base64,aHRtbA==".into())
                }
            )
            .is_err());
        }
        assert_eq!(read_items(&connection).unwrap()[0].title, "Title only");
        connection.execute_batch("CREATE TABLE web_preview_jobs(id TEXT,url TEXT,status TEXT); INSERT INTO web_preview_jobs VALUES('fixture','https://example.org','done');").unwrap();
        super::edit_cover(
            &connection,
            Path::new("unused"),
            &item.id,
            super::CoverEdit { preview: None },
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM web_preview_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let restored = read_items(&connection).unwrap().remove(0);
        assert!(restored.preview.is_none());
        assert!(restored.origin.unwrap().get("previewSource").is_none());
        assert_eq!(restored.content, item.content);
        assert_eq!(restored.context_override.as_deref(), Some("Extra context"));
        assert_eq!(restored.url, item.url);
        assert_eq!(restored.asset_path, item.asset_path);
        assert!(super::edit_cover(
            &connection,
            Path::new("unused"),
            "missing",
            super::CoverEdit {
                preview: Some(preview)
            }
        )
        .is_err());
    }

    #[test]
    fn default_image_cover_comes_only_from_unchanged_managed_original() {
        let root =
            std::env::temp_dir().join(format!("stashdock-cover-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("original.png");
        let mut bytes = Vec::new();
        image::DynamicImage::new_rgb8(64, 40)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        fs::write(&path, &bytes).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut item = reference_fixture();
        item.kind = "image".into();
        item.asset_path = Some(path.to_string_lossy().into_owned());
        upsert_item(&connection, &item).unwrap();
        super::edit_cover(
            &connection,
            &root,
            &item.id,
            super::CoverEdit { preview: None },
        )
        .unwrap();
        assert!(read_items(&connection).unwrap()[0]
            .preview
            .as_ref()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // A DB entry outside the managed root is not a file-reading capability.
        super::edit_cover(
            &connection,
            &root.join("missing"),
            &item.id,
            super::CoverEdit { preview: None },
        )
        .unwrap();
        assert!(read_items(&connection).unwrap()[0].preview.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn content_edit_failure_rolls_back_and_unicode_limits_match_the_browser() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        assert!(super::edit_content(&connection, "missing", "body").is_err());
        assert!(super::edit_content(&connection, &item.id, &"x".repeat(200_001)).is_err());
        assert!(super::edit_content(&connection, &item.id, &"😀".repeat(100_001)).is_err());
        {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            tx.execute("DROP TABLE stash_fts", []).unwrap();
            assert!(super::edit_content(&tx, &item.id, "notcommitted").is_err());
        }
        assert_eq!(read_items(&connection).unwrap()[0].content, item.content);
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'searchablebody'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn native_export_matches_the_complete_default_editor_markdown() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item: StashItem = serde_json::from_value(serde_json::json!({
            "id": "context", "title": "CS 168", "kind": "web", "source": "sp26.cs168.io", "url": "https://sp26.cs168.io/?",
            "excerpt": "Excerpt", "content": "Intro to the Internet", "tags": ["Course"], "createdAt": "2026-10-10",
            "origin": { "platform": "sp26.cs168.io", "author": "Berkeley", "folderPath": ["Courses", "Networking"], "savedAt": "2026-10-10" }
        })).unwrap();
        upsert_item(&connection, &item).unwrap();
        assert_eq!(super::build_drag_context(&connection, &[item.id]).unwrap(), "# StashDock context\n\n## CS 168\nURL: https://sp26.cs168.io/?\nAuthor: Berkeley\nTags: Course\n\n### Saved content\nIntro to the Internet");
    }

    #[test]
    fn ai_context_provenance_survives_native_transfer_and_final_edits_remain_verbatim() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut item = reference_fixture();
        item.id = "ai-context".into();
        item.title = "Review checklist".into();
        item.kind = "note".into();
        item.source = "AI conversation".into();
        item.url = None;
        item.content = Some("Check keyboard behavior.".into());
        item.tags = vec!["Design".into()];
        item.origin = Some(
            serde_json::json!({"platform":"AI conversation","importMethod":"ai_context","contentOrigin":"generated","sourceUrls":["https://example.org/guide"]}),
        );
        upsert_item(&connection, &item).unwrap();
        assert_eq!(super::build_drag_context(&connection, &[item.id.clone()]).unwrap(), "# StashDock context\n\n## Review checklist\nContent origin: AI-generated\nSources: https://example.org/guide\nTags: Design\n\n### Note text\nCheck keyboard behavior.");
        item.context_override = Some("  User's final context\n".into());
        upsert_item(&connection, &item).unwrap();
        assert_eq!(
            super::build_drag_context(&connection, &[item.id]).unwrap(),
            "  User's final context\n"
        );
    }

    #[test]
    fn native_batch_override_order_and_long_unicode_are_verbatim() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut a = reference_fixture();
        a.context_override = Some(format!(
            "# StashDock context\n\n## Edited\n{}",
            "😀".repeat(25_000)
        ));
        let mut b = a.clone();
        b.id = "second".into();
        b.context_override = Some("Final B".into());
        upsert_item(&connection, &a).unwrap();
        upsert_item(&connection, &b).unwrap();
        assert_eq!(
            super::build_drag_context(&connection, &[a.id.clone()]).unwrap(),
            a.context_override.clone().unwrap()
        );
        assert_eq!(
            super::build_drag_context(&connection, &[b.id, a.id]).unwrap(),
            format!(
                "# StashDock context\n\nFinal B\n\n---\n\n## Edited\n{}",
                "😀".repeat(25_000)
            )
        );
    }

    #[test]
    fn tag_changes_are_atomic_and_deduplicate_without_deleting_references() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut a = reference_fixture();
        a.tags = vec!["Test".into(), "Other".into()];
        let mut b = a.clone();
        b.id = "b".into();
        upsert_item(&connection, &a).unwrap();
        upsert_item(&connection, &b).unwrap();
        assert!(super::change_tag(&mut connection, "Test", Some(&"x".repeat(49))).is_err());
        assert_eq!(read_items(&connection).unwrap()[0].tags, a.tags);
        super::change_tag(&mut connection, "test", Some("other")).unwrap();
        assert!(read_items(&connection)
            .unwrap()
            .iter()
            .all(|item| item.tags.len() == 1));
        super::change_tag(&mut connection, "OTHER", None).unwrap();
        let saved = read_items(&connection).unwrap();
        assert_eq!(saved.len(), 2);
        assert!(saved
            .iter()
            .all(|item| item.tags.is_empty() && item.content == a.content));
    }

    #[test]
    fn pinned_tags_survive_reads_and_follow_rename_remove_atomically() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut item = reference_fixture();
        item.tags.push("Other".into());
        upsert_item(&connection, &item).unwrap();
        assert!(super::read_pinned_tags(&connection).unwrap().is_empty());
        assert_eq!(
            super::pin_tag(&mut connection, "test", true).unwrap(),
            vec!["Test"]
        );
        assert_eq!(
            super::pin_tag(&mut connection, "TEST", true).unwrap(),
            vec!["Test"]
        );
        super::pin_tag(&mut connection, "Other", true).unwrap();
        assert!(super::change_tag(&mut connection, "Test", Some(&"x".repeat(49))).is_err());
        assert_eq!(
            super::read_pinned_tags(&connection).unwrap(),
            vec!["Test", "Other"]
        );
        super::change_tag(&mut connection, "Test", Some("other")).unwrap();
        assert_eq!(super::read_pinned_tags(&connection).unwrap(), vec!["other"]);
        super::change_tag(&mut connection, "other", None).unwrap();
        assert!(super::read_pinned_tags(&connection).unwrap().is_empty());
        let saved = read_items(&connection).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].content, item.content);
    }

    #[test]
    fn pinning_unknown_tags_fails_without_changing_records() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        assert!(super::pin_tag(&mut connection, "missing", true).is_err());
        assert!(super::read_pinned_tags(&connection).unwrap().is_empty());
        super::pin_tag(&mut connection, "Test", true).unwrap();
        assert!(super::pin_tag(&mut connection, "Test", false)
            .unwrap()
            .is_empty());
        let saved = read_items(&connection).unwrap();
        assert_eq!(saved[0].title, item.title);
        assert_eq!(saved[0].tags, item.tags);
    }

    #[test]
    fn native_drag_exports_authoritative_content_in_selection_order() {
        let database = std::env::temp_dir().join(format!(
            "stashdock-drag-test-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let connection = Connection::open(&database).unwrap();
        initialize_schema(&connection).unwrap();
        let mut a = reference_fixture();
        a.id = "a".into();
        a.title = "First reference".into();
        let mut b = reference_fixture();
        b.id = "b".into();
        b.title = "Second reference".into();
        b.content = Some("Full saved body not exposed in sidebar JSON".into());
        upsert_item(&connection, &a).unwrap();
        upsert_item(&connection, &b).unwrap();
        let changes = connection.total_changes();
        let context = super::reference_drag_context(&database, &["b".into(), "a".into()]).unwrap();
        assert!(
            context.find("Second reference").unwrap() < context.find("First reference").unwrap()
        );
        assert!(context.contains("Full saved body not exposed in sidebar JSON"));
        assert!(!context.contains("data:image/png"));
        #[cfg(windows)]
        {
            use crate::reference_drag::{export_reference_file, ExportKind};
            let ids = ["b".into(), "a".into()];
            let dragged = export_reference_file(&database, &ids, ExportKind::Drag).unwrap();
            let copied = export_reference_file(&database, &ids, ExportKind::Clipboard).unwrap();
            assert_eq!(
                std::fs::read_to_string(dragged.context_file().unwrap()).unwrap(),
                context
            );
            assert_eq!(
                std::fs::read(copied.context_file().unwrap()).unwrap(),
                std::fs::read(dragged.context_file().unwrap()).unwrap()
            );
            assert_ne!(copied.context_file().unwrap().parent(), dragged.context_file().unwrap().parent());
            crate::reference_transfer::discard(&copied);
            crate::reference_transfer::discard(&dragged);
        }
        assert_eq!(connection.total_changes(), changes);
        assert!(super::reference_drag_context(&database, &["missing".into()]).is_err());
        drop(connection);
        std::fs::remove_file(database).unwrap();
    }

    #[test]
    fn partial_upsert_indexes_the_preserved_body() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut item = reference_fixture();
        upsert_item(&connection, &item).unwrap();
        item.content = None;
        upsert_item(&connection, &item).unwrap();
        let matches: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'searchablebody'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(matches, 1);
    }

    #[test]
    fn reopening_schema_does_not_rebuild_an_initialized_search_index() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        upsert_item(&connection, &reference_fixture()).unwrap();
        let changes = connection.total_changes();
        initialize_schema(&connection).unwrap();
        assert_eq!(connection.total_changes(), changes);
        assert_eq!(read_items(&connection).unwrap().len(), 1);
    }

    #[test]
    fn recognizes_supported_file_types() {
        assert_eq!(file_kind(Path::new("notes.MD")), ("file", "text/markdown"));
        assert_eq!(
            file_kind(Path::new("paper.pdf")),
            ("pdf", "application/pdf")
        );
        assert_eq!(file_kind(Path::new("shot.webp")), ("image", "image/webp"));
    }

    #[test]
    fn formats_file_sizes() {
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(2048), "2.0 KB");
        assert_eq!(format_size(2 * 1024 * 1024), "2.0 MB");
    }

    #[test]
    fn stores_and_reads_an_item() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&connection).expect("create schema");
        let item = StashItem {
            id: "test-item".into(),
            title: "SQLite round trip".into(),
            kind: "note".into(),
            source: "Test".into(),
            url: None,
            excerpt: "Stored locally".into(),
            tags: vec!["SQLite".into(), "Local".into()],
            created_at: "2026-10-01T00:00:00Z".into(),
            use_count: 0,
            favorite: true,
            preview: Some("data:image/jpeg;base64,dGVzdA==".into()),
            preview_status: None,
            asset_path: None,
            original_path: None,
            mime_type: None,
            size_bytes: None,
            content: Some("This body is indexed by FTS5.".into()),
            context_override: None,
            origin: Some(serde_json::json!({
                "platform": "Test source",
                "importMethod": "manual_url",
                "importedAt": "2026-10-01T00:00:00Z"
            })),
        };

        upsert_item(&connection, &item).expect("save item");
        let stored = read_items(&connection).expect("read items");
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].preview.as_deref(),
            Some("data:image/jpeg;base64,dGVzdA==")
        );
        assert_eq!(stored[0].title, item.title);
        assert_eq!(stored[0].tags, item.tags);
        assert!(stored[0].favorite);
        assert_eq!(stored[0].content, item.content);
        assert_eq!(stored[0].origin, item.origin);
    }

    #[test]
    fn canonicalizes_extension_urls_before_deduplication() {
        assert_eq!(
            canonicalize_web_url("https://example.com/story/?utm_source=x&id=42#reply").as_deref(),
            Some("https://example.com/story?id=42")
        );
        assert!(canonicalize_web_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn allows_extension_private_network_preflights() {
        let response = json_response(
            "{}",
            204,
            Some("chrome-extension://stashdock-regression-test"),
        );
        let header_value = |name: &'static str| {
            response
                .headers()
                .iter()
                .find(|header| header.field.equiv(name))
                .map(|header| header.value.as_str().to_string())
        };

        assert_eq!(
            header_value("Access-Control-Allow-Origin").as_deref(),
            Some("chrome-extension://stashdock-regression-test")
        );
        assert_eq!(
            header_value("Access-Control-Allow-Private-Network").as_deref(),
            Some("true")
        );
    }

    #[test]
    fn imports_extension_items_and_skips_existing_urls() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&connection).expect("create schema");
        let make_item = |id: &str, url: &str| StashItem {
            id: id.into(),
            title: "Saved article".into(),
            kind: "web".into(),
            source: "Example".into(),
            url: Some(url.into()),
            excerpt: "Captured from a signed-in browser page.".into(),
            tags: vec!["Research".into()],
            created_at: "2026-10-02T00:00:00Z".into(),
            use_count: 0,
            favorite: false,
            preview: None,
            preview_status: None,
            asset_path: None,
            original_path: None,
            mime_type: None,
            size_bytes: None,
            content: None,
            context_override: None,
            origin: Some(serde_json::json!({ "platform": "Example" })),
        };

        let mut screenshot_item = make_item("ext-a", "https://example.com/story?utm_source=x");
        screenshot_item.preview = Some("data:image/jpeg;base64,dGVzdA==".into());
        let first =
            import_extension_items(&mut connection, vec![screenshot_item]).expect("first import");
        let second = import_extension_items(
            &mut connection,
            vec![make_item("ext-b", "https://example.com/story#comments")],
        )
        .expect("duplicate import");

        assert_eq!(first.imported, 1);
        assert_eq!(first.updated, 0);
        assert_eq!(second.imported, 0);
        assert_eq!(second.updated, 0);
        assert_eq!(second.skipped, 1);

        let mut preview_update = make_item("ext-c", "https://example.com/story");
        preview_update.preview = Some("data:image/png;base64,dXBkYXRlZA==".into());
        let third =
            import_extension_items(&mut connection, vec![preview_update]).expect("preview update");
        assert_eq!(third.imported, 0);
        assert_eq!(third.updated, 1);
        assert_eq!(third.skipped, 0);
        let stored = read_items(&connection).expect("read items");
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].preview.as_deref(),
            Some("data:image/png;base64,dXBkYXRlZA==")
        );
        assert_eq!(
            stored[0]
                .origin
                .as_ref()
                .and_then(|origin| origin.get("importMethod")),
            Some(&serde_json::json!("browser_extension"))
        );
        let previous = stored[0].clone();
        let mut favicon_update = make_item("ext-icon", "https://example.com/story");
        favicon_update.origin =
            Some(serde_json::json!({"faviconUrl":"https://example.com/brand.png"}));
        let result =
            import_extension_items(&mut connection, vec![favicon_update]).expect("favicon update");
        assert_eq!(result.updated, 1);
        assert_eq!(result.imported, 0);
        let refreshed = read_items(&connection).expect("read refreshed");
        assert_eq!(refreshed[0].preview, previous.preview);
        assert_eq!(refreshed[0].title, previous.title);
        assert_eq!(refreshed[0].tags, previous.tags);
        assert_eq!(
            refreshed[0].origin.as_ref().unwrap()["faviconUrl"],
            "https://example.com/brand.png"
        );
        assert_eq!(
            refreshed[0].origin.as_ref().unwrap()["importMethod"],
            "browser_extension"
        );
    }

    #[test]
    fn browser_capture_fills_missing_body_and_fts_but_preserves_user_context() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut bookmark = reference_fixture();
        bookmark.url = Some("https://example.com/capture".into());
        bookmark.content = None;
        bookmark.context_override = None;
        let original_title = bookmark.title.clone();
        let original_tags = bookmark.tags.clone();
        upsert_item(&connection, &bookmark).unwrap();
        let mut capture = bookmark.clone();
        capture.title = "Do not replace title".into();
        capture.tags = vec![];
        capture.content = Some("captureduniquetoken\nSecond paragraph".into());
        capture.origin = Some(
            serde_json::json!({"platform":"Example", "author":"Mira", "captureMethod":"page"}),
        );
        let result = import_extension_items(&mut connection, vec![capture.clone()]).unwrap();
        assert_eq!(result.updated, 1);
        let row = read_items(&connection).unwrap().remove(0);
        assert_eq!(row.title, original_title);
        assert_eq!(row.tags, original_tags);
        assert_eq!(row.content, capture.content);
        assert_eq!(row.origin.unwrap()["author"], "Mira");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'captureduniquetoken'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        capture.content = Some("Must not overwrite".into());
        import_extension_items(&mut connection, vec![capture.clone()]).unwrap();
        assert_eq!(
            read_items(&connection).unwrap()[0].content.as_deref(),
            Some("captureduniquetoken\nSecond paragraph")
        );
        connection
            .execute(
                "UPDATE stash_items SET content=NULL,context_override=''",
                [],
            )
            .unwrap();
        import_extension_items(&mut connection, vec![capture]).unwrap();
        let row = read_items(&connection).unwrap().remove(0);
        assert_eq!(row.content, None);
        assert_eq!(row.context_override.as_deref(), Some(""));
    }

    #[test]
    fn duplicate_browser_capture_preserves_a_user_selected_cover() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let mut bookmark = reference_fixture();
        bookmark.url = Some("https://example.org/custom-cover".into());
        bookmark.preview = Some("data:image/jpeg;base64,Y292ZXI=".into());
        bookmark.content = None;
        bookmark.origin = Some(
            serde_json::json!({"platform":"Example", "previewKind":"cover", "previewSource":"custom"}),
        );
        upsert_item(&connection, &bookmark).unwrap();
        let mut capture = bookmark.clone();
        capture.preview = Some("data:image/jpeg;base64,c2NyZWVuc2hvdA==".into());
        capture.content = Some("Readable body".into());
        capture.origin = Some(
            serde_json::json!({"platform":"Example", "importMethod":"browser_extension", "previewKind":"screenshot"}),
        );
        import_extension_items(&mut connection, vec![capture]).unwrap();
        let saved = read_items(&connection).unwrap().remove(0);
        assert_eq!(saved.preview, bookmark.preview);
        assert_eq!(saved.origin.as_ref().unwrap()["previewKind"], "cover");
        assert_eq!(saved.origin.as_ref().unwrap()["previewSource"], "custom");
        assert_eq!(saved.content.as_deref(), Some("Readable body"));
    }

    #[test]
    fn deletes_an_item_and_its_search_entry() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&connection).expect("create schema");
        let item = StashItem {
            id: "delete-me".into(),
            title: "Temporary reference".into(),
            kind: "web".into(),
            source: "Example".into(),
            url: Some("https://example.com/delete-me".into()),
            excerpt: "Delete this reference".into(),
            tags: vec!["Temporary".into()],
            created_at: "2026-10-02T00:00:00Z".into(),
            use_count: 0,
            favorite: false,
            preview: None,
            preview_status: None,
            asset_path: None,
            original_path: None,
            mime_type: None,
            size_bytes: None,
            content: None,
            context_override: None,
            origin: None,
        };
        upsert_item(&connection, &item).expect("save item");

        assert!(delete_item_by_id(&mut connection, &item.id).expect("delete item"));
        assert!(read_items(&connection).expect("read items").is_empty());
        let indexed = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE id = ?1",
                [&item.id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count search entries");
        assert_eq!(indexed, 0);
    }

    #[test]
    fn bulk_deletion_validates_and_rolls_back_items_and_search_together() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        for id in ["a", "b", "keep"] {
            let item: StashItem = serde_json::from_value(serde_json::json!({
                "id": id, "title": id, "kind": "web", "source": "Test", "excerpt": "test",
                "tags": [], "createdAt": "2026-10-20T00:00:00Z"
            }))
            .unwrap();
            upsert_item(&connection, &item).unwrap();
        }
        connection.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON stash_items WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(super::delete_items_by_id(&mut connection, &["a".into(), "b".into()]).is_err());
        assert_eq!(read_items(&connection).unwrap().len(), 3);
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM stash_fts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        connection
            .execute_batch("DROP TRIGGER reject_delete")
            .unwrap();
        assert!(super::delete_items_by_id(&mut connection, &["a".into(), "".into()]).is_err());
        assert_eq!(
            super::delete_items_by_id(&mut connection, &["a".into(), "b".into(), "a".into()])
                .unwrap(),
            2
        );
        assert_eq!(
            super::delete_items_by_id(&mut connection, &["a".into(), "b".into()]).unwrap(),
            0
        );
        assert_eq!(read_items(&connection).unwrap()[0].id, "keep");
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM stash_fts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn deleting_references_removes_only_their_library_backups() {
        let root = std::env::temp_dir().join(format!("stashdock-delete-{}", Uuid::new_v4()));
        let assets = root.join("assets");
        fs::create_dir_all(assets.join("one")).unwrap();
        let original = root.join("original.txt");
        let backup = assets.join("one").join("original.txt");
        let shared = assets.join("shared.txt");
        let outside = root.join("outside.txt");
        for path in [&original, &backup, &shared, &outside] {
            fs::write(path, "x").unwrap();
        }
        let mut connection = Connection::open(root.join("stashdock.sqlite3")).unwrap();
        initialize_schema(&connection).unwrap();
        for (id, asset, original_path) in [
            (
                "a",
                backup.to_string_lossy().into_owned(),
                Some(original.to_string_lossy().into_owned()),
            ),
            ("b", shared.to_string_lossy().into_owned(), None),
            ("c", shared.to_string_lossy().into_owned(), None),
            ("d", outside.to_string_lossy().into_owned(), None),
        ] {
            connection.execute(
                "INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,asset_path,original_path,updated_at) VALUES(?1,?1,'file','Local file','','[]','now',?2,?3,'now')",
                params![id, asset, original_path],
            ).unwrap();
        }
        assert_eq!(
            super::delete_items_by_id(&mut connection, &["a".into(), "b".into(), "d".into()])
                .unwrap(),
            3
        );
        assert!(
            !backup.exists() && !assets.join("one").exists(),
            "backup and its folder are removed"
        );
        assert!(original.exists(), "the user's original is never touched");
        assert!(
            shared.exists(),
            "a backup still used by another reference stays"
        );
        assert!(
            outside.exists(),
            "paths outside the library are never deleted"
        );
        drop(connection);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_terms_are_lowercased_unique_and_bounded() {
        assert_eq!(
            search::search_terms("Rust  C++ 搜索 rust"),
            vec!["rust", "c++", "搜索"]
        );
        assert!(search::search_terms(" \t ").is_empty());
        let many = (0..15)
            .map(|i| format!("t{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(search::search_terms(&many).len(), 12);
    }

    #[test]
    fn searches_imported_content_with_fts5() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&connection).expect("create schema");
        let item = StashItem {
            id: "search-item".into(),
            title: "Architecture notes".into(),
            kind: "file".into(),
            source: "Managed file".into(),
            url: None,
            excerpt: "Local context".into(),
            tags: vec!["Docs".into()],
            created_at: "2026-10-01T00:00:00Z".into(),
            use_count: 0,
            favorite: false,
            preview: None,
            preview_status: None,
            asset_path: None,
            original_path: None,
            mime_type: Some("text/markdown".into()),
            size_bytes: None,
            content: Some("The reliable retrieval pipeline uses a local index.".into()),
            context_override: None,
            origin: None,
        };
        upsert_item(&connection, &item).expect("save item");

        for query in ["retriev", "PIPELINE local", "liable"] {
            assert_eq!(
                search::search_ids(&connection, query).unwrap().unwrap(),
                vec![item.id.clone()],
                "query {query:?}"
            );
        }
    }

    #[test]
    fn browser_card_edits_preserve_context_and_reject_content_fields() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        connection.execute("INSERT INTO stash_items (id,title,kind,source,excerpt,tags_json,created_at,favorite,content,context_override,updated_at) VALUES ('browser-edit','Old','web','Web','','[]','2026-10-12',0,'Keep body','Keep override','2026-10-12')", []).unwrap();
        super::bridge::apply_browser_card_patch(
            &mut connection,
            "browser-edit",
            r#"{"title":"Updated","tags":["Keep"]}"#,
        )
        .unwrap();
        super::bridge::apply_browser_card_patch(
            &mut connection,
            "browser-edit",
            r#"{"favorite":true}"#,
        )
        .unwrap();
        for body in [
            r#"{"content":"Wrong"}"#,
            r#"{"favorite":false,"title":null}"#,
            r#"{"title":null,"tags":[]}"#,
        ] {
            assert!(
                super::bridge::apply_browser_card_patch(&mut connection, "browser-edit", body)
                    .is_err()
            );
        }
        let row = read_items(&connection).unwrap().remove(0);
        assert_eq!(row.title, "Updated");
        assert!(row.favorite);
        assert_eq!(row.tags, vec!["Keep"]);
        assert_eq!(row.content.as_deref(), Some("Keep body"));
        assert_eq!(row.context_override.as_deref(), Some("Keep override"));
    }

    #[test]
    fn backfills_text_for_existing_managed_files() {
        let root = std::env::temp_dir().join(format!("stashdock-backfill-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        let file_path = root.join("existing.md");
        fs::write(&file_path, "Previously imported searchable context")
            .expect("write existing file");

        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&connection).expect("create schema");
        connection
            .execute(
                "INSERT INTO stash_items (
                   id, title, kind, source, excerpt, tags_json, created_at,
                   favorite, asset_path, mime_type, updated_at
                 ) VALUES (?1, ?2, 'file', 'Managed file', 'Existing file', '[]',
                           ?3, 0, ?4, 'text/markdown', ?3)",
                params![
                    "existing-item",
                    "existing.md",
                    "2026-10-01T00:00:00Z",
                    file_path.to_string_lossy()
                ],
            )
            .expect("insert legacy item");

        backfill_text_content(&connection).expect("backfill content");
        let stored = read_items(&connection).expect("read backfilled item");
        assert_eq!(
            stored[0].content.as_deref(),
            Some("Previously imported searchable context")
        );
        let matches = connection
            .query_row(
                "SELECT COUNT(*) FROM stash_fts WHERE stash_fts MATCH 'Previously*'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("search backfilled content");
        assert_eq!(matches, 1);

        fs::remove_dir_all(root).expect("remove test directory");
    }
}
