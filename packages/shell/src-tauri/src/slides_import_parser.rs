use super::*;

pub(crate) fn parse_pptx_notes(bytes: &[u8]) -> ImportResult<PptxNotes> {
    if bytes.len() as u64 > MAX_PPTX_BYTES || !looks_like_zip(bytes) {
        return Err(ImportFailure::InvalidPptx.code().into());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| ImportFailure::InvalidPptx.code().to_string())?;
    if archive.len() == 0 || archive.len() > MAX_ZIP_ENTRIES {
        return Err(ImportFailure::InvalidPptx.code().into());
    }

    let mut names = Vec::with_capacity(archive.len());
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| ImportFailure::InvalidPptx.code().to_string())?;
        let name = file.name().to_string();
        if !safe_zip_name(&name) {
            return Err(ImportFailure::InvalidPptx.code().into());
        }
        if file.size() > MAX_XML_BYTES && is_xml_entry(&name) {
            return Err(ImportFailure::InvalidPptx.code().into());
        }
        total_uncompressed = total_uncompressed.saturating_add(file.size());
        if total_uncompressed > MAX_ZIP_TOTAL_BYTES {
            return Err(ImportFailure::InvalidPptx.code().into());
        }
        names.push(name);
    }

    let presentation = read_zip_entry(&mut archive, "ppt/presentation.xml", MAX_XML_BYTES)?
        .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
    let presentation_rels = read_zip_entry(
        &mut archive,
        "ppt/_rels/presentation.xml.rels",
        MAX_XML_BYTES,
    )?
    .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
    let relationships = parse_relationships(&presentation_rels)?;
    let slide_ids = parse_slide_ids(&presentation)?;
    if slide_ids.is_empty() || slide_ids.len() > MAX_SLIDES {
        return Err(ImportFailure::InvalidPptx.code().into());
    }

    let mut slide_targets = Vec::with_capacity(slide_ids.len());
    for slide_id in &slide_ids {
        let target = relationships
            .get(&slide_id.rel_id)
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
        if target.external {
            return Err(ImportFailure::InvalidPptx.code().into());
        }
        let raw_target = target.target.trim_start_matches('/');
        let target_path = if raw_target.starts_with("ppt/") {
            raw_target.to_string()
        } else {
            format!("ppt/{raw_target}")
        };
        let normalized = normalize_zip_path(&target_path)
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
        if !normalized.starts_with("ppt/") || !names.iter().any(|name| name == &normalized) {
            return Err(ImportFailure::InvalidPptx.code().into());
        }
        slide_targets.push(normalized);
    }

    let mut notes = Vec::with_capacity(slide_targets.len());
    for slide_target in &slide_targets {
        let rels_name = slide_relationships_name(slide_target)
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
        let note_target = match read_zip_entry(&mut archive, &rels_name, MAX_XML_BYTES)? {
            Some(rels) => parse_notes_target(&rels, slide_target)?,
            None => None,
        };
        let Some(note_target) = note_target else {
            notes.push(None);
            continue;
        };
        let note_xml = read_zip_entry(&mut archive, &note_target, MAX_XML_BYTES)?;
        let note = note_xml
            .as_deref()
            .map(extract_note_text)
            .transpose()?
            .filter(|text| !text.is_empty());
        notes.push(note);
    }

    Ok(PptxNotes {
        slide_count: slide_targets.len(),
        notes,
    })
}

fn conversion_mutex() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(super) fn wait_for_conversion_guard(
    cancellation: &CancellationToken,
) -> ImportResult<MutexGuard<'static, ()>> {
    let started = std::time::Instant::now();
    loop {
        match conversion_mutex().try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {
                if cancellation.is_cancelled() {
                    return Err(ImportFailure::Cancelled.code().into());
                }
                if started.elapsed() >= CONVERSION_TIMEOUT {
                    return Err(ImportFailure::ConversionTimeout.code().into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

pub(super) fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded file",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(limit) as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded file",
        ));
    }
    Ok(bytes)
}

