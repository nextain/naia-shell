use super::*;
use std::io::Write;

fn zip_fixture(slide_count: usize, notes: &[Option<&str>]) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut output);
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("ppt/presentation.xml", options).unwrap();
    let mut presentation = String::from(r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>"#);
    for index in 0..slide_count {
        presentation.push_str(&format!(
            r#"<p:sldId id="{}" r:id="rId{}"/>"#,
            256 + index,
            index + 1
        ));
    }
    presentation.push_str("</p:sldIdLst></p:presentation>");
    writer.write_all(presentation.as_bytes()).unwrap();

    writer
        .start_file("ppt/_rels/presentation.xml.rels", options)
        .unwrap();
    let mut rels = String::from(r#"<Relationships xmlns="r">"#);
    for index in 0..slide_count {
        rels.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{}.xml"/>"#,
            index + 1,
            index + 1
        ));
    }
    rels.push_str("</Relationships>");
    writer.write_all(rels.as_bytes()).unwrap();

    for index in 0..slide_count {
        writer
            .start_file(format!("ppt/slides/slide{}.xml", index + 1), options)
            .unwrap();
        writer.write_all(b"<p:sld/>").unwrap();
        writer
            .start_file(
                format!("ppt/slides/_rels/slide{}.xml.rels", index + 1),
                options,
            )
            .unwrap();
        let relation = format!(
            r#"<Relationships><Relationship Id="rNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide{}.xml"/></Relationships>"#,
            index + 1
        );
        writer.write_all(relation.as_bytes()).unwrap();
        writer
            .start_file(
                format!("ppt/notesSlides/notesSlide{}.xml", index + 1),
                options,
            )
            .unwrap();
        let note = notes.get(index).copied().flatten().unwrap_or("");
        writer
            .write_all(format!(r#"<p:notes><p:sp><p:txBody><a:p><a:r><a:t>{note}</a:t></a:r></a:p></p:txBody></p:sp></p:notes>"#).as_bytes())
            .unwrap();
    }
    writer.finish().unwrap();
    output.into_inner()
}

#[test]
fn parses_physical_order_and_keeps_blank_note_slots() {
    let bytes = zip_fixture(4, &[Some("first"), None, Some("third &amp; more"), None]);
    let parsed = parse_pptx_notes(&bytes).unwrap();
    assert_eq!(parsed.slide_count, 4);
    assert_eq!(parsed.notes[0].as_deref(), Some("first"));
    assert!(parsed.notes[1].is_none());
    assert_eq!(parsed.notes[2].as_deref(), Some("third & more"));
    assert!(parsed.notes[3].is_none());
    let script = parsed.script_markdown().unwrap();
    assert!(script.contains("## 01.\nfirst"));
    assert!(script.contains("## 02.\n## 03.\nthird & more"));
}

#[test]
fn rejects_invalid_or_unsafe_archives() {
    assert_eq!(
        parse_pptx_notes(b"not a zip").unwrap_err(),
        "slides_invalid_pptx"
    );
    let mut output = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut output);
    writer
        .start_file(
            "../ppt/presentation.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(b"bad").unwrap();
    writer.finish().unwrap();
    assert_eq!(
        parse_pptx_notes(&output.into_inner()).unwrap_err(),
        "slides_invalid_pptx"
    );
}

#[test]
fn korean_empty_notes_placeholder_is_not_narrated() {
    let parsed = parse_pptx_notes(&zip_fixture(1, &[Some("클릭하여 메모 추가")])).unwrap();
    assert_eq!(parsed.notes, vec![None]);
}

#[test]
fn failed_cache_persist_does_not_leave_temporary_files() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join(format!("{:064x}.pdf", 1));
    fs::create_dir(&destination).unwrap();
    assert!(slides_import_runtime::write_cache_atomically(&destination, b"pdf").is_err());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    assert!(destination.is_dir());
}

#[test]
fn stale_owned_cache_temporary_files_are_reclaimed_without_touching_fresh_or_unowned_files() {
    let temp = tempfile::tempdir().unwrap();
    let stale = temp.path().join(format!(".{:064x}.tmp-123", 1));
    let fresh = temp.path().join(format!(".{:064x}.tmp-Ab1234", 2));
    let unowned = temp.path().join(".personal.tmp-123");
    for path in [&stale, &fresh, &unowned] { fs::write(path, b"keep").unwrap(); }
    let old = SystemTime::now() - Duration::from_secs(48 * 60 * 60);
    File::options().write(true).open(&stale).unwrap()
        .set_times(fs::FileTimes::new().set_modified(old)).unwrap();
    cleanup_cache(temp.path(), None);
    assert!(!stale.exists());
    assert!(fresh.is_file());
    assert!(unowned.is_file());
}

