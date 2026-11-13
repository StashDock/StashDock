use super::*;
use tauri::Emitter;

const KEY: &str = "library_sort_v1";
pub fn get_sort(connection: &Connection) -> Result<String, String> {
    let value: Option<String> = connection
        .query_row("SELECT value FROM app_meta WHERE key=?1", [KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value
        .filter(|s| matches!(s.as_str(), "newest" | "oldest" | "most-used"))
        .unwrap_or_else(|| "newest".into()))
}
pub fn set_sort(connection: &Connection, sort: &str) -> Result<(), String> {
    if !matches!(sort, "newest" | "oldest" | "most-used") {
        return Err("Choose a valid reference order.".into());
    }
    connection.execute("INSERT INTO app_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![KEY,sort]).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn annotate(connection: &Connection, items: &mut [StashItem]) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT id,use_count FROM reference_usage")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.max(0) as u64))
        })
        .map_err(|e| e.to_string())?;
    let counts: HashMap<_, _> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    for item in items {
        item.use_count = counts.get(&item.id).copied().unwrap_or(0);
    }
    Ok(())
}
pub fn sort(connection: &Connection, items: &mut [StashItem]) -> Result<(), String> {
    let sort = get_sort(connection)?;
    items.sort_by(|a, b| {
        let used = if sort == "most-used" {
            b.use_count.cmp(&a.use_count)
        } else {
            std::cmp::Ordering::Equal
        };
        used.then_with(|| {
            if sort == "oldest" {
                a.created_at.cmp(&b.created_at)
            } else {
                b.created_at.cmp(&a.created_at)
            }
        })
    });
    Ok(())
}
pub fn record(connection: &mut Connection, ids: &[String], operation: &str) -> Result<(), String> {
    if ids.is_empty()
        || ids.len() > 10_000
        || ids.iter().any(|id| id.is_empty() || id.len() > 120)
        || operation.is_empty()
        || operation.len() > 120
        || !operation
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Invalid reference usage.".into());
    }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    if transaction
        .execute(
            "INSERT OR IGNORE INTO reference_usage_receipts(operation_id) VALUES(?1)",
            [operation],
        )
        .map_err(|e| e.to_string())?
        > 0
    {
        let mut seen = HashSet::new();
        for id in ids.iter().filter(|id| seen.insert(id.as_str())) {
            transaction.execute("INSERT INTO reference_usage(id,use_count) SELECT id,1 FROM stash_items WHERE id=?1 ON CONFLICT(id) DO UPDATE SET use_count=use_count+1", [id]).map_err(|e| e.to_string())?;
        }
        transaction.execute("DELETE FROM reference_usage_receipts WHERE rowid <= (SELECT COALESCE(MAX(rowid),0)-1024 FROM reference_usage_receipts)", []).map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

/// Statistics must never turn a completed transfer into a failure or trigger a second transfer.
pub fn record_transfer(app: &AppHandle, ids: &[String]) {
    let library = app.state::<LibraryState>();
    {
        let mut connection = library.connection.lock().unwrap();
        if let Err(error) = record(&mut connection, ids, &Uuid::new_v4().to_string()) {
            eprintln!("Reference usage could not be recorded: {error}");
        }
    }
    let _ = app.emit("reference-usage-updated", serde_json::json!({ "ids": ids }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_order_and_usage_survive_reads_and_deduplicate_accepted_batches() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        for (id, date) in [("old", "2026-10-01"), ("new", "2026-11-01")] {
            let item: StashItem = serde_json::from_value(serde_json::json!({"id":id,"title":id,"kind":"web","source":"Example","excerpt":"","tags":[],"createdAt":date})).unwrap();
            upsert_item(&db, &item).unwrap();
        }
        assert_eq!(read_shelf(&db).unwrap()[0].id, "new");
        record(
            &mut db,
            &["old".into(), "old".into(), "new".into(), "missing".into()],
            "batch",
        )
        .unwrap();
        record(&mut db, &["old".into()], "batch").unwrap();
        record(&mut db, &["old".into()], "another").unwrap();
        set_sort(&db, "most-used").unwrap();
        let items = read_shelf(&db).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| (i.id.as_str(), i.use_count))
                .collect::<Vec<_>>(),
            vec![("old", 2), ("new", 1)]
        );
        assert_eq!(get_sort(&db).unwrap(), "most-used");
        assert!(set_sort(&db, "title").is_err());
        assert!(record(&mut db, &["old".into()], "").is_err());
        set_sort(&db, "oldest").unwrap();
        assert_eq!(read_shelf(&db).unwrap()[0].id, "old");
        db.execute("DELETE FROM stash_items WHERE id='old'", [])
            .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM reference_usage", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
