//! Registry driven selection and runtime-only TensorRT process layout.

/// 런타임이 도는 운영체제. 파일 배치와 라이브러리 탐색 규약이 여기 달린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Windows,
    Linux,
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

/// Runtime process settings that are not profile eligibility data.
#[derive(Debug, Clone, Copy)]
pub struct HardwareProfile {
    pub service: &'static str,
    pub visible_devices_var: &'static str,
    /// 번들 안에서 가속기 공유 라이브러리가 놓이는 자리. site-packages 아래
    /// 상대 경로다 — 운영체제마다 site-packages 위치가 다르므로 그 앞은
    /// [`OsLayout`] 이 붙인다.
    pub library_dir_in_site_packages: &'static str,
}

const TRT_6G: HardwareProfile = HardwareProfile {
    service: "voxcpm2-tensorrt",
    visible_devices_var: "CUDA_VISIBLE_DEVICES",
    library_dir_in_site_packages: "tensorrt_libs",
};

/// A selected registry row with process layout resolved at runtime.
#[derive(Debug, Clone, Copy)]
pub struct VoiceProfile<'a> {
    pub entry: &'a crate::VoxCpm2RegistryEntry,
    pub os: HostOs,
    pub hardware: HardwareProfile,
}

pub struct ProfileSelection<'a> {
    pub profile: &'a crate::VoxCpm2RegistryEntry,
    pub device: &'a crate::accelerator::AcceleratorDevice,
}

pub fn layout(os: HostOs) -> &'static OsLayout {
    match os {
        HostOs::Windows => &WINDOWS_LAYOUT,
        HostOs::Linux => &LINUX_LAYOUT,
    }
}

impl<'a> VoiceProfile<'a> {
    pub fn id(&self) -> &'a str {
        &self.entry.id
    }

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

fn registry_os(os: HostOs) -> &'static str {
    match os {
        HostOs::Windows => "windows",
        HostOs::Linux => "linux",
    }
}

/// Shell runtime support is an independent input: seeing an NVIDIA device in
/// Vulkan does not make TensorRT or a Vulkan voice executable available.
pub fn available_backends(os: Option<HostOs>) -> Vec<&'static str> {
    match (os, host_os()) {
        (Some(HostOs::Windows), Some(HostOs::Windows))
        | (Some(HostOs::Linux), Some(HostOs::Linux)) => vec!["tensorrt_locdit"],
        _ => Vec::new(),
    }
}

fn backend_runtime_config(backend: &str) -> Option<HardwareProfile> {
    match backend {
        "tensorrt_locdit" => Some(TRT_6G),
        _ => None,
    }
}

pub fn runtime_profile<'a>(
    entry: &'a crate::VoxCpm2RegistryEntry,
    os: Option<HostOs>,
) -> Option<VoiceProfile<'a>> {
    let os = os?;
    (entry.status == crate::VOXCPM2_STATUS_RELEASED
        && entry.os == registry_os(os)
        && backend_runtime_config(&entry.backend).is_some()
        && available_backends(Some(os)).contains(&entry.backend.as_str()))
    .then(|| VoiceProfile {
        entry,
        os,
        hardware: backend_runtime_config(&entry.backend).expect("backend was checked"),
    })
}

fn execution_accelerator_matches(
    profile_accelerator: &str,
    device: &crate::accelerator::AcceleratorDevice,
) -> bool {
    use crate::accelerator::{AcceleratorApi, DeviceIdKind, HardwareVendor};

    match profile_accelerator {
        // The registry names a runtime API. Vulkan reports the enumerating API
        // and hardware vendor separately, so CUDA maps explicitly through the
        // NVIDIA vendor while backend support is checked independently.
        "cuda" => {
            device.vendor == HardwareVendor::Nvidia
                && (device_legacy_index(device).is_some()
                    || device.provider_id.kind == DeviceIdKind::VulkanUuid)
        }
        "vulkan" => device.accelerator == AcceleratorApi::Vulkan,
        // The common inventory has no ROCm execution probe, so an AMD Vulkan
        // device is not evidence that ROCm is available.
        "rocm" => false,
        _ => false,
    }
}

