//! STT model catalog and download management.
//!
//! Provides a unified catalog of offline STT models (Vosk, Whisper)
//! with download/delete/status commands exposed to the frontend.

use futures_util::StreamExt;
use log::info;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Base directory name for STT models under app_data_dir
const STT_MODELS_DIR: &str = "stt-models";

// ── Model catalog ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttModelInfo {
    pub engine: String,         // "vosk" | "whisper"
    pub model_id: String,       // unique key, e.g. "vosk-small-ko" or "whisper-medium"
    pub model_name: String,     // display name
    pub language: String,       // "ko-KR", "multilingual", etc.
    pub size_mb: u32,           // download size in MB
    pub wer: String,            // e.g. "28.1%", "~12%"
    pub download_url: String,   // direct download URL
    pub description: String,    // short note
    pub downloaded: bool,       // filled at runtime
    pub ready: bool,            // engine backend available
    pub gpu_required: bool,     // true if GPU recommended for real-time
    pub min_vram_mb: u32,       // minimum VRAM (MB) for GPU inference, 0 = CPU ok
    pub ram_mb: u32,            // peak RAM for CPU inference
    pub recommendation: String, // "recommended" | "slow" | "not-recommended" | ""
}

/// Detect system GPU VRAM, total RAM, and CPU capability for model recommendations.
/// Cached after first call to avoid repeated nvidia-smi spawns.
fn detect_hardware() -> (u32, u32, bool) {
    use std::sync::OnceLock;
    static HW: OnceLock<(u32, u32, bool)> = OnceLock::new();
    *HW.get_or_init(|| {
        let total_ram_mb = {
            let mut sys = sysinfo::System::new();
            sys.refresh_memory();
            (sys.total_memory() / 1024 / 1024) as u32
        };
        let gpu_vram_mb = detect_nvidia_vram().unwrap_or(0);
        let has_avx = detect_avx_support();
        info!(
            "[STT] Hardware detected: RAM={}MB, GPU VRAM={}MB, AVX={}",
            total_ram_mb, gpu_vram_mb, has_avx
        );
        (total_ram_mb, gpu_vram_mb, has_avx)
    })
}

/// Check if CPU supports AVX instructions.
/// whisper.cpp uses AVX/AVX2 heavily — without it, CPU inference is ~5-10x slower.
fn detect_avx_support() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        is_x86_feature_detected!("avx")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

fn detect_nvidia_vram() -> Option<u32> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.trim().lines().next()?.trim().parse::<u32>().ok()
}

/// Compute recommendation for each model based on hardware.
fn compute_recommendation(
    model: &SttModelInfo,
    total_ram_mb: u32,
    gpu_vram_mb: u32,
    has_avx: bool,
) -> String {
    let has_gpu = gpu_vram_mb > 0;

    if model.engine == "vosk" {
        return "recommended".into();
    }

    // Whisper without AVX is unusable on any model — CPU inference is 5-10x slower
    if !has_gpu && !has_avx {
        return "not-recommended".into();
    }

    // GPU can handle this model — recommended
    if has_gpu && gpu_vram_mb >= model.min_vram_mb {
        return "recommended".into();
    }

    // No sufficient GPU — check CPU feasibility
    // gpu_required means RTF > 1.0 on typical CPUs (i5 class with AVX2)
    if model.gpu_required {
        return "not-recommended".into();
    }

    // CPU-capable model (has AVX) — check RAM
    if total_ram_mb >= model.ram_mb + 2000 {
        "recommended".into()
    } else {
        "slow".into()
    }
}

/// Returns the full model catalog with download status and hardware-based recommendations.
pub fn get_model_catalog(app: &AppHandle) -> Vec<SttModelInfo> {
    let models_dir = get_stt_models_dir(app);
    let (total_ram_mb, gpu_vram_mb, has_avx) = detect_hardware();
    let mut catalog = build_catalog();
    for model in &mut catalog {
        let model_path = models_dir.join(&model.model_id);
        model.downloaded = model_path.exists();
        model.recommendation = compute_recommendation(model, total_ram_mb, gpu_vram_mb, has_avx);
    }
    catalog
}

fn vosk(id: &str, name: &str, lang: &str, size_mb: u32, wer: &str) -> SttModelInfo {
    SttModelInfo {
        engine: "vosk".into(),
        model_id: id.into(),
        model_name: name.into(),
        language: lang.into(),
        size_mb,
        wer: wer.into(),
        download_url: format!("https://alphacephei.com/vosk/models/{id}.zip"),
        description: String::new(),
        downloaded: false,
        ready: true,
        gpu_required: false,
        min_vram_mb: 0,
        ram_mb: size_mb * 2,           // vosk RAM ≈ 2x model size
        recommendation: String::new(), // filled at runtime
    }
}

