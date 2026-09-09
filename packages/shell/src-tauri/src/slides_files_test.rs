use super::*;

fn pdf(dir: &Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    fs::write(&path, b"%PDF-1.4\nfixture").unwrap();
    path
}

#[test]
fn exact_companion_with_spaces_unicode_and_numeric_directory() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("03. IR").join("2026-09-09");
    fs::create_dir_all(&folder).unwrap();
    let selected = pdf(&folder, "발표 final.PDF");
    fs::write(
        selected.with_extension("md"),
        "\u{feff}## 1. 표지\n원본 대본",
    )
    .unwrap();
    let result = read_selected_pdf(&selected).unwrap();
    assert_eq!(result.pdf_name, "발표 final.PDF");
    assert_eq!(result.script_name.as_deref(), Some("발표 final.md"));
    assert_eq!(result.script_text.as_deref(), Some("## 1. 표지\n원본 대본"));
    assert!(!result.script_read_failed);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(result.pdf_base64)
            .unwrap(),
        fs::read(selected).unwrap()
    );
}

#[test]
fn absent_companion_does_not_search_other_names_or_directories() {
    let temp = tempfile::tempdir().unwrap();
    let selected = pdf(temp.path(), "deck.pdf");
    fs::write(temp.path().join("other.md"), "wrong").unwrap();
    fs::create_dir(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("nested/deck.md"), "wrong").unwrap();
    let result = read_selected_pdf(&selected).unwrap();
    assert!(result.script_name.is_none());
    assert!(result.script_text.is_none());
    assert!(!result.script_read_failed);
}

#[test]
fn invalid_or_oversized_companion_never_prevents_pdf_open() {
    let temp = tempfile::tempdir().unwrap();
    let selected = pdf(temp.path(), "deck.pdf");
    let script = selected.with_extension("md");
    fs::write(&script, [0xff, 0xfe]).unwrap();
    assert!(read_selected_pdf(&selected).unwrap().script_read_failed);
    fs::write(&script, vec![b'x'; MAX_SCRIPT_BYTES as usize + 1]).unwrap();
    let result = read_selected_pdf(&selected).unwrap();
    assert!(result.script_read_failed);
    assert!(result.script_text.is_none());
}

#[test]
fn directory_is_not_a_script_and_non_pdf_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let selected = pdf(temp.path(), "deck.pdf");
    fs::create_dir(selected.with_extension("md")).unwrap();
    assert!(read_selected_pdf(&selected).unwrap().script_read_failed);
    let other = pdf(temp.path(), "deck.txt");
    assert_eq!(read_selected_pdf(&other).unwrap_err(), "slides_not_pdf");
}

#[test]
fn bounded_reader_rejects_over_limit_and_preserves_empty_script() {
    let temp = tempfile::tempdir().unwrap();
    let selected = pdf(temp.path(), "deck.pdf");
    assert!(read_bounded(&selected, 2).is_err());
    fs::write(selected.with_extension("md"), "").unwrap();
    let result = read_selected_pdf(&selected).unwrap();
    assert_eq!(result.script_text.as_deref(), Some(""));
    assert!(!result.script_read_failed);
}

#[cfg(unix)]
#[test]
fn symlink_companion_cannot_read_another_file() {
    let temp = tempfile::tempdir().unwrap();
    let selected = pdf(temp.path(), "deck.pdf");
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("private.md"), "do not load").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("private.md"),
        selected.with_extension("md"),
    )
    .unwrap();
    assert!(read_selected_pdf(&selected).unwrap().script_read_failed);
}

#[test]
fn pptx_same_basename_markdown_wins_over_embedded_notes() {
    let temp = tempfile::tempdir().unwrap();
    let selected = temp.path().join("deck.pptx");
    fs::write(&selected, b"source").unwrap();
    fs::write(selected.with_extension("md"), "## external\n").unwrap();
    let notes = slides_import::PptxNotes {
        slide_count: 2,
        notes: vec![Some("embedded".into()), None],
    };
    let result = assemble_pptx_selection(&selected, b"%PDF-1.7".to_vec(), &notes).unwrap();
    assert_eq!(result.pdf_name, "deck.pptx");
    assert_eq!(result.script_name.as_deref(), Some("deck.md"));
    assert_eq!(result.script_text.as_deref(), Some("## external\n"));
    assert!(!result.script_read_failed);
    assert_eq!(fs::read(&selected).unwrap(), b"source");
}

#[test]
fn pptx_without_companion_uses_physical_note_order_and_blank_slots() {
    let temp = tempfile::tempdir().unwrap();
    let selected = temp.path().join("deck.pptx");
    fs::write(&selected, b"source").unwrap();
    let notes = slides_import::PptxNotes {
        slide_count: 3,
        notes: vec![Some("one".into()), None, Some("three".into())],
    };
    let result = assemble_pptx_selection(&selected, b"%PDF-1.7".to_vec(), &notes).unwrap();
    assert_eq!(result.script_name.as_deref(), Some("deck.md"));
    assert_eq!(
        result.script_text.as_deref(),
        Some("## 01.\none\n## 02.\n## 03.\nthree\n")
    );
    assert!(!result.script_read_failed);
}

#[test]
fn unreadable_pptx_companion_reports_failure_without_note_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let selected = temp.path().join("deck.pptx");
    fs::write(&selected, b"source").unwrap();
    fs::create_dir(selected.with_extension("md")).unwrap();
    let notes = slides_import::PptxNotes {
        slide_count: 1,
        notes: vec![Some("embedded".into())],
    };
    let result = assemble_pptx_selection(&selected, b"%PDF-1.7".to_vec(), &notes).unwrap();
    assert!(result.script_name.is_none());
    assert!(result.script_text.is_none());
    assert!(result.script_read_failed);
}
