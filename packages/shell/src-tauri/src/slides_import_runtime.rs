use super::*;
use super::slides_import_process::{hide_console, kill_child, spawn_owned_child};

#[derive(Debug, Clone)]
pub(super) struct Converter {
    pub(super) path: PathBuf,
    pub(super) version: String,
}

pub(super) fn cache_key(source: &Path, bytes: &[u8], converter: &Converter) -> String {
    let mut digest = Sha256::new();
    digest.update(CONVERTER_OPTIONS_VERSION.as_bytes());
    digest.update([0]);
    digest.update(converter.path.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(converter.version.as_bytes());
    digest.update([0]);
    digest.update(source.to_string_lossy().as_bytes());
    digest.update([0]);
    if let Ok(metadata) = fs::metadata(source) {
        digest.update(metadata.len().to_le_bytes());
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                digest.update(duration.as_secs().to_le_bytes());
                digest.update(duration.subsec_nanos().to_le_bytes());
            }
        }
    }
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

pub(super) fn cleanup_cache(root: &Path, active: Option<&Path>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // RAII handles ordinary failures. Also reclaim strictly named leftovers
        // from an abruptly terminated process once they are older than a job.
        let owned_tmp = entry.file_name().to_str().is_some_and(|name| {
            name.strip_prefix('.').and_then(|name| name.split_once(".tmp-"))
                .is_some_and(|(hash, suffix)| hash.len() == 64
                    && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && !suffix.is_empty() && suffix.len() <= 64
                    && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        });
        if owned_tmp && file_type.is_file() && !file_type.is_symlink() {
            if entry.metadata().ok().and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60)) {
                let _ = fs::remove_file(path);
            }
            continue;
        }
        if file_type.is_symlink()
            || path.extension().and_then(|value| value.to_str()) != Some("pdf")
            || !path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|value| {
                    value.len() == 64
                        && value.chars().all(|character| character.is_ascii_hexdigit())
                })
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let is_active = active.is_some_and(|active| active == path.as_path());
        files.push((path, metadata.len(), metadata.modified().ok(), is_active));
    }
    let now = SystemTime::now();
    for (path, _, modified, is_active) in &files {
        if !is_active
            && modified
                .and_then(|value| now.duration_since(value).ok())
                .is_some_and(|age| age > CACHE_MAX_AGE)
        {
            let _ = fs::remove_file(path);
        }
    }
    files.retain(|(path, _, _, _)| path.is_file());
    files.sort_by(|left, right| left.2.cmp(&right.2).then_with(|| left.0.cmp(&right.0)));
    let mut total = files.iter().map(|(_, size, _, _)| *size).sum::<u64>();
    while total > MAX_CACHE_BYTES || files.len() > MAX_CACHE_ENTRIES {
        let Some(index) = files.iter().position(|(_, _, _, is_active)| !is_active) else {
            break;
        };
        let (path, size, _, _) = files.remove(index);
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

pub(super) fn write_cache_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "PDF too large",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "cache root"))?;
    fs::create_dir_all(parent)?;
    let prefix = format!(".{}.tmp-", path.file_stem().unwrap_or_default().to_string_lossy());
    let mut tmp = tempfile::Builder::new().prefix(&prefix).tempfile_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(super) fn validate_converted_pdf(bytes: &[u8]) -> bool {
    if bytes.len() < 8 || bytes.len() as u64 > MAX_PDF_BYTES || !bytes.starts_with(b"%PDF-") {
        return false;
    }
    let has_eof = bytes.windows(5).any(|window| window == b"%%EOF");
    // Both spellings occur in valid PDFs: a producer may omit the optional
    // whitespace between PDF names (`/Type/Page`). Exclude the `/Pages` tree
    // marker by checking the complete page name.
    let has_page = [b"/Type /Page".as_slice(), b"/Type/Page".as_slice()]
        .iter()
        .any(|marker| bytes.windows(marker.len() + 1).any(|window| {
            window.starts_with(marker) && !window[marker.len()].is_ascii_alphabetic()
        }));
    has_eof && has_page
}