pub(super) fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && matches!(&bytes[..4], b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08")
}

fn is_xml_entry(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".xml") || name.to_ascii_lowercase().ends_with(".rels")
}

fn safe_zip_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && !Path::new(name).is_absolute()
        && Path::new(name)
            .components()
            .all(|component| matches!(component, Component::Normal(value) if !value.is_empty()))
}

fn normalize_zip_path(path: &str) -> Option<String> {
    if path.starts_with('/') || path.contains('\\') {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn read_zip_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> ImportResult<Option<Vec<u8>>> {
    let Ok(mut entry) = archive.by_name(name) else {
        return Ok(None);
    };
    if entry.is_dir() || entry.size() > limit {
        return Err(ImportFailure::InvalidPptx.code().into());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|_| ImportFailure::InvalidPptx.code().to_string())?;
    if bytes.len() as u64 > limit {
        return Err(ImportFailure::InvalidPptx.code().into());
    }
    Ok(Some(bytes))
}

#[derive(Debug, Clone)]
struct Relationship {
    target: String,
    external: bool,
}

fn parse_relationships(xml: &[u8]) -> ImportResult<HashMap<String, Relationship>> {
    let mut result = HashMap::new();
    for event in xml_events(xml)? {
        let element = match event {
            Event::Start(element) | Event::Empty(element) => element,
            _ => continue,
        };
        if element.local_name().as_ref() != b"Relationship" {
            continue;
        }
        let attrs = event_attributes(&element)?;
        let id = attrs
            .get("Id")
            .cloned()
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
        let target = attrs
            .get("Target")
            .cloned()
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
        let external = attrs
            .get("TargetMode")
            .is_some_and(|value| value.eq_ignore_ascii_case("external"));
        result.insert(id, Relationship { target, external });
    }
    if result.is_empty() {
        Err(ImportFailure::InvalidPptx.code().into())
    } else {
        Ok(result)
    }
}

#[derive(Debug, Clone)]
struct SlideId {
    rel_id: String,
}

fn parse_slide_ids(xml: &[u8]) -> ImportResult<Vec<SlideId>> {
    let mut result = Vec::new();
    for event in xml_events(xml)? {
        let element = match event {
            Event::Start(element) | Event::Empty(element) => element,
            _ => continue,
        };
        if element.local_name().as_ref() != b"sldId" {
            continue;
        }
        let attrs = event_attributes(&element)?;
        let rel_id = attrs
            .iter()
            .find_map(|(name, value)| name.ends_with(":id").then_some(value.clone()))
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())?;
        result.push(SlideId { rel_id });
    }
    Ok(result)
}

fn slide_relationships_name(slide_target: &str) -> Option<String> {
    let slash = slide_target.rfind('/')?;
    let parent = &slide_target[..slash];
    let filename = &slide_target[slash + 1..];
    Some(format!("{parent}/_rels/{filename}.rels"))
}

fn parse_notes_target(xml: &[u8], slide_target: &str) -> ImportResult<Option<String>> {
    for event in xml_events(xml)? {
        let element = match event {
            Event::Start(element) | Event::Empty(element) => element,
            _ => continue,
        };
        if element.local_name().as_ref() != b"Relationship" {
            continue;
        }
        let attrs = event_attributes(&element)?;
        let Some(relationship_type) = attrs.get("Type") else {
            continue;
        };
        if !relationship_type.ends_with("/notesSlide") {
            continue;
        }
        if attrs
            .get("TargetMode")
            .is_some_and(|value| value.eq_ignore_ascii_case("external"))
        {
            return Ok(None);
        }
        let Some(target) = attrs.get("Target") else {
            return Err(ImportFailure::InvalidPptx.code().into());
        };
        let Some(slash) = slide_target.rfind('/') else {
            return Err(ImportFailure::InvalidPptx.code().into());
        };
        let parent = &slide_target[..slash];
        let combined = if target.starts_with('/') {
            target.trim_start_matches('/').to_string()
        } else {
            format!("{parent}/{target}")
        };
        return normalize_zip_path(&combined)
            .ok_or_else(|| ImportFailure::InvalidPptx.code().to_string())
            .map(Some);
    }
    Ok(None)
}

fn xml_events(xml: &[u8]) -> ImportResult<Vec<Event<'static>>> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut events = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(event) => events.push(event.into_owned()),
            Err(_) => return Err(ImportFailure::InvalidPptx.code().into()),
        }
        buffer.clear();
    }
    Ok(events)
}

