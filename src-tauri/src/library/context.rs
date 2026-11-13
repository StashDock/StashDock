//! Markdown contract mirrored by src/lib/context-format.mjs and shared fixtures.
use super::StashItem;

const HEADING: &str = "# StashDock context\n\n";

fn section(item: &StashItem) -> String {
    let origin = item.origin.as_ref();
    let field = |name: &str| {
        origin
            .and_then(|value| value.get(name))
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
    };
    let file = item.kind != "note"
        && item
            .asset_path
            .as_ref()
            .is_some_and(|path| !path.is_empty());
    let mut lines = vec![format!("## {}", item.title)];
    let source = item.source.trim();
    let duplicate_host = item
        .url
        .as_deref()
        .and_then(|value| url::Url::parse(value).ok())
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| host.eq_ignore_ascii_case(source));
    if !duplicate_host
        && ![
            "",
            "stashdock",
            "local file",
            "personal note",
            "ai conversation",
            "chrome",
            "edge",
            "firefox",
            "safari",
        ]
        .contains(&source.to_lowercase().as_str())
    {
        lines.push(format!("Source: {source}"));
    }
    if let Some(url) = item.url.as_deref().filter(|value| !value.is_empty()) {
        lines.push(format!("URL: {url}"));
    }
    if file {
        let raw = field("fileName")
            .or(item.asset_path.as_deref())
            .unwrap_or(&item.title);
        let name = raw
            .rsplit(['\\', '/'])
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("File")
            .replace(['\r', '\n'], " ");
        lines.push(format!("File: {name}"));
    }
    for (key, label) in [("author", "Author"), ("publishedAt", "Published")] {
        if let Some(value) = field(key) {
            lines.push(format!("{label}: {value}"));
        }
    }
    match field("contentOrigin") {
        Some("generated") => lines.push("Content origin: AI-generated".into()),
        Some("provided") => lines.push("Content origin: User-provided".into()),
        _ => {}
    }
    if let Some(urls) = origin
        .and_then(|value| value.get("sourceUrls"))
        .and_then(|value| value.as_array())
    {
        let values = urls
            .iter()
            .filter_map(|value| value.as_str())
            .take(10)
            .collect::<Vec<_>>();
        if !values.is_empty() {
            lines.push(format!("Sources: {}", values.join(", ")));
        }
    }
    if !item.tags.is_empty() {
        lines.push(format!("Tags: {}", item.tags.join(", ")));
    }
    let body = item
        .content
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&item.excerpt);
    let label = if file {
        "Supplemental context"
    } else if item.content.as_deref().is_none_or(str::is_empty) && !item.excerpt.is_empty() {
        "Summary"
    } else if field("captureMethod") == Some("selection") {
        "Selected text"
    } else if field("importMethod") == Some("browser_extension") {
        "Saved page content"
    } else if item.kind == "note" {
        "Note text"
    } else {
        "Saved content"
    };
    let mut characters = body.chars();
    let text = if item.kind == "note" {
        body.to_owned()
    } else {
        characters.by_ref().take(20_000).collect::<String>()
    };
    let truncated = item.kind != "note" && characters.next().is_some();
    if !text.is_empty() {
        lines.extend([String::new(), format!("### {label}"), text]);
    }
    let mut limitations = Vec::new();
    if !file && field("captureMethod") == Some("selection") {
        limitations.push("Only selected text was saved, not the full page.");
    }
    if origin
        .and_then(|value| value.get("truncated"))
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        limitations.push("The saved source content is incomplete.");
    }
    if truncated {
        limitations.push("The exported text was truncated to 20,000 characters.");
    }
    if !file && body.is_empty() && item.url.as_ref().is_some_and(|value| !value.is_empty()) {
        limitations.push("Page content was not saved. Read the URL before making claims about it.");
    }
    if !limitations.is_empty() {
        lines.push(String::new());
        lines.extend(limitations.into_iter().map(str::to_owned));
    }
    lines.join("\n")
}