fn profile_minimum_bytes(entry: &crate::VoxCpm2RegistryEntry) -> Option<u64> {
    entry.min_vram_gi_b.checked_mul(1024 * 1024 * 1024)
}

fn device_legacy_index(device: &crate::accelerator::AcceleratorDevice) -> Option<u32> {
    device
        .nvidia
        .as_ref()
        .and_then(|metadata| metadata.compatibility_index)
}

/// Preserve real NVIDIA indices where UUID matching supplied them. Devices
/// without a legacy index get a deterministic display index from stable IDs;
/// these display indices are never passed to CUDA in place of a legacy index.
fn inventory_display_indices(
    inventory: &crate::accelerator::AcceleratorInventory,
) -> Vec<(String, u32)> {
    let mut devices = inventory.devices.iter().collect::<Vec<_>>();
    devices.sort_by(|left, right| left.provider_id.value.cmp(&right.provider_id.value));

    let mut used = std::collections::HashSet::new();
    let mut indexed = Vec::with_capacity(devices.len());
    let mut pending = Vec::new();
    for device in devices {
        match device_legacy_index(device) {
            Some(index) if used.insert(index) => {
                indexed.push((device.provider_id.value.clone(), index));
            }
            _ => pending.push(device),
        }
    }

    for device in pending {
        let Some(index) = (0..u32::MAX).find(|index| !used.contains(index)) else {
            break;
        };
        used.insert(index);
        indexed.push((device.provider_id.value.clone(), index));
    }

    indexed.sort_by_key(|(_, index)| *index);
    indexed
}

pub fn select_profile<'a>(
    entries: &'a [crate::VoxCpm2RegistryEntry],
    host: Option<HostOs>,
    inventory: &'a crate::accelerator::AcceleratorInventory,
    preferred_device_id: Option<&str>,
    available_backends: &[&str],
) -> Option<ProfileSelection<'a>> {
    let host = host?;
    if inventory.status != crate::accelerator::DetectionStatus::Detected {
        return None;
    }
    let preferred_device = preferred_device_id
        .and_then(|id| inventory.devices.iter().find(|device| device.provider_id.value == id));
    let mut candidates = Vec::new();

    for entry in entries.iter().filter(|entry| {
        entry.status == crate::VOXCPM2_STATUS_RELEASED
            && entry.os == registry_os(host)
            && available_backends.contains(&entry.backend.as_str())
            && backend_runtime_config(&entry.backend).is_some()
    }) {
        let Some(minimum) = profile_minimum_bytes(entry) else {
            continue;
        };
        for device in inventory.devices.iter().filter(|device| {
            preferred_device.is_none_or(|preferred| preferred.provider_id == device.provider_id)
                && execution_accelerator_matches(&entry.accelerator, device)
                && device.total_vram_bytes.is_some_and(|total| total >= minimum)
        }) {
            candidates.push((entry, device));
        }
    }

    candidates
        .into_iter()
        .max_by(|(left_profile, left), (right_profile, right)| {
            left.available_vram_bytes
                .unwrap_or_default()
                .cmp(&right.available_vram_bytes.unwrap_or_default())
                .then_with(|| {
                    device_legacy_index(right)
                        .unwrap_or(u32::MAX)
                        .cmp(&device_legacy_index(left).unwrap_or(u32::MAX))
                })
                .then_with(|| right.provider_id.value.cmp(&left.provider_id.value))
                .then_with(|| right_profile.id.cmp(&left_profile.id))
        })
        .map(|(profile, device)| ProfileSelection { profile, device })
}