#[test]
fn converter_spawn_failure_removes_job_source_and_profile() {
    let temp = tempfile::tempdir().unwrap();
    let converter = Converter { path: temp.path().join("missing-converter.exe"), version: "test".into() };
    assert!(slides_import_runtime::convert_with_libreoffice(
        b"private source snapshot", &converter, temp.path(), &CancellationToken::default()
    ).is_err());
    assert_eq!(fs::read_dir(temp.path().join("jobs")).unwrap().count(), 0);
}

#[test]
fn converter_options_require_hidden_pages_and_page_tree() {
    assert!(validate_converted_pdf(b"%PDF-1.7\n/Type /Page\n%%EOF"));
    assert!(validate_converted_pdf(b"%PDF-1.7\n/Type/Page\n%%EOF"));
    assert!(!validate_converted_pdf(b"%PDF-1.7\n%%EOF"));
    assert!(!validate_converted_pdf(b"%PDF-1.7\n/Type /Pages\n%%EOF"));
    assert!(!validate_converted_pdf(b"not a pdf /Type /Page %%EOF"));
}

#[test]
fn cache_key_changes_for_source_identity_and_content() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("deck.pptx");
    std::fs::write(&source, b"same").unwrap();
    let converter = Converter {
        path: PathBuf::from("soffice.bin"),
        version: "LibreOffice 25".into(),
    };
    let first = cache_key(&source, b"same", &converter);
    let second = cache_key(&source, b"different", &converter);
    let other = temp.path().join("other.pptx");
    std::fs::write(&other, b"same").unwrap();
    let third = cache_key(&other, b"same", &converter);
    assert_ne!(first, second);
    assert_ne!(first, third);
}

#[test]
fn cleanup_cache_counts_active_entries_and_ignores_unowned_pdfs() {
    let temp = tempfile::tempdir().unwrap();
    let active = temp.path().join(format!("{:064x}.pdf", 64));
    for index in 0..65u64 {
        let path = temp.path().join(format!("{:064x}.pdf", index));
        std::fs::write(path, [index as u8]).unwrap();
    }
    let unowned = temp.path().join("keep.pdf");
    std::fs::write(&unowned, b"leave this file alone").unwrap();

    cleanup_cache(temp.path(), Some(&active));

    let owned_count = std::fs::read_dir(temp.path())
        .unwrap()
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|value| {
                    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
                })
                && entry.path().extension().and_then(|value| value.to_str()) == Some("pdf")
        })
        .count();
    assert_eq!(owned_count, MAX_CACHE_ENTRIES);
    assert!(
        active.is_file(),
        "the active cache entry must survive eviction"
    );
    assert!(unowned.is_file(), "cleanup must not remove arbitrary PDFs");
}

#[test]
fn cancellation_token_is_local_and_repeatable() {
    let token = CancellationToken::default();
    assert!(!token.is_cancelled());
    token.cancel();
    token.cancel();
    assert!(token.is_cancelled());
}

#[test]
fn profile_uri_round_trips_canonical_paths_without_verbatim_prefix_encoding() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile space").join("한글");
    std::fs::create_dir_all(&profile).unwrap();
    let uri = file_uri(&profile).unwrap();
    let parsed = url::Url::parse(&uri).unwrap();
    assert_eq!(parsed.scheme(), "file");
    assert!(uri.starts_with("file:///"));
    assert!(!uri.contains("%3F"));
    assert!(parsed.to_file_path().unwrap().ends_with("한글"));
}

#[cfg(windows)]
#[test]
fn owned_child_job_can_terminate_its_process_without_detaching() {
    let mut command = std::process::Command::new("cmd.exe");
    command
        .args(["/C", "ping", "127.0.0.1", "-n", "30"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let (mut child, ownership) = spawn_owned_child(&mut command).unwrap();
    kill_child(&mut child, &ownership);
    let status = child.wait().unwrap();
    assert!(!status.success());
}

#[cfg(unix)]
#[test]
fn owned_unix_process_group_can_be_cancelled_without_touching_parent() {
    let mut command = std::process::Command::new("sh");
    command
        .args(["-c", "sleep 30"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let (mut child, ownership) = spawn_owned_child(&mut command).unwrap();
    assert_ne!(child.id() as libc::pid_t, unsafe { libc::getpgrp() });
    kill_child(&mut child, &ownership);
    let status = child.wait().unwrap();
    assert!(!status.success());
}