pub(super) fn build(items: &[StashItem]) -> Result<String, String> {
    if items.len() == 1 {
        if let Some(value) = &items[0].context_override {
            return Ok(value.clone());
        }
    }
    let sections = items
        .iter()
        .map(|item| match &item.context_override {
            Some(value) => value.strip_prefix(HEADING).unwrap_or(value).to_owned(),
            None => section(item),
        })
        .collect::<Vec<_>>();
    let result = format!("{HEADING}{}", sections.join("\n\n---\n\n"));
    if result.len() > 8 * 1024 * 1024 {
        return Err("Select fewer references before transferring.".into());
    }
    Ok(result)
}

fn file_supplement(item: &StashItem) -> String {
    if let Some(value) = &item.context_override {
        // Legacy editors could save their unchanged generated preview. It is
        // not an annotation; retain every other explicit final edit verbatim.
        if *value != format!("{HEADING}{}", section(item)) {
            return value.clone();
        }
    }
    let edited = item.origin.as_ref().and_then(|v| v.get("contentEdited")).and_then(|v| v.as_bool());
    let legacy_binary = edited.is_none()
        && item.origin.as_ref().and_then(|v| v.get("importMethod")).and_then(|v| v.as_str()) == Some("local_file")
        && item.mime_type.as_deref().is_some_and(|mime| !super::is_text_mime(mime));
    if edited == Some(true) || legacy_binary {
        item.content.clone().unwrap_or_default()
    } else {
        String::new()
    }
}

/// Original files carry their own identity. Export only user annotations and
/// any selected text references alongside them, never file extraction/summaries.
pub(super) fn native(items: &[StashItem]) -> Result<String, String> {
    let mut selected = Vec::new();
    for item in items {
        if item.kind == "note" || item.asset_path.as_deref().is_none_or(str::is_empty) {
            selected.push(item.clone());
            continue;
        }
        let supplement = file_supplement(item);
        if supplement.trim().is_empty() { continue; }
        let raw = item.origin.as_ref().and_then(|v| v.get("fileName")).and_then(|v| v.as_str())
            .or(item.asset_path.as_deref()).unwrap_or(&item.title);
        let name = raw.rsplit(['\\', '/']).next().filter(|v| !v.is_empty()).unwrap_or("File").replace(['\r', '\n'], " ");
        let mut annotated = item.clone();
        annotated.context_override = Some(format!("## {name}\n\n{supplement}"));
        selected.push(annotated);
    }
    if selected.is_empty() { Ok(String::new()) } else { build(&selected) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_only_native_context_matches_javascript_contract() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/native-context-contract.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let items: Vec<StashItem> = serde_json::from_value(fixture["items"].clone()).unwrap();
            assert_eq!(native(&items).unwrap(), fixture["expected"].as_str().unwrap(), "{}", fixture["name"]);
        }
    }
    #[test]
    fn native_output_matches_shared_javascript_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/context-contract.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let items: Vec<StashItem> = serde_json::from_value(fixture["items"].clone()).unwrap();
            assert_eq!(
                build(&items).unwrap(),
                fixture["expected"].as_str().unwrap(),
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn unicode_truncation_reports_both_limits_without_splitting_characters() {
        let mut item: StashItem = serde_json::from_value(serde_json::json!({"id":"long","title":"Long","kind":"web","source":"Chrome","excerpt":"","tags":[],"createdAt":"2026-10-18","content":"😀".repeat(20_001),"origin":{"truncated":true}})).unwrap();
        let context = build(&[item.clone()]).unwrap();
        assert_eq!(context.matches('😀').count(), 20_000);
        assert!(
            context.contains("saved source content is incomplete")
                && context.contains("exported text was truncated")
        );
        item.kind = "note".into();
        item.origin = None;
        assert_eq!(
            build(&[item.clone()]).unwrap().matches('😀').count(),
            20_001
        );
        item.context_override = Some("😀".repeat(25_000));
        assert_eq!(
            build(&[item.clone()]).unwrap(),
            item.context_override.unwrap()
        );
    }
}
