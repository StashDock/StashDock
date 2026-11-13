//! One outgoing payload for the native clipboard and drag.
use crate::library::{self, StashItem};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 100;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) enum Transfer {
    Text(String),
    Files {
        files: Vec<PathBuf>,
        context_file: Option<PathBuf>,
    },
}

impl Transfer {
    pub(crate) fn files(&self) -> &[PathBuf] {
        match self {
            Self::Text(_) => &[],
            Self::Files { files, .. } => files,
        }
    }
    pub(crate) fn context_file(&self) -> Option<&Path> {
        match self {
            Self::Text(_) => None,
            Self::Files { context_file, .. } => context_file.as_deref(),
        }
    }
    pub(crate) fn export_anchor(&self) -> Option<&Path> {
        self.files().first().map(PathBuf::as_path)
    }
}

fn original_name(item: &StashItem, path: &Path) -> String {
    let raw = item
        .origin
        .as_ref()
        .and_then(|value| value.get("fileName"))
        .and_then(|value| value.as_str())
        .or_else(|| path.file_name().and_then(|name| name.to_str()))
        .unwrap_or("File");
    let name: String = raw
        .chars()
        .take(300)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    // Keep the extension when shortening an unusually long name for Shell.
    let path = Path::new(name);
    let stem: String = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("File")
        .chars()
        .take(100)
        .collect();
    let extension: String = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .chars()
        .take(16)
        .collect();
    let name = if extension.is_empty() {
        stem
    } else {
        format!("{stem}.{extension}")
    };
    let name = name.trim_matches([' ', '.']);
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty() {
        "File".into()
    } else if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        format!("File - {name}")
    } else {
        name.into()
    }
}

fn create_output(
    folder: &Path,
    name: &str,
    used: &mut HashSet<String>,
) -> Result<(PathBuf, fs::File), String> {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("File");
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    // Keep portable case-insensitive names, then let the receiving filesystem
    // decide whether two Unicode spellings alias. Never normalize the user's
    // saved name or open an existing file with truncation.
    for index in 1..=MAX_FILES + 1 {
        let candidate = if index == 1 {
            name.to_string()
        } else {
            format!("{stem} ({index}){extension}")
        };
        if !used.insert(candidate.to_lowercase()) {
            continue;
        }
        let path = folder.join(candidate);
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("The outgoing filenames could not be made unique.".into())
}

pub(crate) fn export(database: &Path, ids: &[String], root: &Path) -> Result<Transfer, String> {
    let mut items = library::reference_transfer_snapshot(database, ids)?;
    let assets = database
        .parent()
        .ok_or("The file library is unavailable.")?
        .join("assets");
    let mut originals = Vec::new();
    let mut reference_paths = Vec::new();
    let mut seen = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        if item.kind == "note" {
            continue;
        }
        if item.asset_path.is_none() && !["file", "pdf", "image"].contains(&item.kind.as_str()) {
            continue;
        }
        let raw = match item.asset_path.as_deref() {
            Some(raw) => raw,
            // Some legacy PDF/image references are links, not managed files.
            None if item.url.is_some() => continue,
            None => return Err("A selected original file is missing. Import it again.".into()),
        };
        let path = library::file_payload::managed_asset_path(&assets, raw)?;
        reference_paths.push((index, path.clone()));
        if seen.insert(path.clone()) {
            originals.push((index, path));
        }
    }
    if originals.len() > MAX_FILES {
        return Err("Select up to 100 original files at a time.".into());
    }
    if originals.is_empty() && items.iter().any(|item| item.kind == "note") {
        return Ok(Transfer::Text(library::reference_transfer_context(&items)?));
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let folder = root.join(format!("StashDock transfer - {}", uuid::Uuid::new_v4()));
    fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut used = HashSet::new();
        let naming_context = items
            .first()
            .map(|item| {
                item.context_override
                    .clone()
                    .unwrap_or_else(|| format!("## {}", item.title))
            })
            .unwrap_or_default();
        let mut files = Vec::new();
        let mut total = 0;
        let mut actual_names = HashMap::new();
        for (index, path) in originals {
            let source = fs::File::open(&path)
                .map_err(|_| "An original file could not be read. Import it again.")?;
            let length = source.metadata().map_err(|e| e.to_string())?.len();
            if length > MAX_BYTES - total {
                return Err("Select original files up to 1 GB in total.".into());
            }
            let (destination, mut output) =
                create_output(&folder, &original_name(&items[index], &path), &mut used)?;
            let name = destination
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("The outgoing filename is not supported.")?
                .to_string();
            let copied = std::io::copy(&mut source.take(length + 1), &mut output)
                .map_err(|e| e.to_string())?;
            if copied != length {
                return Err("An original file changed while copying. Try again.".into());
            }
            total += copied;
            actual_names.insert(path, name);
            files.push(destination);
        }
        // Names belong to this outgoing snapshot, never the saved library.
        // Match every section (including shared originals) to the actual flat,
        // collision-safe attachment name before formatting its context.
        for (index, path) in reference_paths {
            let name = &actual_names[&path];
            let item = &mut items[index];
            let origin = item.origin.get_or_insert_with(|| serde_json::json!({}));
            if !origin.is_object() {
                *origin = serde_json::json!({});
            }
            origin["fileName"] = serde_json::json!(name);
        }
        let context = library::native_reference_context(&items)?;
        let context_file = if !context.trim().is_empty() || files.is_empty() {
            let (path, mut output) = create_output(
                &folder, &crate::reference_drag::export_filename(&naming_context, ids.len()), &mut used,
            )?;
            output.write_all(context.as_bytes()).map_err(|e| e.to_string())?;
            files.push(path.clone());
            Some(path)
        } else { None };
        Ok(Transfer::Files {
            files,
            context_file,
        })
    })();
    if result.is_err() {
        discard_folder(root, &folder);
    }
    result
}

