//! 로컬 음성 런타임의 두 축 — 운영체제와 하드웨어.
//!
//! 프로파일은 원래 `windows_trt_6g` 문자열 하나였고, 그 리터럴이 매니페스트
//! 검증·활성화 계약·VRAM 판정·기동 게이트에 흩어져 직접 비교됐다. 축처럼
//! 생겼지만 값이 하나뿐이라 축이 아니었다. Linux 를 얹으면 리터럴이 둘로 늘고
//! BC-250 을 얹으면 셋으로 늘며, 그때마다 흩어진 자리를 전부 다시 훑어야 한다.
//!
//! 여기서는 축을 둘로 나눈다.
//!
//! * [`HostOs`] — 파일이 어디 놓이고 무엇으로 불리는가. 실행기 이름, 컴파일된
//!   모듈의 확장자, 공유 라이브러리를 찾는 환경 변수가 여기 달린다.
//! * [`HardwareProfile`] — 무엇으로 계산하는가. 가속기와 그것이 요구하는 VRAM.
//!
//! 프로파일은 이 둘의 곱일 뿐이다. 새 기계는 [`PROFILES`] 에 행 하나를 더하면
//! 들어온다. 운영체제가 같으면 배치를 다시 적지 않고, 가속기가 같으면 요구
//! 사항을 다시 적지 않는다.

/// 런타임이 도는 운영체제. 파일 배치와 라이브러리 탐색 규약이 여기 달린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Windows,
    Linux,
}

/// 무엇으로 계산하는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accelerator {
    /// NVIDIA + TensorRT.
    TensorRtCuda,
    /// AMD + ROCm. BC-250 대비 — 실기에서 재기 전까지는 선언만 있다.
    Rocm,
}

/// 운영체제 축. 같은 운영체제를 쓰는 프로파일은 이것을 공유한다.
#[derive(Debug, Clone, Copy)]
pub struct OsLayout {
    /// 번들 안에서 파이썬 실행기가 놓이는 자리.
    pub python_relative: &'static str,
    /// 컴파일된 파이썬 모듈의 확장자. Windows 는 `pyd`, Linux 는 `so`.
    pub compiled_module_extension: &'static str,
    /// 번들 안 site-packages 의 자리.
    pub site_packages_relative: &'static str,
    /// 모델 준비 스크립트.
    pub prepare_script: &'static str,
    /// 공유 라이브러리를 찾는 환경 변수. Windows 는 `PATH`, Linux 는
    /// `LD_LIBRARY_PATH`. TensorRT 의 `.dll`/`.so` 가 이것으로 잡힌다.
    pub library_path_var: &'static str,
}

const WINDOWS_LAYOUT: OsLayout = OsLayout {
    python_relative: "python/python.exe",
    compiled_module_extension: "pyd",
    site_packages_relative: "python/Lib/site-packages",
    prepare_script: "prepare-voxcpm2-model.ps1",
    library_path_var: "PATH",
};

const LINUX_LAYOUT: OsLayout = OsLayout {
    python_relative: "python/bin/python3",
    compiled_module_extension: "so",
    site_packages_relative: "python/lib/python3.10/site-packages",
    prepare_script: "prepare-voxcpm2-model.sh",
    library_path_var: "LD_LIBRARY_PATH",
};

/// 하드웨어 축. 같은 가속기를 쓰는 프로파일은 이것을 공유한다.
#[derive(Debug, Clone, Copy)]
pub struct HardwareProfile {
    pub accelerator: Accelerator,
    /// 런타임이 자기를 뭐라고 부르는지. 건강 확인 응답과 대조한다.
    pub service: &'static str,
    pub backend: &'static str,
    /// 이 가속기가 요구하는 최소 VRAM.
    pub min_vram_gb: f64,
    /// 어느 카드를 보여 줄지 정하는 환경 변수. NVIDIA 는
    /// `CUDA_VISIBLE_DEVICES`, AMD 는 `ROCR_VISIBLE_DEVICES`.
    pub visible_devices_var: &'static str,
    /// 번들 안에서 가속기 공유 라이브러리가 놓이는 자리. site-packages 아래
    /// 상대 경로다 — 운영체제마다 site-packages 위치가 다르므로 그 앞은
    /// [`OsLayout`] 이 붙인다.
    pub library_dir_in_site_packages: &'static str,
}