fn converter_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = std::env::var_os("NAIA_SLIDES_LIBREOFFICE") {
        if !value.is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if cfg!(target_os = "windows") {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let root = PathBuf::from(program_files).join("LibreOffice/program");
            candidates.push(root.join("soffice.com"));
            candidates.push(root.join("soffice.bin"));
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            let root = PathBuf::from(program_files_x86).join("LibreOffice/program");
            candidates.push(root.join("soffice.com"));
            candidates.push(root.join("soffice.bin"));
        }
        candidates.push(PathBuf::from("soffice.com"));
        candidates.push(PathBuf::from("soffice.bin"));
    }
    candidates.push(PathBuf::from("soffice"));
    candidates.push(PathBuf::from("libreoffice"));
    candidates
}

fn resolve_converter_candidate(candidate: &Path) -> Option<PathBuf> {
    if candidate.is_absolute() || candidate.components().count() > 1 {
        return accept_converter_path(candidate);
    }
    let path = std::env::var_os("PATH")?;
    for root in std::env::split_paths(&path) {
        let direct = root.join(candidate);
        if let Some(path) = accept_converter_path(&direct) {
            return Some(path);
        }
        #[cfg(windows)]
        {
            for suffix in [".exe", ".bin"] {
                let with_suffix = root.join(format!("{}{}", candidate.to_string_lossy(), suffix));
                if let Some(path) = accept_converter_path(&with_suffix) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn accept_converter_path(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    #[cfg(windows)]
    {
        // `soffice.exe` is a launcher which can leave `soffice.bin` running
        // after the launcher is killed. Use the worker binary so cancellation
        // owns exactly the child we spawned and cannot touch an existing
        // LibreOffice session.
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("soffice.exe"))
        {
            let console = path.with_file_name("soffice.com");
            if console.is_file() {
                return Some(console);
            }
            let worker = path.with_file_name("soffice.bin");
            return worker.is_file().then_some(worker);
        }
    }
    Some(path.to_path_buf())
}

const MAX_VERSION_OUTPUT_BYTES: usize = 64 * 1024;

fn drain_version_output<R: Read>(mut reader: R) -> Vec<u8> {
    let mut output = Vec::with_capacity(4096);
    let mut buffer = [0u8; 4096];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        let remaining = MAX_VERSION_OUTPUT_BYTES.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    output
}

fn join_version_output(reader: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

pub(super) fn find_converter(cancellation: &CancellationToken) -> ImportResult<Converter> {
    for candidate in converter_candidates() {
        if cancellation.is_cancelled() {
            return Err(ImportFailure::Cancelled.code().into());
        }
        let Some(path) = resolve_converter_candidate(&candidate) else {
            continue;
        };
        let mut command = Command::new(&path);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);
        let Ok((mut child, ownership)) = spawn_owned_child(&mut command) else {
            continue;
        };
        // Drain both pipes concurrently and cap the retained identity string.
        // A converter must not be able to block the probe by filling a pipe.
        let mut stdout_reader = child
            .stdout
            .take()
            .map(|stdout| std::thread::spawn(move || drain_version_output(stdout)));
        let mut stderr_reader = child
            .stderr
            .take()
            .map(|stderr| std::thread::spawn(move || drain_version_output(stderr)));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if cancellation.is_cancelled() {
                kill_child(&mut child, &ownership);
                let _ = child.wait();
                let _ = join_version_output(stdout_reader.take());
                let _ = join_version_output(stderr_reader.take());
                return Err(ImportFailure::Cancelled.code().into());
            }
            if std::time::Instant::now() >= deadline {
                kill_child(&mut child, &ownership);
                let _ = child.wait();
                let _ = join_version_output(stdout_reader.take());
                let _ = join_version_output(stderr_reader.take());
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    // If a launcher leaves a worker holding the pipes, close
                    // that owned process tree before joining the drainers.
                    ownership.terminate();
                    let stdout = join_version_output(stdout_reader.take());
                    let stderr = join_version_output(stderr_reader.take());
                    if status.success() {
                        let mut version = String::from_utf8_lossy(&stdout).trim().to_string();
                        if version.is_empty() {
                            version = String::from_utf8_lossy(&stderr).trim().to_string();
                        }
                        version.truncate(512);
                        if version.is_empty() {
                            break;
                        }
                        return Ok(Converter { path, version });
                    }
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => {
                    kill_child(&mut child, &ownership);
                    let _ = child.wait();
                    let _ = join_version_output(stdout_reader.take());
                    let _ = join_version_output(stderr_reader.take());
                    break;
                }
            }
        }
    }
    Err(ImportFailure::ConverterUnavailable.code().into())
}

pub(super) fn convert_with_libreoffice(
    source_bytes: &[u8],
    converter: &Converter,
    cache_root: &Path,
    cancellation: &CancellationToken,
) -> ImportResult<Vec<u8>> {
    let jobs_root = cache_root.join("jobs");
    fs::create_dir_all(&jobs_root)
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    cleanup_stale_job_dirs(&jobs_root);
    let job = tempfile::Builder::new().prefix("job-").tempdir_in(&jobs_root)
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    let job_dir = job.path();
    let profile_dir = job_dir.join("profile");
    let output_dir = job_dir.join("output");
    fs::create_dir_all(&profile_dir)
        .and_then(|_| fs::create_dir_all(&output_dir))
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    // Convert the exact bounded bytes we parsed. If the user replaces the
    // source after selection, the conversion still operates on this snapshot.
    let input_path = job_dir.join("input.pptx");
    fs::write(&input_path, source_bytes)
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    let profile_uri =
        file_uri(&profile_dir).ok_or_else(|| ImportFailure::ConversionFailed.code().to_string())?;
    let expected_output = output_dir.join("input.pdf");
    let filter_options = r#"{"ExportHiddenSlides":{"type":"boolean","value":"true"},"ExportNotesPages":{"type":"boolean","value":"false"},"UseLosslessCompression":{"type":"boolean","value":"true"},"ReduceImageResolution":{"type":"boolean","value":"false"}}"#;

    let mut command = Command::new(&converter.path);
    command
        .arg(format!("-env:UserInstallation={profile_uri}"))
        .arg("--headless")
        .arg("--nologo")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--nofirststartwizard")
        .arg("--norestore")
        .arg("--convert-to")
        .arg(format!("pdf:impress_pdf_Export:{filter_options}"))
        .arg("--outdir")
        .arg(&output_dir)
        .arg(&input_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let (mut child, ownership) = spawn_owned_child(&mut command)
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    let deadline = std::time::Instant::now() + CONVERSION_TIMEOUT;
    let status = loop {
        if cancellation.is_cancelled() {
            kill_child(&mut child, &ownership);
            let _ = child.wait();
            return Err(ImportFailure::Cancelled.code().into());
        }
        if std::time::Instant::now() >= deadline {
            kill_child(&mut child, &ownership);
            let _ = child.wait();
            return Err(ImportFailure::ConversionTimeout.code().into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                kill_child(&mut child, &ownership);
                let _ = child.wait();
                return Err(ImportFailure::ConversionFailed.code().into());
            }
        }
    };
    if !status.success() {
        return Err(ImportFailure::ConversionFailed.code().into());
    }
    let output_path = if expected_output.is_file() {
        expected_output
    } else {
        let mut pdfs = fs::read_dir(&output_dir)
            .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("pdf"))
            .filter(|path| path.is_file());
        let Some(path) = pdfs.next() else {
            return Err(ImportFailure::ConversionFailed.code().into());
        };
        if pdfs.next().is_some() {
            return Err(ImportFailure::ConversionFailed.code().into());
        }
        path
    };
    let pdf = match read_bounded(&output_path, MAX_PDF_BYTES) {
        Ok(pdf) => Ok(pdf),
        Err(_) => Err(ImportFailure::ConversionFailed.code().to_string()),
    };
    pdf
}

fn cleanup_stale_job_dirs(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    let max_age = Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let path = entry.path();
        let is_owned_job = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("job-"));
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !is_owned_job || file_type.is_symlink() || !metadata.is_dir() {
            continue;
        }
        if metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age)
        {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub(super) fn file_uri(path: &Path) -> Option<String> {
    let path = path.canonicalize().ok()?;
    // Let the URL implementation handle Windows verbatim (`\\?\\`) and UNC
    // paths. Hand-joining a `file:///` prefix turns a canonical Windows path
    // into `file:///%3F/D:/...`, which LibreOffice rejects as an invalid user
    // profile location.
    url::Url::from_directory_path(path)
        .ok()
        .map(|url| url.to_string())
}