pub fn select_profile_by_id<'a>(
    id: &str,
    entries: &'a [crate::VoxCpm2RegistryEntry],
    host: Option<HostOs>,
    inventory: &'a crate::accelerator::AcceleratorInventory,
    preferred_device_id: Option<&str>,
    available_backends: &[&str],
) -> Option<ProfileSelection<'a>> {
    let entry = entries.iter().find(|entry| entry.id == id)?;
    select_profile(
        std::slice::from_ref(entry),
        host,
        inventory,
        preferred_device_id,
        available_backends,
    )
}

pub fn inventory_gpu_info(
    inventory: &crate::accelerator::AcceleratorInventory,
) -> Vec<GpuInfo> {
    inventory_display_indices(inventory)
        .into_iter()
        .filter_map(|(device_id, index)| {
            let device = inventory
                .devices
                .iter()
                .find(|device| device.provider_id.value == device_id)?;
            let total_mib = device.total_vram_bytes? / (1024 * 1024);
            let runtime_selector = device_legacy_index(device)
                .map(|legacy_index| legacy_index.to_string())
                .or_else(|| {
                    (device.vendor == crate::accelerator::HardwareVendor::Nvidia)
                        .then(|| device.provider_id.value.strip_prefix("vulkan:uuid:"))
                        .flatten()
                        .map(|uuid| format!("GPU-{uuid}"))
                });
            Some(GpuInfo {
                index,
                free_mib: device.available_vram_bytes.unwrap_or_default() / (1024 * 1024),
                total_mib,
                device_id,
                vendor: device.vendor,
                runtime_selector,
            })
        })
        .collect()
}

pub fn selected_device_id(
    inventory: &crate::accelerator::AcceleratorInventory,
    configured_index: Option<u32>,
) -> Option<String> {
    let gpus = inventory_gpu_info(inventory);
    if let Some(index) = configured_index {
        if let Some(gpu) = gpus.iter().find(|gpu| gpu.index == index) {
            return Some(gpu.device_id.clone());
        }
    }

    let prefer_nvidia = gpus
        .iter()
        .any(|gpu| gpu.vendor == crate::accelerator::HardwareVendor::Nvidia);
    gpus.iter()
        .filter(|gpu| !prefer_nvidia || gpu.vendor == crate::accelerator::HardwareVendor::Nvidia)
        .max_by(|left, right| {
            left.free_mib
                .cmp(&right.free_mib)
                .then_with(|| right.index.cmp(&left.index))
                .then_with(|| right.device_id.cmp(&left.device_id))
        })
        .map(|gpu| gpu.device_id.clone())
}