const TRT_6G: HardwareProfile = HardwareProfile {
    accelerator: Accelerator::TensorRtCuda,
    service: "voxcpm2-tensorrt",
    backend: "tensorrt_locdit",
    min_vram_gb: 6.0,
    visible_devices_var: "CUDA_VISIBLE_DEVICES",
    library_dir_in_site_packages: "tensorrt_libs",
};

/// BC-250 대비 자리. 실기에서 재기 전까지 값은 잠정이다 — gfx1013 의 ROCm
/// 지원이 제한적이라 실제로는 다른 백엔드로 내려갈 수 있다.
const ROCM_6G: HardwareProfile = HardwareProfile {
    accelerator: Accelerator::Rocm,
    service: "voxcpm2-rocm",
    backend: "rocm_locdit",
    min_vram_gb: 6.0,
    visible_devices_var: "ROCR_VISIBLE_DEVICES",
    library_dir_in_site_packages: "rocm_libs",
};

/// 운영체제 × 하드웨어. 이름은 그 곱의 식별자일 뿐이다.
#[derive(Debug, Clone, Copy)]
pub struct VoiceProfile {
    pub id: &'static str,
    pub os: HostOs,
    pub hardware: HardwareProfile,
}

/// 아는 프로파일 전부. 새 기계는 여기 한 줄이다.
pub const PROFILES: &[VoiceProfile] = &[
    VoiceProfile {
        id: "windows_trt_6g",
        os: HostOs::Windows,
        hardware: TRT_6G,
    },
    VoiceProfile {
        id: "linux_trt_6g",
        os: HostOs::Linux,
        hardware: TRT_6G,
    },
    VoiceProfile {
        id: "linux_rocm_6g",
        os: HostOs::Linux,
        hardware: ROCM_6G,
    },
];

pub fn layout(os: HostOs) -> &'static OsLayout {
    match os {
        HostOs::Windows => &WINDOWS_LAYOUT,
        HostOs::Linux => &LINUX_LAYOUT,
    }
}

impl VoiceProfile {
    pub fn layout(&self) -> &'static OsLayout {
        layout(self.os)
    }

    /// 번들 안 파이썬 실행기. 경로는 `artifact/` 아래다.
    pub fn bundled_python(&self, bundle_root: &std::path::Path) -> std::path::PathBuf {
        join_relative(&bundle_root.join("artifact"), self.layout().python_relative)
    }

    /// 가속기 공유 라이브러리(`.dll`/`.so`)가 놓인 자리.
    pub fn accelerator_library_dir(&self, bundle_root: &std::path::Path) -> std::path::PathBuf {
        join_relative(
            &bundle_root.join("artifact"),
            self.layout().site_packages_relative,
        )
        .join(self.hardware.library_dir_in_site_packages)
    }
}

/// 축 표에 적힌 상대 경로는 `/` 로 쓴다. 운영체제 구분자로 옮기는 곳은 여기
/// 한 곳이다 — 표를 읽는 쪽마다 나누지 않는다.
fn join_relative(base: &std::path::Path, relative: &str) -> std::path::PathBuf {
    relative
        .split('/')
        .fold(base.to_path_buf(), |acc, part| acc.join(part))
}

pub fn profile(id: &str) -> Option<&'static VoiceProfile> {
    PROFILES.iter().find(|p| p.id == id)
}

/// 지금 이 빌드가 도는 운영체제. 지원하지 않는 곳에서는 `None`.
pub fn host_os() -> Option<HostOs> {
    if cfg!(windows) {
        Some(HostOs::Windows)
    } else if cfg!(target_os = "linux") {
        Some(HostOs::Linux)
    } else {
        None
    }
}