fn build_catalog() -> Vec<SttModelInfo> {
    vec![
        // ── Vosk models (12 languages) ──
        vosk(
            "vosk-model-small-ko-0.22",
            "Vosk Korean",
            "ko-KR",
            82,
            "28.1%",
        ),
        vosk(
            "vosk-model-small-en-us-0.15",
            "Vosk English",
            "en-US",
            40,
            "9.85%",
        ),
        vosk("vosk-model-small-cn-0.22", "Vosk Chinese", "zh-CN", 42, "—"),
        vosk(
            "vosk-model-small-ja-0.22",
            "Vosk Japanese",
            "ja-JP",
            48,
            "—",
        ),
        vosk("vosk-model-small-es-0.42", "Vosk Spanish", "es-ES", 39, "—"),
        vosk("vosk-model-small-fr-0.22", "Vosk French", "fr-FR", 41, "—"),
        vosk("vosk-model-small-de-0.15", "Vosk German", "de-DE", 45, "—"),
        vosk("vosk-model-small-ru-0.22", "Vosk Russian", "ru-RU", 45, "—"),
        vosk(
            "vosk-model-small-pt-0.3",
            "Vosk Portuguese",
            "pt-BR",
            31,
            "—",
        ),
        vosk("vosk-model-small-it-0.22", "Vosk Italian", "it-IT", 48, "—"),
        vosk(
            "vosk-model-small-vn-0.4",
            "Vosk Vietnamese",
            "vi-VN",
            32,
            "—",
        ),
        vosk("vosk-model-small-hi-0.22", "Vosk Hindi", "hi-IN", 42, "—"),
        // ── Whisper models ──
        SttModelInfo {
            engine: "whisper".into(),
            model_id: "whisper-tiny".into(),
            model_name: "Whisper Tiny".into(),
            language: "multilingual".into(),
            size_mb: 75,
            wer: "~40%".into(),
            download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
                .into(),
            description: "Fast, low quality. Not recommended for Korean.".into(),
            downloaded: false,
            ready: true,
            gpu_required: false,
            min_vram_mb: 150,
            ram_mb: 273,
            recommendation: String::new(),
        },
        SttModelInfo {
            engine: "whisper".into(),
            model_id: "whisper-base".into(),
            model_name: "Whisper Base".into(),
            language: "multilingual".into(),
            size_mb: 142,
            wer: "~30%".into(),
            download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
                .into(),
            description: "Similar quality to Vosk small.".into(),
            downloaded: false,
            ready: true,
            gpu_required: false,
            min_vram_mb: 300,
            ram_mb: 388,
            recommendation: String::new(),
        },
        SttModelInfo {
            engine: "whisper".into(),
            model_id: "whisper-small".into(),
            model_name: "Whisper Small".into(),
            language: "multilingual".into(),
            size_mb: 466,
            wer: "~20%".into(),
            download_url:
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin".into(),
            description: "Noticeable improvement over Vosk.".into(),
            downloaded: false,
            ready: true,
            gpu_required: true,
            min_vram_mb: 900,
            ram_mb: 852,
            recommendation: String::new(),
        },
        SttModelInfo {
            engine: "whisper".into(),
            model_id: "whisper-medium".into(),
            model_name: "Whisper Medium".into(),
            language: "multilingual".into(),
            size_mb: 1500,
            wer: "~12%".into(),
            download_url:
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin".into(),
            description: "Recommended. Good accuracy for Korean.".into(),
            downloaded: false,
            ready: true,
            gpu_required: true,
            min_vram_mb: 2500,
            ram_mb: 2100,
            recommendation: String::new(),
        },
        SttModelInfo {
            engine: "whisper".into(),
            model_id: "whisper-large-v3".into(),
            model_name: "Whisper Large v3".into(),
            language: "multilingual".into(),
            size_mb: 3000,
            wer: "~8%".into(),
            download_url:
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin".into(),
            description: "Best quality. Large download.".into(),
            downloaded: false,
            ready: true,
            gpu_required: true,
            min_vram_mb: 5000,
            ram_mb: 3900,
            recommendation: String::new(),
        },
    ]
}

// ── File system helpers ────────────────────────────────────────────