/// 카드 한 장의 상태.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuInfo {
    pub index: u32,
    pub free_mib: u64,
    pub total_mib: u64,
    pub(crate) device_id: String,
    pub(crate) vendor: crate::accelerator::HardwareVendor,
    /// CUDA_VISIBLE_DEVICES selector. It is the UUID when NVIDIA's optional
    /// compatibility-index supplement is unavailable.
    pub(crate) runtime_selector: Option<String>,
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
        if let Some(gpu) = gpus.iter().find(|gpu| gpu.index == chosen) {
            let selector = match (gpu.vendor, gpu.runtime_selector.as_ref()) {
                (crate::accelerator::HardwareVendor::Nvidia, Some(selector)) => {
                    Some(selector.clone())
                }
                (crate::accelerator::HardwareVendor::Nvidia, None) => None,
                (_, _) => Some(chosen.to_string()),
            };
            if let Some(selector) = selector {
                out.push((
                    profile.hardware.visible_devices_var.to_string(),
                    selector,
                ));
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, os: HostOs) -> VoiceProfile<'static> {
        let entry = crate::embedded_voxcpm2_profile_registry()
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .expect("fixture registry row");
        VoiceProfile {
            entry,
            os,
            hardware: TRT_6G,
        }
    }

    #[test]
    fn 운영체제가_같으면_배치를_공유한다() {
        let win = profile("windows_trt_6g", HostOs::Windows);
        let linux = profile("linux_trt_6g", HostOs::Linux);
        assert_eq!(win.layout().compiled_module_extension, "pyd");
        assert_eq!(linux.layout().compiled_module_extension, "so");
        assert_eq!(linux.layout().library_path_var, "LD_LIBRARY_PATH");
        assert_eq!(win.hardware.visible_devices_var, "CUDA_VISIBLE_DEVICES");
        assert_eq!(linux.hardware.library_dir_in_site_packages, "tensorrt_libs");
    }

    fn gpu(index: u32, free_mib: u64) -> GpuInfo {
        GpuInfo {
            index,
            free_mib,
            total_mib: 24576,
            device_id: format!("fixture:{index}"),
            vendor: crate::accelerator::HardwareVendor::Nvidia,
            runtime_selector: Some(index.to_string()),
        }
    }

    fn registry_entry(
        id: &str,
        os: &str,
        accelerator: &str,
        backend: &str,
        min_vram_gi_b: u64,
        status: &str,
    ) -> crate::VoxCpm2RegistryEntry {
        crate::VoxCpm2RegistryEntry {
            id: id.to_owned(),
            os: os.to_owned(),
            accelerator: accelerator.to_owned(),
            backend: backend.to_owned(),
            min_vram_gi_b,
            status: status.to_owned(),
            notes: "fixture".to_owned(),
        }
    }

    fn nvidia_device(
        uuid: &str,
        index: u32,
        total_vram_bytes: u64,
        available_vram_bytes: u64,
    ) -> crate::accelerator::AcceleratorDevice {
        use crate::accelerator::{
            AcceleratorApi, AcceleratorDevice, ComputeCapability, DeviceIdKind, HardwareVendor,
            InformationSource, NvidiaMetadata, ProviderScopedDeviceId,
        };

        AcceleratorDevice {
            accelerator: AcceleratorApi::Vulkan,
            vendor: HardwareVendor::Nvidia,
            name: Some("NVIDIA fixture".to_owned()),
            provider_id: ProviderScopedDeviceId {
                provider: AcceleratorApi::Vulkan,
                kind: DeviceIdKind::VulkanUuid,
                value: format!("vulkan:uuid:{uuid}"),
            },
            total_vram_bytes: Some(total_vram_bytes),
            available_vram_bytes: Some(available_vram_bytes),
            info_source: InformationSource::Vulkan,
            total_vram_source: Some(InformationSource::Vulkan),
            available_vram_source: Some(InformationSource::NvidiaSmi),
            nvidia: Some(NvidiaMetadata {
                compatibility_index: Some(index),
                name: Some("NVIDIA fixture".to_owned()),
                compute_capability: Some(ComputeCapability { major: 8, minor: 9 }),
                driver_version: Some("fixture".to_owned()),
            }),
            nvidia_info_source: Some(InformationSource::NvidiaSmi),
        }
    }

    fn detected_inventory(
        devices: Vec<crate::accelerator::AcceleratorDevice>,
    ) -> crate::accelerator::AcceleratorInventory {
        crate::accelerator::AcceleratorInventory {
            status: crate::accelerator::DetectionStatus::Detected,
            devices,
            error_code: None,
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
        let win = profile("windows_trt_6g", HostOs::Windows);
        let linux = profile("linux_trt_6g", HostOs::Linux);
        assert!(win
            .bundled_python(base)
            .ends_with("artifact/python/python.exe"));
        assert!(linux
            .bundled_python(base)
            .ends_with("artifact/python/bin/python3"));
        assert!(linux
            .accelerator_library_dir(base)
            .ends_with("python/lib/python3.10/site-packages/tensorrt_libs"));
    }

    #[test]
    fn 고른_카드가_환경_변수가_된다() {
        // 이 기계의 실제 모양 — 0번에 아바타가 상주한다.
        let gpus = [gpu(0, 20011), gpu(1, 24014)];
        let env = accelerator_env(
            &profile("linux_trt_6g", HostOs::Linux),
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
            &profile("linux_trt_6g", HostOs::Linux),
            &gpus,
            Some(0),
            None,
            "",
        );
        assert_eq!(env[0].1, "0");
    }

    #[test]
    fn 라이브러리_경로는_덮지_않고_앞에_붙인다() {
        let dir = std::path::Path::new("/bundle/artifact/lib/tensorrt_libs");
        let env = accelerator_env(
            &profile("linux_trt_6g", HostOs::Linux),
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
            &profile("windows_trt_6g", HostOs::Windows),
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
            &profile("linux_trt_6g", HostOs::Linux),
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

    #[test]
    fn registry_selection_checks_status_os_accelerator_backend_and_vram() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let inventory = detected_inventory(vec![nvidia_device("aa", 0, 6 * GIB, 128 * 1024 * 1024)]);
        let released = registry_entry("windows_trt_6g", "windows", "cuda", "tensorrt_locdit", 6, "released");
        let available = ["tensorrt_locdit"];

        assert!(select_profile(&[released.clone()], Some(HostOs::Windows), &inventory, None, &[]).is_none());
        assert!(select_profile(&[released.clone()], Some(HostOs::Linux), &inventory, None, &available).is_none());
        assert!(select_profile(&[registry_entry("windows_preview", "windows", "cuda", "tensorrt_locdit", 6, "preview")], Some(HostOs::Windows), &inventory, None, &available).is_none());
        assert!(select_profile(&[registry_entry("windows_planned", "windows", "cuda", "tensorrt_locdit", 6, "planned")], Some(HostOs::Windows), &inventory, None, &available).is_none());
        assert_eq!(select_profile(&[released], Some(HostOs::Windows), &inventory, None, &available).unwrap().device.provider_id.value, "vulkan:uuid:aa");
    }

    #[test]
    fn registry_selection_requires_one_device_to_meet_inclusive_minimum() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let entry = registry_entry("linux_trt_6g", "linux", "cuda", "tensorrt_locdit", 6, "released");
        let backends = ["tensorrt_locdit"];
        let exact = detected_inventory(vec![nvidia_device("exact", 0, 6 * GIB, 1)]);
        assert!(select_profile(&[entry.clone()], Some(HostOs::Linux), &exact, None, &backends).is_some());

        let below = detected_inventory(vec![nvidia_device("below", 0, 6 * GIB - 1, 6 * GIB)]);
        assert!(select_profile(&[entry.clone()], Some(HostOs::Linux), &below, None, &backends).is_none());

        let split = detected_inventory(vec![
            nvidia_device("first", 0, 4 * GIB, 4 * GIB),
            nvidia_device("second", 1, 4 * GIB, 4 * GIB),
        ]);
        assert!(select_profile(&[entry], Some(HostOs::Linux), &split, None, &backends).is_none());
    }

    #[test]
    fn registry_selection_keeps_vendor_api_and_backend_as_separate_checks() {
        use crate::accelerator::{AcceleratorApi, HardwareVendor};

        const GIB: u64 = 1024 * 1024 * 1024;
        let entry = registry_entry("linux_vulkan", "linux", "vulkan", "vulkan_cpp", 8, "released");
        let mut device = nvidia_device("vk", 0, 8 * GIB, 8 * GIB);
        let inventory = detected_inventory(vec![device.clone()]);
        assert!(execution_accelerator_matches("vulkan", &inventory.devices[0]));
        assert!(select_profile(&[entry.clone()], Some(HostOs::Linux), &inventory, None, &["tensorrt_locdit"]).is_none());
        assert!(select_profile(&[entry.clone()], Some(HostOs::Linux), &inventory, None, &["vulkan_cpp"]).is_none());

        device.vendor = HardwareVendor::Amd;
        let amd = detected_inventory(vec![device]);
        assert!(execution_accelerator_matches("vulkan", &amd.devices[0]));
        assert!(!execution_accelerator_matches("cuda", &amd.devices[0]));
        assert!(select_profile(&[entry], Some(HostOs::Linux), &amd, None, &["vulkan_cpp"]).is_none());
        let rocm = registry_entry("linux_rocm", "linux", "rocm", "torch", 8, "released");
        assert!(select_profile(&[rocm], Some(HostOs::Linux), &amd, None, &["torch"]).is_none());
        assert_eq!(AcceleratorApi::Vulkan, amd.devices[0].accelerator);
    }

    #[test]
    fn explicit_stable_device_id_precedes_the_free_memory_default() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let entries = [registry_entry("linux_trt_6g", "linux", "cuda", "tensorrt_locdit", 6, "released")];
        let inventory = detected_inventory(vec![
            nvidia_device("explicit", 0, 8 * GIB, 1 * GIB),
            nvidia_device("default", 1, 12 * GIB, 10 * GIB),
        ]);
        let available = ["tensorrt_locdit"];

        let explicit = select_profile(&entries, Some(HostOs::Linux), &inventory, Some("vulkan:uuid:explicit"), &available).unwrap();
        assert_eq!(explicit.device.provider_id.value, "vulkan:uuid:explicit");
        let default = select_profile(&entries, Some(HostOs::Linux), &inventory, None, &available).unwrap();
        assert_eq!(default.device.provider_id.value, "vulkan:uuid:default");
    }

    #[test]
    fn inventory_cards_use_uuid_joined_legacy_indices_and_existing_units() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let inventory = detected_inventory(vec![
            nvidia_device("first", 3, 12 * GIB, 6 * GIB),
            nvidia_device("second", 1, 8 * GIB, 4 * GIB),
        ]);
        let cards = inventory_gpu_info(&inventory);
        assert_eq!(
            cards
                .iter()
                .map(|gpu| (gpu.index, gpu.free_mib, gpu.total_mib))
                .collect::<Vec<_>>(),
            vec![(1, 4096, 8192), (3, 6144, 12288)]
        );
        assert_eq!(cards[0].device_id, "vulkan:uuid:second");
        assert_eq!(select_gpu(&cards, None), Some(3));
        assert_eq!(selected_device_id(&inventory, Some(1)).as_deref(), Some("vulkan:uuid:second"));
    }

    #[test]
    fn missing_nvidia_supplement_keeps_vulkan_cards_and_binds_by_uuid() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let mut later = nvidia_device("z-device", 8, 8 * GIB, 6 * GIB);
        later.nvidia = None;
        later.nvidia_info_source = None;
        let mut earlier = nvidia_device("a-device", 9, 8 * GIB, 4 * GIB);
        earlier.nvidia = None;
        earlier.nvidia_info_source = None;
        let inventory = detected_inventory(vec![later, earlier]);

        let cards = inventory_gpu_info(&inventory);

        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].device_id, "vulkan:uuid:a-device");
        assert_eq!(cards[0].index, 0);
        assert_eq!(cards[1].device_id, "vulkan:uuid:z-device");
        assert_eq!(cards[1].index, 1);
        assert_eq!(cards[1].runtime_selector.as_deref(), Some("GPU-z-device"));
        assert_eq!(selected_device_id(&inventory, Some(1)).as_deref(), Some("vulkan:uuid:z-device"));

        let profile = profile("linux_trt_6g", HostOs::Linux);
        let env = accelerator_env(&profile, &cards, Some(1), None, "");
        assert_eq!(env, vec![("CUDA_VISIBLE_DEVICES".to_string(), "GPU-z-device".to_string())]);
    }

    #[test]
    fn non_nvidia_vulkan_cards_remain_in_the_existing_card_list() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let mut amd = nvidia_device("amd-device", 0, 8 * GIB, 6 * GIB);
        amd.vendor = crate::accelerator::HardwareVendor::Amd;
        amd.nvidia = None;
        amd.nvidia_info_source = None;
        let inventory = detected_inventory(vec![amd]);

        let cards = inventory_gpu_info(&inventory);

        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].vendor, crate::accelerator::HardwareVendor::Amd);
        assert_eq!(cards[0].total_mib, 8192);
        assert_eq!(cards[0].runtime_selector, None);
    }

    /// Reads the host's real Vulkan cards. Run only as an explicitly selected
    /// hardware check; the stage-3 validation command skips it.
    #[test]
    fn 실제_기계에서_카드를_읽는다() {
        let inventory = crate::accelerator::list_accelerators();
        let cards = inventory_gpu_info(&inventory);
        if cards.is_empty() {
            return;
        }
        assert!(cards.iter().all(|card| card.total_mib > 0));
        assert!(select_gpu(&cards, None).is_some());
    }

    /// Confirms CUDA's visibility selector reaches the NVIDIA UUID selected
    /// from the shared inventory. The stage-3 validation command skips it.
    #[test]
    fn 세운_환경_변수가_실제로_그_카드에_올린다() {
        let Ok(python) = std::env::var("NAIA_GPU_PLACEMENT_PYTHON") else {
            return;
        };
        let Some(os) = host_os() else {
            return;
        };
        let inventory = crate::accelerator::list_accelerators();
        let nvidia_cards = inventory_gpu_info(&inventory)
            .into_iter()
            .filter(|card| card.vendor == crate::accelerator::HardwareVendor::Nvidia)
            .collect::<Vec<_>>();
        if nvidia_cards.len() < 2 {
            return;
        }
        let Some(chosen) = select_gpu(&nvidia_cards, None) else {
            return;
        };
        let Some(device_id) = selected_device_id(&inventory, Some(chosen)) else {
            return;
        };
        let Some(expected_uuid) = device_id.strip_prefix("vulkan:uuid:") else {
            return;
        };
        let profile_id = match os {
            HostOs::Windows => "windows_trt_6g",
            HostOs::Linux => "linux_trt_6g",
        };
        let env = accelerator_env(
            &profile(profile_id, os),
            &nvidia_cards,
            Some(chosen),
            None,
            "",
        );
        let (key, value) = env
            .iter()
            .find(|(key, _)| key == "CUDA_VISIBLE_DEVICES")
            .expect("selected NVIDIA device must have a CUDA selector");
        let output = std::process::Command::new(python)
            .args([
                "-c",
                "import torch;print(torch.cuda.device_count());print(torch.cuda.get_device_properties(0).uuid)",
            ])
            .env(key, value)
            .output()
            .expect("GPU placement Python process");
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut lines = stdout.lines();
        assert_eq!(lines.next().unwrap_or_default().trim(), "1");
        let seen_uuid = lines.next().unwrap_or_default();
        let normalize = |uuid: &str| {
            uuid.trim()
                .trim_start_matches("GPU-")
                .chars()
                .filter(|ch| ch.is_ascii_hexdigit())
                .map(|ch| ch.to_ascii_lowercase())
                .collect::<String>()
        };
        assert_eq!(normalize(seen_uuid), normalize(expected_uuid));
    }

    #[test]
    fn unsupported_inventory_or_no_released_candidate_stays_empty() {
        let entry = registry_entry("linux_trt_6g", "linux", "cuda", "tensorrt_locdit", 6, "released");
        let unavailable = crate::accelerator::AcceleratorInventory {
            status: crate::accelerator::DetectionStatus::Unavailable,
            devices: Vec::new(),
            error_code: None,
        };
        assert!(select_profile(&[entry], Some(HostOs::Linux), &unavailable, None, &["tensorrt_locdit"]).is_none());
        assert!(select_profile(&[], Some(HostOs::Linux), &detected_inventory(Vec::new()), None, &["tensorrt_locdit"]).is_none());
    }

    #[test]
    fn 한_장뿐이면_설정으로_고를_이유가_없다() {
        assert!(!gpu_choice_is_meaningful(&[gpu(0, 24000)]));
        assert!(gpu_choice_is_meaningful(&[gpu(0, 24000), gpu(1, 24000)]));
    }
}