/// 이 기계에 맞는 프로파일. 운영체제와 가속기가 둘 다 맞아야 한다.
pub fn profile_for_host(os: HostOs, accelerator: Accelerator) -> Option<&'static VoiceProfile> {
    PROFILES
        .iter()
        .find(|p| p.os == os && p.hardware.accelerator == accelerator)
}

/// 이 프로파일을 이 기계에서 돌려도 되는가.
///
/// 모르는 이름과 다른 기계의 프로파일을 여기서 갈라 낸다. 기동 직전에 한 번
/// 물으면, 흩어진 리터럴 비교가 필요 없다.
pub fn ensure_runs_here(
    id: &str,
    os: Option<HostOs>,
    accelerator: Option<Accelerator>,
) -> Result<&'static VoiceProfile, String> {
    let found = profile(id).ok_or_else(|| format!("모르는 음성 프로파일입니다: {id}"))?;
    let os = os.ok_or_else(|| "이 운영체제에는 로컬 음성 런타임이 없습니다".to_string())?;
    if found.os != os {
        return Err(format!(
            "{id} 는 이 운영체제용이 아닙니다 (프로파일 {:?}, 기계 {os:?})",
            found.os
        ));
    }
    let accelerator = accelerator
        .ok_or_else(|| "가속기를 찾지 못했습니다 — 로컬 음성은 GPU 가 필요합니다".to_string())?;
    if found.hardware.accelerator != accelerator {
        return Err(format!(
            "{id} 는 이 가속기용이 아닙니다 (프로파일 {:?}, 기계 {accelerator:?})",
            found.hardware.accelerator
        ));
    }
    Ok(found)
}

/// 프로파일이 요구하는 VRAM 을 채우는가.
pub fn validate_vram(profile: &VoiceProfile, vram_gb: Option<f64>) -> Result<f64, String> {
    let minimum = profile.hardware.min_vram_gb;
    match vram_gb {
        Some(vram) if vram >= minimum => Ok(vram),
        Some(vram) => Err(format!(
            "로컬 음성은 VRAM {minimum:.0}GB 이상이 필요합니다 (측정 {vram:.0}GB)"
        )),
        None => Err(format!(
            "로컬 음성은 VRAM {minimum:.0}GB 이상인 GPU 가 필요합니다 — GPU 를 찾지 못했습니다"
        )),
    }
}

/// 카드 한 장의 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GpuInfo {
    pub index: u32,
    pub free_mib: u64,
    pub total_mib: u64,
}

/// 어느 카드에 올릴 것인가.
///
/// 기본은 여유가 가장 많은 카드다. 이 기계는 0번에 아바타가 상주하므로,
/// 고르지 않으면 음성이 그 위에 겹친다.
///
/// 설정으로 번호를 지정했고 그 번호가 실재하면 그것이 이긴다 — 사람이 고른
/// 것을 여유 계산이 덮지 않는다. 실재하지 않는 번호는 무시하고 기본으로
/// 돌아간다. 카드를 뽑았다고 음성이 아예 안 뜨면 안 된다.
pub fn select_gpu(gpus: &[GpuInfo], configured: Option<u32>) -> Option<u32> {
    if let Some(wanted) = configured {
        if gpus.iter().any(|g| g.index == wanted) {
            return Some(wanted);
        }
    }
    gpus.iter()
        .max_by(|a, b| {
            a.free_mib
                .cmp(&b.free_mib)
                // 여유가 같으면 번호가 작은 쪽. 같은 기계에서 매번 같은 답이
                // 나와야 재현이 된다.
                .then_with(|| b.index.cmp(&a.index))
        })
        .map(|g| g.index)
}

/// 설정으로 카드를 고르게 할 것인가. 한 장뿐이면 고를 것이 없다.
pub fn gpu_choice_is_meaningful(gpus: &[GpuInfo]) -> bool {
    gpus.len() >= 2
}

