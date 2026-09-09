//! Installed-app resource URLs must retain directory segments: JavaScript workers,
//! module imports and CSS resources resolve relative to the requesting asset URL.
use std::fs;
use std::io::{self, Write};
use std::path::Path;

const BACKUP_NAME: &str = "index.html.naia-asset-backup";

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode_uri_component(input: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(input.len());
    let mut rest = input.as_bytes();
    while let Some((&first, tail)) = rest.split_first() {
        if first == b'%' {
            let hex = std::str::from_utf8(tail.get(..2)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            rest = &tail[2..];
        } else {
            bytes.push(first);
            rest = tail;
        }
    }
    String::from_utf8(bytes).ok()
}

fn asset_localhost_url(full_path: &str) -> String {
    // Encode each filename, but leave actual separators visible to URL resolution.
    // A literal backslash in a Unix filename is not a directory separator.
    let enc = encode_uri_component(full_path).replace("%2F", "/");
    #[cfg(windows)]
    let enc = enc.replace("%5C", "/");
    #[cfg(any(windows, target_os = "android"))]
    {
        format!("http://asset.localhost/{enc}")
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        format!("asset://localhost/{enc}")
    }
}

fn rewrite_asset_value(value: &str, app_dir: &Path) -> String {
    let original = || value.to_string();
    if value.is_empty() || value.starts_with('#') || value.starts_with("//") {
        return original();
    }
    let legacy = value
        .strip_prefix("http://asset.localhost/")
        .or_else(|| value.strip_prefix("asset://localhost/"));
    if legacy.is_none() && value.contains(':') {
        return original();
    }
    // Queries/fragments belong to the URL, not the filename; encoded ?/# remain
    // filename characters after decoding and will be re-encoded.
    let raw = legacy.unwrap_or(value);
    let end = raw.find(['?', '#']).unwrap_or(raw.len());
    let Some(decoded) = decode_uri_component(&raw[..end]) else {
        return original();
    };
    let target = if legacy.is_some() {
        let path = Path::new(&decoded);
        if !path.is_absolute() {
            return original();
        }
        path.to_path_buf()
    } else {
        // A leading slash in Vite output is package-relative, not filesystem-root.
        let relative = decoded
            .strip_prefix("./")
            .unwrap_or(&decoded)
            .trim_start_matches('/');
        if relative.is_empty() || relative.contains(':') {
            return original();
        }
        app_dir.join(relative)
    };
    let Ok(root) = fs::canonicalize(app_dir) else {
        return original();
    };
    let Ok(canonical) = fs::canonicalize(&target) else {
        return original();
    };
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return original();
    }
    format!(
        "{}{}",
        asset_localhost_url(&target.to_string_lossy()),
        &raw[end..]
    )
}

fn rewrite_html(html: &str, app_dir: &Path) -> String {
    let mut result = String::with_capacity(html.len() + 512);
    let mut rest = html;
    const ATTRS: [(&str, char); 4] = [
        ("src=\"", '"'),
        ("href=\"", '"'),
        ("src='", '\''),
        ("href='", '\''),
    ];
    loop {
        let next = ATTRS
            .iter()
            .filter_map(|(a, quote)| rest.find(a).map(|i| (i, a.len(), *quote)))
            .min_by_key(|(i, _, _)| *i);
        let Some((idx, attr_len, quote)) = next else {
            result.push_str(rest);
            break;
        };
        let start = idx + attr_len;
        let Some(rel_end) = rest[start..].find(quote) else {
            result.push_str(rest);
            break;
        };
        let end = start + rel_end;
        result.push_str(&rest[..start]);
        result.push_str(&rewrite_asset_value(&rest[start..end], app_dir));
        result.push(quote);
        rest = &rest[end + 1..];
    }
    result
}

/// Used both after installation and when discovering older installed packages.
/// Keep the first pre-migration HTML; avoid writes entirely once URLs are repaired.
/// Never follow an index/backup symlink, and keep the existing protocol scope.
pub(crate) fn rewrite_installed_app_asset_urls(app_dir: &Path) -> io::Result<()> {
    let index_path = app_dir.join("index.html");
    let metadata = match fs::symlink_metadata(&index_path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid installed app HTML",
        ));
    }
    let root = fs::canonicalize(app_dir)?;
    if !fs::canonicalize(&index_path)?.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Installed app HTML outside package",
        ));
    }
    let html = fs::read_to_string(&index_path)?;
    let result = rewrite_html(&html, app_dir);
    if result == html {
        return Ok(());
    }

    let backup = app_dir.join(BACKUP_NAME);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
    {
        Ok(mut file) => {
            file.write_all(html.as_bytes())?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(&backup)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Invalid installed app HTML backup",
                ));
            }
        }
        Err(error) => return Err(error),
    }
    fs::write(index_path, result)
}

#[cfg(test)]
#[path = "app_assets_test.rs"]
mod tests;