fn get_stt_models_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = base.join(STT_MODELS_DIR);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Check if old vosk-models dir has models and migrate them.
pub fn migrate_legacy_vosk_models(app: &AppHandle) {
    let base = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let legacy_dir = base.join("vosk-models");
    let new_dir = base.join(STT_MODELS_DIR);
    let _ = fs::create_dir_all(&new_dir);

    if legacy_dir.exists() {
        if let Ok(entries) = fs::read_dir(&legacy_dir) {
            for entry in entries.flatten() {
                if entry.metadata().map(|m| m.is_dir()).unwrap_or(false) {
                    let name = entry.file_name();
                    let dest = new_dir.join(&name);
                    if !dest.exists() {
                        // Move instead of copy
                        if fs::rename(entry.path(), &dest).is_ok() {
                            info!("[stt-models] Migrated legacy model: {:?}", name);
                        }
                    }
                }
            }
        }
    }
}

// ── Download ───────────────────────────────────────────────────────

/// Download a model by model_id. Emits progress events.
pub async fn download_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let catalog = build_catalog();
    let model = catalog
        .iter()
        .find(|m| m.model_id == model_id)
        .ok_or_else(|| format!("Unknown model: {model_id}"))?
        .clone();

    let models_dir = get_stt_models_dir(&app);
    let model_path = models_dir.join(&model.model_id);

    if model_path.exists() {
        return Ok(()); // Already downloaded
    }

    info!(
        "[stt-models] Downloading {} ({} MB) from {}",
        model.model_id, model.size_mb, model.download_url
    );

    // Emit start
    let _ = app.emit(
        "stt://download-progress",
        serde_json::json!({
            "status": "downloading",
            "model": model.model_id,
            "progress": 0,
        }),
    );

    // Download with streaming progress
    let response = reqwest::get(&model.download_url)
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let total_size = response
        .content_length()
        .unwrap_or((model.size_mb as u64) * 1024 * 1024);
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::with_capacity(total_size as usize);
    let mut stream = response.bytes_stream();

    let mut last_pct: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read failed: {e}"))?;
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        // Emit progress (download phase = 0..80%)
        let pct = (downloaded * 80 / total_size).min(80);
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit(
                "stt://download-progress",
                serde_json::json!({
                    "status": "downloading",
                    "model": model.model_id,
                    "progress": pct,
                }),
            );
        }
    }

    // Process based on file type
    if model.download_url.ends_with(".zip") {
        // Vosk models come as zip — extract (80..95%)
        let _ = app.emit(
            "stt://download-progress",
            serde_json::json!({
                "status": "extracting",
                "model": model.model_id,
                "progress": 85,
            }),
        );

        let cursor = std::io::Cursor::new(bytes);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| format!("Zip open failed: {e}"))?;

        // Vosk zips contain a top-level directory (the model name)
        // Extract to models_dir, the zip's top-level dir becomes the model dir
        let _ = fs::create_dir_all(&models_dir);
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Zip entry failed: {e}"))?;
            let outpath = models_dir.join(file.mangled_name());

            if file.name().ends_with('/') {
                let _ = fs::create_dir_all(&outpath);
            } else {
                if let Some(p) = outpath.parent() {
                    let _ = fs::create_dir_all(p);
                }
                let mut outfile =
                    fs::File::create(&outpath).map_err(|e| format!("File create failed: {e}"))?;
                std::io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("File write failed: {e}"))?;
            }
        }
    } else {
        // Whisper models are single .bin files — save directly
        let _ = fs::create_dir_all(&model_path);
        let bin_path = model_path.join("model.bin");
        let mut file =
            fs::File::create(&bin_path).map_err(|e| format!("File create failed: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("File write failed: {e}"))?;
    }

    let _ = app.emit(
        "stt://download-progress",
        serde_json::json!({
            "status": "complete",
            "model": model.model_id,
            "progress": 100,
        }),
    );

    info!("[stt-models] Download complete: {}", model.model_id);
    Ok(())
}

/// Delete a downloaded model.
pub fn delete_model(app: &AppHandle, model_id: &str) -> Result<(), String> {
    // Validate no path traversal
    if model_id.contains("..") || model_id.contains('/') || model_id.contains('\\') {
        return Err("Invalid model ID".into());
    }

    let models_dir = get_stt_models_dir(app);
    let model_path = models_dir.join(model_id);

    if model_path.exists() {
        fs::remove_dir_all(&model_path).map_err(|e| format!("Delete failed: {e}"))?;
        info!("[stt-models] Deleted model: {}", model_id);
    }

    Ok(())
}