/// 런타임 프로세스에 세울 가속기 관련 환경 변수.
///
/// 왜 따로 빼는가: 이 배선은 `spawn_voxcpm2` 안에 있었고, 그 함수는 런타임
/// 아카이브가 있어야만 실행된다. Linux 아카이브가 아직 없어 한 번도 돌아본
/// 적이 없는 코드였다. 어느 카드를 고르는지는 확인할 수 있어도 그 선택이
/// 실제로 환경 변수가 되는지는 확인할 수 없었다.
///
/// 값을 만드는 일과 프로세스에 붙이는 일을 나누면, 만드는 쪽은 아카이브
/// 없이도 잰다.
///
/// `existing_library_path` 는 현재 프로세스가 들고 있는 값이다. 덮지 않고
/// 앞에 붙인다 — 시스템 라이브러리를 가리면 런타임이 아니라 다른 것이
/// 깨진다.
pub fn accelerator_env(
    profile: &VoiceProfile,
    gpus: &[GpuInfo],
    configured_gpu: Option<u32>,
    library_dir: Option<&std::path::Path>,
    existing_library_path: &str,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(chosen) = select_gpu(gpus, configured_gpu) {
        out.push((
            profile.hardware.visible_devices_var.to_string(),
            chosen.to_string(),
        ));
    }
    if let Some(dir) = library_dir {
        let separator = match profile.os {
            HostOs::Windows => ";",
            HostOs::Linux => ":",
        };
        let dir = dir.to_string_lossy().into_owned();
        let value = if existing_library_path.is_empty() {
            dir
        } else {
            format!("{dir}{separator}{existing_library_path}")
        };
        out.push((profile.layout().library_path_var.to_string(), value));
    }
    out
}

/// Torch/AudioVAE device for the child process.
///
/// `Command` inherits the parent environment. A leftover `VOXCPM_DEVICE=cpu`
/// would silently keep AudioVAE on CPU after the user selected a GPU. When a
/// GPU was chosen, the child always gets `cuda`. Inherited CPU offload is
/// ignored, not preserved.
pub fn resolve_torch_device(
    gpu_selected: bool,
    _inherited_device: Option<&str>,
) -> Option<&'static str> {
    if gpu_selected {
        Some("cuda")
    } else {
        None
    }
}

/// 이 기계의 가속기를 찾는다.
///
/// NVIDIA 는 `nvidia-smi`, AMD 는 `rocm-smi` 로 묻는다. 둘 다 없으면 `None` —
/// 없는 것을 있다고 하지 않는다. 탐지 결과가 어느 프로파일을 쓸지 정한다.
pub fn detect_accelerator() -> Option<Accelerator> {
    if !query_gpus(Accelerator::TensorRtCuda).is_empty() {
        return Some(Accelerator::TensorRtCuda);
    }
    if !query_gpus(Accelerator::Rocm).is_empty() {
        return Some(Accelerator::Rocm);
    }
    None
}

/// 가속기에 카드 목록을 묻는다.
///
/// 두 도구의 질의 형태가 다를 뿐 답의 모양은 같다 — 번호, 여유, 총량. 그
/// 차이를 여기서 흡수해 위쪽은 [`GpuInfo`] 만 본다.
pub fn query_gpus(accelerator: Accelerator) -> Vec<GpuInfo> {
    let (program, args) = match accelerator {
        Accelerator::TensorRtCuda => (
            "nvidia-smi",
            vec![
                "--query-gpu=index,memory.free,memory.total",
                "--format=csv,noheader,nounits",
            ],
        ),
        Accelerator::Rocm => ("rocm-smi", vec!["--showmeminfo", "vram", "--csv"]),
    };
    let mut command = std::process::Command::new(program);
    command.args(&args);
    crate::platform::hide_console(&mut command);
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    match accelerator {
        Accelerator::TensorRtCuda => parse_nvidia_gpu_csv(&text),
        Accelerator::Rocm => parse_rocm_gpu_csv(&text),
    }
}

