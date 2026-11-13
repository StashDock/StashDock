//! Import legacy Note TXT bodies once and retain the old files for recovery.
use super::*;

const MAX_TEXT_BYTES: u64 = 5_000_000;

fn read_legacy_text(path: &Path) -> Option<(String, (u64, i64))> {
    let before = originals::fingerprint(path)?;
    let (size, _) = before;
    if size > MAX_TEXT_BYTES {
        return None;
    }
    let mut content = String::new();
    fs::File::open(path)
        .ok()?
        .take(size + 1)
        .read_to_string(&mut content)
        .ok()?;
    if content.len() as u64 != size || originals::fingerprint(path)? != before {
        return None;
    }
    if content.starts_with('\u{feff}') {
        content.drain(..'\u{feff}'.len_utf8());
    }
    Some((content, before))
}

pub(super) fn migrate(connection: &Connection) -> Result<(), String> {
    let Some(database) = connection
        .path()
        .filter(|path| !path.is_empty() && *path != ":memory:")
    else {
        return Ok(());
    };
    let assets = Path::new(database)
        .parent()
        .ok_or("The file library is unavailable.")?
        .join("assets");
    let mut query = connection
        .prepare("SELECT id,asset_path FROM stash_items WHERE kind='note' AND asset_path<>''")
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    // Bound legacy text held in memory and keep each writer reservation short.
    let mut candidates = Vec::new();
    let mut bytes = 0;
    for (id, raw) in rows {
        let Ok(path) = file_payload::managed_asset_path(&assets, &raw) else {
            continue;
        };
        let Some((content, fingerprint)) = read_legacy_text(&path) else {
            continue;
        };
        if candidates.len() >= 64 || bytes + content.len() > 8_000_000 {
            migrate_batch(connection, &candidates)?;
            candidates.clear();
            bytes = 0;
        }
        bytes += content.len();
        candidates.push(LegacyNote {
            id,
            raw,
            path,
            content,
            fingerprint,
        });
    }
    migrate_batch(connection, &candidates)
}

struct LegacyNote {
    id: String,
    raw: String,
    path: PathBuf,
    content: String,
    fingerprint: (u64, i64),
}

fn migrate_batch(connection: &Connection, candidates: &[LegacyNote]) -> Result<(), String> {
    if candidates.is_empty() {
        return Ok(());
    }
    let transaction = connection
        .is_autocommit()
        .then(|| {
            rusqlite::Transaction::new_unchecked(
                connection,
                rusqlite::TransactionBehavior::Immediate,
            )
        })
        .transpose()
        .map_err(|error| error.to_string())?;
    let mut current = connection
        .prepare(
            "SELECT origin_json FROM stash_items WHERE id=?1 AND kind='note' AND asset_path=?2",
        )
        .map_err(|error| error.to_string())?;
    let mut update = connection.prepare(
        "UPDATE stash_items SET asset_path=NULL,original_path=NULL,mime_type=NULL,size_bytes=NULL,
         content=?1,excerpt=?2,origin_json=?3 WHERE id=?4",
    ).map_err(|error| error.to_string())?;
    for LegacyNote {
        id,
        raw,
        path,
        content,
        fingerprint,
    } in candidates
    {
        let row = current
            .query_row(params![id, raw], |row| row.get::<_, Option<String>>(0))
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(raw_origin) = row else { continue };
        if originals::fingerprint(path) != Some(*fingerprint) {
            continue;
        }
        let mut origin = raw_origin
            .and_then(|value| {
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&value).ok()
            })
            .unwrap_or_default();
        origin.remove("fileName");
        origin.remove("fileFingerprint");
        update
            .execute(params![
                content,
                text_excerpt(&content),
                serde_json::Value::Object(origin).to_string(),
                id
            ])
            .map_err(|error| error.to_string())?;
    }
    drop(update);
    drop(current);
    if let Some(transaction) = transaction {
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_keeps_the_latest_text_and_the_saved_override() {
        let root = std::env::temp_dir().join(format!("stashdock-note-upgrade-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("assets")).unwrap();
        let file = root.join("assets/Rules.txt");
        fs::write(&file, "Latest TXT body 中文").unwrap();
        let db = Connection::open(root.join("stashdock.sqlite3")).unwrap();
        initialize_schema(&db).unwrap();
        db.execute("INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,updated_at,asset_path,content,context_override)
            VALUES('note','Rules','note','Note','','[]','2026-10-17','2026-10-17',?1,'Cached body','')", [file.to_str().unwrap()]).unwrap();
        migrate(&db).unwrap();
        let item = read_items(&db).unwrap().pop().unwrap();
        assert_eq!(item.content.as_deref(), Some("Latest TXT body 中文"));
        assert_eq!(item.context_override.as_deref(), Some(""));
        assert_eq!(item.asset_path, None);
        assert_eq!(
            db.query_row(
                "SELECT asset_path FROM stash_items WHERE id='note'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "Latest TXT body 中文");
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
}
