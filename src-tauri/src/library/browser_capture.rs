//! Compact, transactional Save-page protocol shared by all browser targets.
use super::{canonicalize_web_url, now, replace_link_item, truncate_text, upsert_item, StashItem};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn tags(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection.prepare("SELECT DISTINCT value FROM stash_items,json_each(stash_items.tags_json) WHERE json_each.type='text' ORDER BY value").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut tags = Vec::new();
    let mut bytes = 0;
    for tag in rows {
        let tag = tag.map_err(|e| e.to_string())?;
        bytes += tag.len() + 4;
        if bytes > 750_000 {
            return Err("The tag list is too large.".into());
        }
        tags.push(tag);
    }
    Ok(json!({"tags":tags}))
}
fn find(connection: &Connection, url: &str) -> Result<Option<String>, String> {
    let direct = connection
        .query_row(
            "SELECT id FROM stash_items WHERE url=?1 LIMIT 1",
            [url],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if direct.is_some() {
        return Ok(direct);
    }
    let mut statement = connection
        .prepare("SELECT id,url FROM stash_items WHERE url IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, raw) = row.map_err(|e| e.to_string())?;
        if canonicalize_web_url(&raw).as_deref() == Some(url) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}
fn summary(connection: &Connection, id: &str) -> Result<Option<Value>, String> {
    connection.query_row("SELECT id,updated_at,title,tags_json,content,preview,origin_json,context_override,favorite FROM stash_items WHERE id=?1",[id],|row| {
        let mut values=Vec::new();
        for i in 0..8 { values.push(row.get::<_,Option<String>>(i)?.map(Value::String).unwrap_or(Value::Null)); }
        values.push(json!(row.get::<_,i64>(8)?));
        Ok(json!({"id":values[0],"title":values[2],"revision":hash(&serde_json::to_string(&values).unwrap())}))
    }).optional().map_err(|e|e.to_string())
}
pub(super) fn lookup(
    connection: &Connection,
    raw: &str,
    operation: Option<&str>,
    digest: Option<&str>,
) -> Result<Value, String> {
    let url = canonicalize_web_url(raw).ok_or("Use an http or https URL without credentials.")?;
    if let (Some(operation), Some(digest)) = (operation, digest) {
        if (16..=64).contains(&operation.len())
            && operation
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            && digest.len() == 64
            && digest.bytes().all(|c| c.is_ascii_hexdigit())
        {
            if let Some(stored) = connection
                .query_row(
                    "SELECT value FROM app_meta WHERE key=?1",
                    [format!("browser_capture_receipt_v1:{operation}")],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
            {
                let receipt: Value = serde_json::from_str(&stored).map_err(|e| e.to_string())?;
                if receipt["digest"].as_str() == Some(digest) {
                    return Ok(receipt["result"].clone());
                }
            }
        }
    }
    let duplicate = find(connection, &url)?
        .map(|id| summary(connection, &id))
        .transpose()?
        .flatten();
    Ok(json!({"duplicate":duplicate}))
}
pub(super) fn save(connection: &mut Connection, body: &str) -> Result<Value, String> {
    let input: Value = serde_json::from_str(body).map_err(|_| "Invalid page capture.")?;
    let object = input.as_object().ok_or("Invalid page capture.")?;
    let operation = input["operationId"]
        .as_str()
        .ok_or("Invalid save request.")?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "item" | "operationId" | "replace"))
        || !(16..=64).contains(&operation.len())
        || !operation
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid save request.".into());
    }
    let mut item: StashItem =
        serde_json::from_value(input["item"].clone()).map_err(|_| "Invalid page capture.")?;
    if !matches!(item.kind.as_str(), "web" | "repo")
        || item.title.trim().is_empty()
        || item.title.encode_utf16().count() > 500
        || item
            .content
            .as_ref()
            .is_none_or(|v| v.encode_utf16().count() > 20000)
        || item.tags.len() > 12
        || item.tags.iter().any(|v| super::tag_too_long(v))
        || item.asset_path.is_some()
        || item.original_path.is_some()
        || item.context_override.is_some()
    {
        return Err("Invalid page capture.".into());
    }
    if let Some(preview) = &item.preview {
        let valid = [
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,",
        ]
        .into_iter()
        .any(|prefix| {
            preview.strip_prefix(prefix).is_some_and(|data| {
                !data.is_empty()
                    && data
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
            })
        });
        if preview.len() > 750000 || !valid {
            return Err("Invalid page capture.".into());
        }
    }
    let url = canonicalize_web_url(item.url.as_deref().unwrap_or(""))
        .ok_or("Use an http or https URL without credentials.")?;
    let digest = hash(body);
    let key = format!("browser_capture_receipt_v1:{operation}");
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if let Some(receipt) = transaction
        .query_row("SELECT value FROM app_meta WHERE key=?1", [&key], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
    {
        let value: Value = serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
        if value["digest"].as_str() != Some(digest.as_str()) {
            return Err("This save request changed. Save the page again.".into());
        }
        return Ok(value["result"].clone());
    }
    let existing = find(&transaction, &url)?
        .map(|id| summary(&transaction, &id))
        .transpose()?
        .flatten();
    if let Some(existing) = &existing {
        if input["replace"]["id"] != existing["id"]
            || input["replace"]["revision"] != existing["revision"]
        {
            return Ok(json!({"duplicate":existing}));
        }
    } else if !input["replace"].is_null() {
        return Err("The reference changed. Save the page again.".into());
    }
    let mut origin = json!({});
    for name in [
        "platform",
        "externalId",
        "faviconUrl",
        "author",
        "publishedAt",
        "captureMethod",
        "truncated",
        "previewKind",
    ] {
        if let Some(value) = item.origin.as_ref().and_then(|o| o.get(name)) {
            if value.is_boolean()
                || value
                    .as_str()
                    .is_some_and(|v| v.encode_utf16().count() <= 32768)
            {
                origin[name] = value.clone();
            }
        }
    }
    origin["importMethod"] = json!("browser_extension");
    origin["importedAt"] = json!(now()?);
    item.title = item.title.trim().to_string();
    item.url = Some(url.clone());
    item.content = item.content.map(|v| v.trim().to_string());
    item.source = truncate_text(&item.source, 300);
    item.excerpt = truncate_text(&item.excerpt, 2000);
    let mut tags = std::collections::HashSet::new();
    item.tags = item
        .tags
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && tags.insert(v.to_lowercase()))
        .collect();
    item.origin = Some(origin);
    item.favorite = false;
    item.context_override = None;
    item.asset_path = None;
    item.original_path = None;
    item.mime_type = None;
    item.size_bytes = None;
    if let Some(existing) = &existing {
        let id = existing["id"].as_str().ok_or("Invalid reference.")?;
        item.id = id.into();
        replace_link_item(&transaction, &item)?;
    } else {
        item.id = uuid::Uuid::new_v4().to_string();
        item.created_at = now()?;
        upsert_item(&transaction, &item)?;
    }
    let result = json!({"saved":true,"id":item.id,"replaced":existing.is_some()});
    transaction
        .execute(
            "INSERT INTO app_meta(key,value) VALUES (?1,?2)",
            params![key, json!({"digest":digest,"result":result}).to_string()],
        )
        .map_err(|e| e.to_string())?;
    transaction.execute("DELETE FROM app_meta WHERE key GLOB 'browser_capture_receipt_v1:*' AND rowid NOT IN (SELECT rowid FROM app_meta WHERE key GLOB 'browser_capture_receipt_v1:*' ORDER BY rowid DESC LIMIT 256)",[]).map_err(|e|e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, Value) {
        let connection = Connection::open_in_memory().unwrap();
        super::super::initialize_schema(&connection).unwrap();
        let item = json!({"id":"draft","title":"First title","kind":"web","source":"Example","url":"https://example.org/post?utm_source=x#reply","excerpt":"Body","content":"First body","tags":["Old"],"createdAt":"2026-10-16T00:00:00Z","preview":"data:image/jpeg;base64,AAAA"});
        (connection, item)
    }
    #[test]
    fn compact_lookup_and_confirmed_replace_use_the_new_final_context() {
        let (mut connection, item) = fixture();
        let first = save(
            &mut connection,
            &json!({"item":item,"operationId":"first-operation-1234"}).to_string(),
        )
        .unwrap();
        let id = first["id"].as_str().unwrap();
        connection
            .execute(
                "UPDATE stash_items SET favorite=1,context_override='User context' WHERE id=?1",
                [id],
            )
            .unwrap();
        let conflict = lookup(&connection, "https://example.org/post/", None, None).unwrap()
            ["duplicate"]
            .clone();
        assert_eq!(conflict.as_object().unwrap().len(), 3);
        assert!(conflict.to_string().len() < 700);
        let mut next = item.clone();
        next["title"] = json!("New title");
        next["content"] = json!("New body");
        next["tags"] = json!(["New"]);
        next["preview"] = Value::Null;
        next["kind"] = json!("repo");
        let request = json!({"item":next,"operationId":"replace-operation-1234"});
        assert_eq!(
            save(&mut connection, &request.to_string()).unwrap()["duplicate"],
            conflict
        );
        let title: String = connection
            .query_row("SELECT title FROM stash_items WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "First title");
        let body = json!({"item":next,"operationId":"replace-operation-1234","replace":conflict})
            .to_string();
        let result = save(&mut connection, &body).unwrap();
        assert_eq!(result["id"], first["id"]);
        assert_eq!(result["replaced"], true);
        let stored=connection.query_row("SELECT title,content,context_override,favorite,tags_json FROM stash_items WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?))).unwrap();
        assert_eq!(
            stored,
            (
                "New title".into(),
                "New body".into(),
                None,
                0,
                "[\"New\"]".into()
            )
        );
        let refreshed = connection.query_row(&format!("SELECT {} FROM stash_items WHERE id=?1", super::super::ITEM_COLUMNS), [id], super::super::row_to_item).unwrap();
        assert!(refreshed.preview.is_none());
        assert_eq!(refreshed.kind, "repo");
        let context = super::super::context::build(&[refreshed]).unwrap();
        assert!(context.contains("New body"));
        assert!(!context.contains("User context"));
        connection
            .execute(
                "UPDATE stash_items SET title='Later edit' WHERE id=?1",
                [id],
            )
            .unwrap();
        assert_eq!(save(&mut connection, &body).unwrap(), result);
        assert_eq!(
            lookup(
                &connection,
                item["url"].as_str().unwrap(),
                Some("replace-operation-1234"),
                Some(&hash(&body))
            )
            .unwrap(),
            result
        );
        let title: String = connection
            .query_row("SELECT title FROM stash_items WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Later edit");
        assert!(save(
            &mut connection,
            &body.replace("New body", "Modified request")
        )
        .is_err());
    }
    #[test]
    fn capture_conflicts_are_rechecked_inside_the_write_transaction() {
        let (mut connection, item) = fixture();
        let result = save(
            &mut connection,
            &json!({"item":item,"operationId":"create-operation-1234"}).to_string(),
        )
        .unwrap();
        let conflict = lookup(&connection, item["url"].as_str().unwrap(), None, None).unwrap()
            ["duplicate"]
            .clone();
        connection
            .execute(
                "UPDATE stash_items SET title='Concurrent edit' WHERE id=?1",
                [result["id"].as_str().unwrap()],
            )
            .unwrap();
        let body = json!({"item":item,"operationId":"replace-operation-1234","replace":conflict})
            .to_string();
        let stale = save(&mut connection, &body).unwrap();
        assert_ne!(stale["duplicate"]["revision"], conflict["revision"]);
        connection.execute("DELETE FROM stash_items", []).unwrap();
        assert!(save(&mut connection, &body).is_err());
        let mut invalid = item.clone();
        invalid["url"] = json!("https://user:password@example.org");
        assert!(save(
            &mut connection,
            &json!({"item":invalid,"operationId":"invalid-operation-1234"}).to_string()
        )
        .is_err());
    }
    #[test]
    fn revision_hash_is_identical_to_the_node_provider() {
        let (connection, _) = fixture();
        connection.execute("INSERT INTO stash_items(id,title,kind,source,url,excerpt,tags_json,created_at,updated_at,content,origin_json,favorite) VALUES ('id','Title','web','Example','https://example.org','Body','[]','time','time','Body','{}',1)",[]).unwrap();
        assert_eq!(
            summary(&connection, "id").unwrap().unwrap()["revision"],
            "d14922fafbebf73b21912df3fc1ff0083034bd0f3f52e89b0878ef6feb02cd3c"
        );
        assert_eq!(
            canonicalize_web_url("https://example.org/post/?utm_source=x#reply").as_deref(),
            Some("https://example.org/post")
        );
        assert_eq!(
            canonicalize_web_url("https://example.org/post?q=hello%20world").as_deref(),
            Some("https://example.org/post?q=hello%20world")
        );
    }
}