fn event_attributes(
    element: &quick_xml::events::BytesStart<'_>,
) -> ImportResult<HashMap<String, String>> {
    let mut result = HashMap::new();
    for attribute in element.attributes().with_checks(true) {
        let attribute = attribute.map_err(|_| ImportFailure::InvalidPptx.code().to_string())?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
        let value = attribute
            .unescape_value()
            .map_err(|_| ImportFailure::InvalidPptx.code().to_string())?
            .into_owned();
        result.insert(key, value);
    }
    Ok(result)
}

fn extract_note_text(xml: &[u8]) -> ImportResult<String> {
    let events = xml_events(xml)?;
    let mut all_shapes = Vec::new();
    let mut body_shapes = Vec::new();
    let mut shapes: Vec<(bool, String)> = Vec::new();
    let mut in_text = false;
    for event in events {
        match event {
            Event::Start(element) => {
                let name = element.local_name();
                if name.as_ref() == b"sp" {
                    shapes.push((false, String::new()));
                } else if name.as_ref() == b"t" {
                    in_text = true;
                } else if name.as_ref() == b"br" {
                    if let Some((_, text)) = shapes.last_mut() {
                        text.push('\n');
                    }
                }
            }
            Event::Empty(element) => {
                let name = element.local_name();
                if name.as_ref() == b"ph" {
                    let attrs = event_attributes(&element)?;
                    if attrs
                        .get("type")
                        .is_some_and(|value| value.eq_ignore_ascii_case("body"))
                    {
                        if let Some((is_body, _)) = shapes.last_mut() {
                            *is_body = true;
                        }
                    }
                } else if name.as_ref() == b"br" {
                    if let Some((_, text)) = shapes.last_mut() {
                        text.push('\n');
                    }
                }
            }
            Event::Text(text) if in_text => {
                let decoded = text
                    .unescape()
                    .map_err(|_| ImportFailure::InvalidPptx.code().to_string())?;
                if let Some((_, shape_text)) = shapes.last_mut() {
                    shape_text.push_str(&decoded);
                } else {
                    all_shapes.push(decoded.into_owned());
                }
            }
            Event::CData(text) if in_text => {
                let value = String::from_utf8_lossy(text.as_ref()).into_owned();
                if let Some((_, shape_text)) = shapes.last_mut() {
                    shape_text.push_str(&value);
                } else {
                    all_shapes.push(value);
                }
            }
            Event::End(element) => {
                let name = element.local_name();
                if name.as_ref() == b"t" {
                    in_text = false;
                } else if name.as_ref() == b"p" {
                    if let Some((_, text)) = shapes.last_mut() {
                        if !text.ends_with('\n') {
                            text.push('\n');
                        }
                    }
                } else if name.as_ref() == b"sp" {
                    if let Some((is_body, text)) = shapes.pop() {
                        if !text.is_empty() {
                            all_shapes.push(text.clone());
                            if is_body {
                                body_shapes.push(text);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if all_shapes.iter().map(String::len).sum::<usize>() > MAX_NOTES_BYTES {
            return Err(ImportFailure::InvalidPptx.code().into());
        }
    }
    let selected = if body_shapes.is_empty() {
        all_shapes
    } else {
        body_shapes
    };
    let normalized = selected
        .join("\n")
        .replace('\r', "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let text = normalized.trim().to_string();
    Ok(
        if matches!(
            text.as_str(),
            "Click to add notes" | "Click to add notes." | "클릭하여 메모 추가"
        ) {
            String::new()
        } else {
            text
        },
    )
}