fn generated_folder(root: &Path, folder: &Path) -> bool {
    folder.parent() == Some(root)
        && folder
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("StashDock transfer - "))
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .is_some()
}

fn discard_folder(root: &Path, folder: &Path) {
    if !generated_folder(root, folder)
        || fs::symlink_metadata(folder).is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return;
    }
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.flatten() {
            // Flat owned export copies only. Never traverse a child directory.
            if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_dir(folder);
}

pub(crate) fn discard(transfer: &Transfer) {
    if let Some(folder) = transfer.export_anchor().and_then(Path::parent) {
        if let Some(root) = folder.parent() {
            discard_folder(root, folder);
        }
    }
}

pub(crate) fn prune(root: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let folder = entry.path();
        if !keep.starts_with(&folder)
            && generated_folder(root, &folder)
            && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 7 * 86400)
        {
            discard_folder(root, &folder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        database: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("stashdock-transfer-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("assets")).unwrap();
            let database = root.join("stashdock.sqlite3");
            let db = rusqlite::Connection::open(&database).unwrap();
            db.execute_batch(include_str!("../../plugins/stashdock/server/schema.sql"))
                .unwrap();
            crate::library::install_search_index(&db).unwrap();
            Self { root, database }
        }
        fn add(
            &self,
            id: &str,
            kind: &str,
            path: Option<&Path>,
            name: &str,
            override_text: Option<&str>,
        ) {
            let db = rusqlite::Connection::open(&self.database).unwrap();
            db.execute("INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,updated_at,asset_path,content,origin_json,context_override) VALUES(?1,?2,?3,'Fixture','','[\"Research\"]','2026-10-15','2026-10-15',?4,'User supplemental content',?5,?6)", rusqlite::params![id,format!("Title {id}"),kind,path.map(|p|p.to_string_lossy().into_owned()),serde_json::json!({"fileName":name,"contentEdited":true}).to_string(),override_text]).unwrap();
        }
        fn output(&self) -> PathBuf {
            self.root.join("exports")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Exact fresh UUID test root only, never an application data root.
            assert!(self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("stashdock-transfer-test-"));
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    #[test]
    fn unannotated_originals_have_no_markdown_and_still_clean_up_owned_exports() {
        let fixture = Fixture::new();
        let path = fixture.root.join("assets/report.csv");
        fs::write(&path, b"a,b\n1,2\n").unwrap();
        fixture.add("bare", "file", Some(&path), "report.csv", None);
        let db = rusqlite::Connection::open(&fixture.database).unwrap();
        db.execute("UPDATE stash_items SET origin_json=json_remove(origin_json,'$.contentEdited'),content='Automatic extraction' WHERE id='bare'", []).unwrap();
        let transfer = export(&fixture.database, &["bare".into()], &fixture.output()).unwrap();
        assert_eq!(transfer.files().len(), 1);
        assert!(transfer.context_file().is_none());
        assert_eq!(fs::read(&transfer.files()[0]).unwrap(), b"a,b\n1,2\n");
        let owned = transfer.files()[0].clone();
        discard(&transfer);
        assert!(!owned.exists());
        assert!(path.exists());
    }
    #[test]
    fn copies_original_bytes_and_context_in_one_flat_group_without_mutating_the_library() {
        let fixture = Fixture::new();
        let original = fixture.root.join("assets/original.pdf");
        let bytes = b"%PDF-1.4\0 original bytes, not parsed";
        fs::write(&original, bytes).unwrap();
        fixture.add("a", "pdf", Some(&original), "资料.pdf", None);
        let transfer = export(&fixture.database, &["a".into()], &fixture.output()).unwrap();
        assert_eq!(transfer.files().len(), 2);
        assert_eq!(transfer.files()[0].file_name().unwrap(), "资料.pdf");
        assert_ne!(transfer.files()[0], original);
        assert_eq!(fs::read(&transfer.files()[0]).unwrap(), bytes);
        let context = fs::read_to_string(transfer.context_file().unwrap()).unwrap();
        assert!(
            context.contains("User supplemental content")
                && !context.contains("Research")
                && context.contains("## 资料.pdf")
        );
        assert!(transfer
            .files()
            .iter()
            .all(|p| p.parent() == transfer.context_file().unwrap().parent()));
        fs::write(&transfer.files()[0], "Receiver edit").unwrap();
        assert_eq!(fs::read(&original).unwrap(), bytes);
        discard(&transfer);
        assert!(!transfer.context_file().unwrap().exists());
        assert!(original.exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn canonically_equivalent_names_export_as_distinct_files_on_macos() {
        let fixture = Fixture::new();
        for (id, name, bytes) in [
            ("a", "Caf\u{e9}.pdf", b"first original".as_slice()),
            ("b", "Cafe\u{301}.pdf", b"second original".as_slice()),
        ] {
            let path = fixture.root.join("assets").join(format!("{id}.pdf"));
            fs::write(&path, bytes).unwrap();
            fixture.add(id, "pdf", Some(&path), name, None);
        }
        let transfer = export(
            &fixture.database,
            &["a".into(), "b".into()],
            &fixture.output(),
        )
        .expect("macOS treats the two spellings as one filename; preserve both originals");
        assert_eq!(transfer.files().len(), 3);
        assert_eq!(fs::read(&transfer.files()[0]).unwrap(), b"first original");
        assert_eq!(fs::read(&transfer.files()[1]).unwrap(), b"second original");
        assert!(transfer.files()[1]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(" (2).pdf"));
        let context = fs::read_to_string(transfer.context_file().unwrap()).unwrap();
        for path in &transfer.files()[..2] {
            assert!(context.contains(path.file_name().unwrap().to_str().unwrap()));
        }
        let db = rusqlite::Connection::open(&fixture.database).unwrap();
        let names: Vec<String> = db
            .prepare("SELECT json_extract(origin_json,'$.fileName') FROM stash_items ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, ["Caf\u{e9}.pdf", "Cafe\u{301}.pdf"]);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn an_original_cannot_alias_the_context_file_on_macos() {
        let fixture = Fixture::new();
        let path = fixture.root.join("assets/original.md");
        fs::write(&path, b"original bytes").unwrap();
        fixture.add(
            "a",
            "file",
            Some(&path),
            "StashDock - Cafe\u{301}.md",
            Some("## Caf\u{e9}\n\nEdited context"),
        );
        let transfer = export(&fixture.database, &["a".into()], &fixture.output()).unwrap();
        assert_eq!(fs::read(&transfer.files()[0]).unwrap(), b"original bytes");
        assert!(fs::read_to_string(transfer.context_file().unwrap())
            .unwrap()
            .contains("Edited context"));
        assert!(transfer.context_file().unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(" (2).md"));
    }
    #[test]
    fn mixed_selection_preserves_order_renames_collisions_and_deduplicates_shared_originals() {
        let fixture = Fixture::new();
        let a = fixture.root.join("assets/first.pdf");
        let b = fixture.root.join("assets/second.pdf");
        fs::write(&a, b"first").unwrap();
        fs::write(&b, b"second").unwrap();
        fixture.add("a", "pdf", Some(&a), "Same.pdf", None);
        fixture.add("b", "file", Some(&b), "same.PDF", None);
        fixture.add(
            "c",
            "pdf",
            Some(&a),
            "Same.pdf",
            Some("Exact edited context"),
        );
        fixture.add("n", "note", None, "", None);
        let transfer = export(
            &fixture.database,
            &["b".into(), "n".into(), "c".into(), "a".into()],
            &fixture.output(),
        )
        .unwrap();
        assert_eq!(transfer.files().len(), 3);
        assert_eq!(fs::read(&transfer.files()[0]).unwrap(), b"second");
        assert_eq!(fs::read(&transfer.files()[1]).unwrap(), b"first");
        assert_ne!(
            transfer.files()[0]
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_lowercase(),
            transfer.files()[1]
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_lowercase()
        );
        let context = fs::read_to_string(transfer.context_file().unwrap()).unwrap();
        assert!(context.contains("Exact edited context") && context.contains("Title n"));
    }
    #[test]
    fn note_and_link_use_text_without_creating_an_export_folder() {
        let fixture = Fixture::new();
        fixture.add("n", "note", None, "", None);
        fixture.add("w", "web", None, "", None);
        let output = fixture.output();
        let transfer = export(&fixture.database, &["n".into(), "w".into()], &output).unwrap();
        let Transfer::Text(text) = transfer else {
            panic!("Expected text transfer")
        };
        assert!(text.contains("### Note text\nUser supplemental content"));
        assert!(text.contains("## Title w"));
        assert!(!output.exists());
    }
    #[test]
    fn non_file_references_keep_the_exact_existing_markdown() {
        let fixture = Fixture::new();
        fixture.add("n", "web", None, "", Some("Exact override\n  whitespace"));
        let transfer = export(&fixture.database, &["n".into()], &fixture.output()).unwrap();
        assert_eq!(
            transfer.files(),
            [transfer.context_file().unwrap().to_path_buf()]
        );
        assert_eq!(
            fs::read_to_string(transfer.context_file().unwrap()).unwrap(),
            "Exact override\n  whitespace"
        );
    }
    #[test]
    fn sections_use_collision_safe_names_and_keep_note_text_in_context() {
        let fixture = Fixture::new();
        for (id, filename) in [("a", "one.pdf"), ("b", "two.pdf")] {
            let path = fixture.root.join("assets").join(filename);
            fs::write(&path, id.as_bytes()).unwrap();
            fixture.add(id, "pdf", Some(&path), "Report.pdf", None);
        }
        fixture.add("n", "note", None, "", None);
        let db = rusqlite::Connection::open(&fixture.database).unwrap();
        db.execute(
            "UPDATE stash_items SET title='Same title' WHERE id IN ('a','b')",
            [],
        )
        .unwrap();
        let transfer = export(
            &fixture.database,
            &["a".into(), "b".into(), "n".into()],
            &fixture.output(),
        )
        .unwrap();
        let text = fs::read_to_string(transfer.context_file().unwrap()).unwrap();
        assert!(text.contains("## Report.pdf") && text.contains("## Report (2).pdf"));
        assert!(!text.contains(&fixture.root.to_string_lossy().to_string()));
        assert_eq!(text.matches("User supplemental content").count(), 3);
        assert!(text.contains("### Note text"));
        assert_eq!(transfer.files().len(), 3);
        let origin: String = db
            .query_row(
                "SELECT origin_json FROM stash_items WHERE id='b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&origin).unwrap()["fileName"],
            "Report.pdf"
        );
    }
    #[test]
    fn missing_and_external_assets_fail_without_falling_back_to_path_text() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside.pdf");
        fs::write(&outside, "secret").unwrap();
        fixture.add("a", "pdf", Some(&outside), "outside.pdf", None);
        fixture.add(
            "b",
            "file",
            Some(&fixture.root.join("assets/missing.pdf")),
            "missing.pdf",
            None,
        );
        fixture.add("c", "file", None, "missing.pdf", None);
        for id in ["a", "b", "c", "not-found"] {
            assert!(export(&fixture.database, &[id.into()], &fixture.output()).is_err());
        }
        assert!(!fixture.output().exists());
        assert_eq!(fs::read_to_string(outside).unwrap(), "secret");
    }
    #[test]
    fn oversized_originals_clean_up_partial_exports_and_leave_originals_untouched() {
        let fixture = Fixture::new();
        let original = fixture.root.join("assets/large.pdf");
        fs::File::create(&original)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        fixture.add("a", "pdf", Some(&original), "large.pdf", None);
        assert!(export(&fixture.database, &["a".into()], &fixture.output())
            .unwrap_err()
            .contains("1 GB"));
        assert_eq!(fs::read_dir(fixture.output()).unwrap().count(), 0);
        assert_eq!(original.metadata().unwrap().len(), MAX_BYTES + 1);
    }
    #[test]
    fn filename_and_cleanup_guards_keep_paths_flat_and_do_not_traverse_directories() {
        let fixture = Fixture::new();
        let path = fixture.root.join("assets/one.pdf");
        fixture.add("a", "pdf", Some(&path), "../CON: secret.pdf", None);
        let items = library::reference_transfer_snapshot(&fixture.database, &["a".into()]).unwrap();
        let name = original_name(&items[0], &path);
        assert!(!name.contains('/') && !name.contains('\\') && !name.contains(':'));
        let mut item = items[0].clone();
        item.origin = Some(serde_json::json!({"fileName":"CON.pdf"}));
        assert_eq!(original_name(&item, &path), "File - CON.pdf");
        let root = fixture.output();
        fs::create_dir(&root).unwrap();
        let unrelated = root.join("Keep me");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("original.pdf"), "Keep").unwrap();
        discard_folder(&root, &unrelated);
        assert!(unrelated.join("original.pdf").exists());
    }
}