/// `index, memory.free, memory.total` 세 열. 단위는 MiB.
pub fn parse_nvidia_gpu_csv(text: &str) -> Vec<GpuInfo> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split(',').map(str::trim);
            let index = parts.next()?.parse::<u32>().ok()?;
            let free_mib = parts.next()?.parse::<u64>().ok()?;
            let total_mib = parts.next()?.parse::<u64>().ok()?;
            Some(GpuInfo {
                index,
                free_mib,
                total_mib,
            })
        })
        .collect()
}

/// `rocm-smi --showmeminfo vram --csv` 는 머리글이 있고 장치를 `card0` 처럼
/// 적으며 바이트로 답한다. 그 셋만 다르고 나머지는 같다.
pub fn parse_rocm_gpu_csv(text: &str) -> Vec<GpuInfo> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split(',').map(str::trim);
            let device = parts.next()?;
            let index = device.strip_prefix("card")?.parse::<u32>().ok()?;
            let total_bytes = parts.next()?.parse::<u64>().ok()?;
            let used_bytes = parts.next()?.parse::<u64>().ok()?;
            let total_mib = total_bytes / (1024 * 1024);
            Some(GpuInfo {
                index,
                free_mib: total_mib.saturating_sub(used_bytes / (1024 * 1024)),
                total_mib,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 운영체제가_같으면_배치를_공유한다() {
        let win = profile("windows_trt_6g").unwrap();
        let linux = profile("linux_trt_6g").unwrap();
        assert_eq!(win.layout().compiled_module_extension, "pyd");
        assert_eq!(linux.layout().compiled_module_extension, "so");
        assert_eq!(linux.layout().library_path_var, "LD_LIBRARY_PATH");
        // 같은 운영체제의 두 프로파일은 같은 배치를 가리킨다 — 사본이 아니다.
        assert_eq!(
            profile("linux_rocm_6g").unwrap().layout().python_relative,
            linux.layout().python_relative
        );
    }

    #[test]
    fn 가속기가_같으면_요구사항을_공유한다() {
        let win = profile("windows_trt_6g").unwrap();
        let linux = profile("linux_trt_6g").unwrap();
        assert_eq!(win.hardware.min_vram_gb, linux.hardware.min_vram_gb);
        assert_eq!(win.hardware.backend, linux.hardware.backend);
    }

    #[test]
    fn 모르는_이름은_거절한다() {
        let err = ensure_runs_here(
            "linux_cuda_99g",
            Some(HostOs::Linux),
            Some(Accelerator::TensorRtCuda),
        )
        .unwrap_err();
        assert!(err.contains("모르는"), "{err}");
    }

    #[test]
    fn 다른_운영체제의_프로파일은_거절한다() {
        let err = ensure_runs_here(
            "windows_trt_6g",
            Some(HostOs::Linux),
            Some(Accelerator::TensorRtCuda),
        )
        .unwrap_err();
        assert!(err.contains("운영체제"), "{err}");
    }

    #[test]
    fn 다른_가속기의_프로파일은_거절한다() {
        let err = ensure_runs_here(
            "linux_trt_6g",
            Some(HostOs::Linux),
            Some(Accelerator::Rocm),
        )
        .unwrap_err();
        assert!(err.contains("가속기"), "{err}");
    }

    #[test]
    fn 가속기를_못_찾으면_거절한다() {
        let err = ensure_runs_here("linux_trt_6g", Some(HostOs::Linux), None).unwrap_err();
        assert!(err.contains("가속기"), "{err}");
    }

    #[test]
    fn 기계에_맞는_프로파일을_고른다() {
        assert_eq!(
            profile_for_host(HostOs::Linux, Accelerator::TensorRtCuda)
                .unwrap()
                .id,
            "linux_trt_6g"
        );
        assert_eq!(
            profile_for_host(HostOs::Linux, Accelerator::Rocm).unwrap().id,
            "linux_rocm_6g"
        );
        assert_eq!(
            profile_for_host(HostOs::Windows, Accelerator::TensorRtCuda)
                .unwrap()
                .id,
            "windows_trt_6g"
        );
        // Windows + AMD 는 아직 없다. 없는 것을 있다고 하지 않는다.
        assert!(profile_for_host(HostOs::Windows, Accelerator::Rocm).is_none());
    }

    #[test]
    fn vram이_모자라면_거절한다() {
        let p = profile("linux_trt_6g").unwrap();
        assert_eq!(validate_vram(p, Some(24.0)).unwrap(), 24.0);
        assert_eq!(validate_vram(p, Some(6.0)).unwrap(), 6.0);
        assert!(validate_vram(p, Some(5.9)).is_err());
        assert!(validate_vram(p, None).is_err());
    }

    fn gpu(index: u32, free_mib: u64) -> GpuInfo {
        GpuInfo {
            index,
            free_mib,
            total_mib: 24576,
        }
    }

    #[test]
    fn 기본은_여유가_가장_많은_카드다() {
        // 이 기계의 실제 모양 — 0번에 아바타가 상주한다.
        let gpus = [gpu(0, 20465), gpu(1, 24466)];
        assert_eq!(select_gpu(&gpus, None), Some(1));
    }

    #[test]
    fn 사람이_고른_카드가_여유_계산을_이긴다() {
        let gpus = [gpu(0, 20465), gpu(1, 24466)];
        assert_eq!(select_gpu(&gpus, Some(0)), Some(0));
    }

    #[test]
    fn 없는_번호를_고르면_기본으로_돌아간다() {
        // 카드를 뽑았다고 음성이 아예 안 뜨면 안 된다.
        let gpus = [gpu(0, 20465), gpu(1, 24466)];
        assert_eq!(select_gpu(&gpus, Some(7)), Some(1));
    }

    #[test]
    fn 여유가_같으면_번호가_작은_쪽() {
        let gpus = [gpu(0, 24000), gpu(1, 24000)];
        assert_eq!(select_gpu(&gpus, None), Some(0));
    }

    #[test]
    fn 카드가_없으면_고를_것이_없다() {
        assert_eq!(select_gpu(&[], None), None);
        assert_eq!(select_gpu(&[], Some(0)), None);
    }

    #[test]
    fn 번들_경로가_운영체제_축에서_나온다() {
        let base = std::path::Path::new("/bundle");
        let win = profile("windows_trt_6g").unwrap();
        let linux = profile("linux_trt_6g").unwrap();
        assert!(win
            .bundled_python(base)
            .ends_with("artifact/python/python.exe"));
        assert!(linux
            .bundled_python(base)
            .ends_with("artifact/python/bin/python3"));
        // 가속기 라이브러리는 두 축이 만나는 자리다 — 운영체제가 site-packages
        // 위치를, 가속기가 그 아래 이름을 준다.
        assert!(linux
            .accelerator_library_dir(base)
            .ends_with("python/lib/python3.10/site-packages/tensorrt_libs"));
        assert!(profile("linux_rocm_6g")
            .unwrap()
            .accelerator_library_dir(base)
            .ends_with("site-packages/rocm_libs"));
    }

    #[test]
    fn 가시_장치_변수는_가속기가_정한다() {
        assert_eq!(
            profile("linux_trt_6g").unwrap().hardware.visible_devices_var,
            "CUDA_VISIBLE_DEVICES"
        );
        assert_eq!(
            profile("linux_rocm_6g")
                .unwrap()
                .hardware
                .visible_devices_var,
            "ROCR_VISIBLE_DEVICES"
        );
    }

    #[test]
    fn 고른_카드가_환경_변수가_된다() {
        // 이 기계의 실제 모양 — 0번에 아바타가 상주한다.
        let gpus = [gpu(0, 20011), gpu(1, 24014)];
        let env = accelerator_env(
            profile("linux_trt_6g").unwrap(),
            &gpus,
            None,
            None,
            "",
        );
        assert_eq!(
            env,
            vec![("CUDA_VISIBLE_DEVICES".to_string(), "1".to_string())]
        );
    }

    #[test]
    fn 사람이_고른_카드가_환경_변수가_된다() {
        let gpus = [gpu(0, 20011), gpu(1, 24014)];
        let env = accelerator_env(
            profile("linux_trt_6g").unwrap(),
            &gpus,
            Some(0),
            None,
            "",
        );
        assert_eq!(env[0].1, "0");
    }

    #[test]
    fn 가속기마다_변수_이름이_다르다() {
        let gpus = [gpu(0, 16000)];
        let rocm = accelerator_env(
            profile("linux_rocm_6g").unwrap(),
            &gpus,
            None,
            None,
            "",
        );
        assert_eq!(rocm[0].0, "ROCR_VISIBLE_DEVICES");
    }

    #[test]
    fn 라이브러리_경로는_덮지_않고_앞에_붙인다() {
        let dir = std::path::Path::new("/bundle/artifact/lib/tensorrt_libs");
        let env = accelerator_env(
            profile("linux_trt_6g").unwrap(),
            &[],
            None,
            Some(dir),
            "/usr/lib:/usr/local/lib",
        );
        assert_eq!(
            env,
            vec![(
                "LD_LIBRARY_PATH".to_string(),
                "/bundle/artifact/lib/tensorrt_libs:/usr/lib:/usr/local/lib".to_string()
            )]
        );
    }

    #[test]
    fn 운영체제마다_경로_구분자가_다르다() {
        let dir = std::path::Path::new("C:/bundle/tensorrt_libs");
        let env = accelerator_env(
            profile("windows_trt_6g").unwrap(),
            &[],
            None,
            Some(dir),
            "C:/Windows",
        );
        assert_eq!(env[0].0, "PATH");
        assert!(env[0].1.contains(";C:/Windows"), "{}", env[0].1);
    }

    #[test]
    fn 카드도_라이브러리도_없으면_세울_것이_없다() {
        let env = accelerator_env(
            profile("linux_trt_6g").unwrap(),
            &[],
            None,
            None,
            "",
        );
        assert!(env.is_empty());
    }

    #[test]
    fn gpu를_고르면_상속된_cpu_장치를_cuda로_덮는다() {
        assert_eq!(resolve_torch_device(true, Some("cpu")), Some("cuda"));
        assert_eq!(resolve_torch_device(true, Some("CUDA")), Some("cuda"));
        assert_eq!(resolve_torch_device(true, None), Some("cuda"));
        assert_eq!(resolve_torch_device(false, Some("cpu")), None);
        assert_eq!(resolve_torch_device(false, None), None);
    }

    /// 세운 환경 변수가 실제로 그 카드에 올리는가.
    ///
    /// 앞의 테스트들은 "어느 카드를 고르는가" 와 "그 선택이 환경 변수가
    /// 되는가" 까지만 잰다. 그 변수가 정말로 프로세스를 그 카드에 올리는지는
    /// 붙여 보기 전에는 모른다 — 로컬 음성 런타임은 아카이브가 있어야 뜨므로
    /// 그것으로는 잴 수 없다.
    ///
    /// 그래서 CUDA 를 쓰는 아무 프로세스나 우리가 만든 환경으로 띄우고, 그것이
    /// 본 장치가 우리가 고른 물리 카드와 같은지 UUID 로 대조한다. 런타임이
    /// 아니라 **배치 수단**을 재는 자리다.
    ///
    /// `NAIA_GPU_PLACEMENT_PYTHON` 에 torch 가 있는 파이썬을 주면 돈다. 없으면
    /// 건너뛴다 — 기계마다 다른 경로를 코드에 박지 않는다.
    #[test]
    fn 세운_환경_변수가_실제로_그_카드에_올린다() {
        let Ok(python) = std::env::var("NAIA_GPU_PLACEMENT_PYTHON") else {
            return;
        };
        let gpus = query_gpus(Accelerator::TensorRtCuda);
        if gpus.len() < 2 {
            return; // 카드가 하나면 배치를 확인할 수 없다
        }
        let profile = profile("linux_trt_6g").unwrap();
        let env = accelerator_env(profile, &gpus, None, None, "");
        let (var, chosen) = env.first().expect("고른 카드가 있어야 한다");
        assert_eq!(var, "CUDA_VISIBLE_DEVICES");

        // 물리 카드의 UUID. 우리가 고른 번호가 가리키는 실체다.
        let uuids = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=index,uuid", "--format=csv,noheader"])
            .output()
            .expect("nvidia-smi");
        let expected_uuid = String::from_utf8_lossy(&uuids.stdout)
            .lines()
            .find_map(|line| {
                let (index, uuid) = line.split_once(',')?;
                (index.trim() == chosen).then(|| uuid.trim().to_string())
            })
            .expect("고른 번호의 UUID");

        // 그 환경으로 띄운 프로세스가 보는 유일한 장치의 UUID.
        let seen = std::process::Command::new(&python)
            .args([
                "-c",
                "import torch;print(torch.cuda.device_count());print(torch.cuda.get_device_properties(0).uuid)",
            ])
            .env(var, chosen)
            .output()
            .expect("python");
        let stdout = String::from_utf8_lossy(&seen.stdout);
        let mut lines = stdout.lines();
        assert_eq!(
            lines.next().unwrap_or_default().trim(),
            "1",
            "환경 변수를 세웠는데 장치가 하나로 좁혀지지 않았다: {stdout}"
        );
        let seen_uuid = lines.next().unwrap_or_default().trim().to_string();
        assert!(
            expected_uuid.contains(&seen_uuid) || seen_uuid.contains(expected_uuid.trim_start_matches("GPU-")),
            "고른 카드({chosen}, {expected_uuid})가 아니라 {seen_uuid} 에 올라갔다"
        );
    }

    #[test]
    fn 실제_기계에서_카드를_읽는다() {
        // NVIDIA 가 없는 기계에서는 빈 목록이 계약이다.
        let gpus = query_gpus(Accelerator::TensorRtCuda);
        if gpus.is_empty() {
            return;
        }
        assert!(gpus.iter().all(|g| g.total_mib > 0));
        assert!(select_gpu(&gpus, None).is_some());
    }

    #[test]
    fn nvidia_답을_읽는다() {
        // 이 기계의 실제 출력 모양.
        let text = "0, 20465, 24576\n1, 24466, 24576\n";
        assert_eq!(
            parse_nvidia_gpu_csv(text),
            vec![
                GpuInfo {
                    index: 0,
                    free_mib: 20465,
                    total_mib: 24576
                },
                GpuInfo {
                    index: 1,
                    free_mib: 24466,
                    total_mib: 24576
                },
            ]
        );
    }

    #[test]
    fn 읽지_못한_줄은_버린다() {
        // 머리글이나 경고가 섞여도 카드 목록이 통째로 날아가면 안 된다.
        let text = "index, memory.free [MiB], memory.total [MiB]\n0, 100, 200\n";
        assert_eq!(parse_nvidia_gpu_csv(text).len(), 1);
    }

    #[test]
    fn rocm_답을_바이트에서_MiB로_옮긴다() {
        // device, total, used — 바이트. BC-250 대비.
        let text = "device,Total Memory (B),Total Memory Used (B)\ncard0,17179869184,1073741824\n";
        assert_eq!(
            parse_rocm_gpu_csv(text),
            vec![GpuInfo {
                index: 0,
                free_mib: 15360,
                total_mib: 16384
            }]
        );
    }

    #[test]
    fn 한_장뿐이면_설정으로_고를_이유가_없다() {
        assert!(!gpu_choice_is_meaningful(&[gpu(0, 24000)]));
        assert!(gpu_choice_is_meaningful(&[gpu(0, 24000), gpu(1, 24000)]));
    }
}
