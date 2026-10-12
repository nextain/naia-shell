//! Hardware inventory for the next voice-profile selection stage.
//!
//! This module intentionally has no consumers in stage 2. It reports Vulkan
//! hardware facts only; it does not choose or start a voice backend.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DetectionStatus {
    Detected,
    NoDevices,
    UnsupportedPlatform,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DetectionErrorCode {
    VulkanLoaderUnavailable,
    VulkanProviderUnavailable,
    VulkanInstanceCreationFailed,
    PhysicalDeviceEnumerationFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AcceleratorApi {
    Vulkan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HardwareVendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeviceIdKind {
    VulkanUuid,
    ModelFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ProviderScopedDeviceId {
    pub(crate) provider: AcceleratorApi,
    pub(crate) kind: DeviceIdKind,
    pub(crate) value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct ComputeCapability {
    pub(crate) major: u16,
    pub(crate) minor: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct NvidiaMetadata {
    pub(crate) compute_capability: Option<ComputeCapability>,
    pub(crate) driver_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InformationSource {
    Vulkan,
    VulkanMemoryBudget,
    NvidiaSmi,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AcceleratorDevice {
    /// Execution API/provider; this is separate from the hardware vendor.
    pub(crate) accelerator: AcceleratorApi,
    pub(crate) vendor: HardwareVendor,
    pub(crate) name: Option<String>,
    pub(crate) provider_id: ProviderScopedDeviceId,
    /// Device-local Vulkan heaps for this physical device only.
    pub(crate) total_vram_bytes: Option<u64>,
    /// Provider-reported available budget; never inferred from total capacity.
    pub(crate) available_vram_bytes: Option<u64>,
    pub(crate) info_source: InformationSource,
    pub(crate) total_vram_source: Option<InformationSource>,
    pub(crate) available_vram_source: Option<InformationSource>,
    pub(crate) nvidia: Option<NvidiaMetadata>,
    pub(crate) nvidia_info_source: Option<InformationSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AcceleratorInventory {
    pub(crate) status: DetectionStatus,
    pub(crate) devices: Vec<AcceleratorDevice>,
    /// A stable code only. Provider messages and hardware details are not
    /// promoted into a successful result.
    pub(crate) error_code: Option<DetectionErrorCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MemoryHeap {
    size_bytes: u64,
    device_local: bool,
    budget_bytes: Option<u64>,
    usage_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NvidiaSupplement {
    uuid: String,
    metadata: NvidiaMetadata,
    available_vram_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawVulkanDevice {
    vendor_id: u32,
    device_id: u32,
    name: Option<String>,
    uuid: Option<String>,
    memory_heaps: Vec<MemoryHeap>,
    nvidia_supplement: Option<NvidiaSupplement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeOutcome {
    Enumerated(Vec<RawVulkanDevice>),
    UnsupportedPlatform,
    Unavailable(DetectionErrorCode),
    Error(DetectionErrorCode),
}

/// Enumerate Vulkan devices without changing any existing consumer path.
pub(crate) fn list_accelerators() -> AcceleratorInventory {
    inventory_from_probe(platform_probe())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn platform_probe() -> ProbeOutcome {
    vulkan::enumerate()
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn platform_probe() -> ProbeOutcome {
    ProbeOutcome::UnsupportedPlatform
}

fn inventory_from_probe(outcome: ProbeOutcome) -> AcceleratorInventory {
    match outcome {
        ProbeOutcome::UnsupportedPlatform => AcceleratorInventory {
            status: DetectionStatus::UnsupportedPlatform,
            devices: Vec::new(),
            error_code: None,
        },
        ProbeOutcome::Unavailable(error_code) => AcceleratorInventory {
            status: DetectionStatus::Unavailable,
            devices: Vec::new(),
            error_code: Some(error_code),
        },
        ProbeOutcome::Error(error_code) => AcceleratorInventory {
            status: DetectionStatus::Error,
            devices: Vec::new(),
            error_code: Some(error_code),
        },
        ProbeOutcome::Enumerated(raw_devices) if raw_devices.is_empty() => AcceleratorInventory {
            status: DetectionStatus::NoDevices,
            devices: Vec::new(),
            error_code: None,
        },
        ProbeOutcome::Enumerated(raw_devices) => AcceleratorInventory {
            status: DetectionStatus::Detected,
            devices: raw_devices.into_iter().map(device_from_raw).collect(),
            error_code: None,
        },
    }
}

fn device_from_raw(raw: RawVulkanDevice) -> AcceleratorDevice {
    let vendor = vendor_from_id(raw.vendor_id);
    let provider_id = provider_scoped_id(&raw);
    let total_vram_bytes = total_device_local_memory(&raw.memory_heaps);
    let vulkan_available_vram_bytes = available_device_local_memory(&raw.memory_heaps);
    let nvidia_supplement = if vendor == HardwareVendor::Nvidia {
        raw.nvidia_supplement.filter(|supplement| {
            Some(normalize_uuid(&supplement.uuid)) == raw.uuid.as_deref().map(normalize_uuid)
        })
    } else {
        None
    };

    let nvidia_available_vram_bytes = nvidia_supplement
        .as_ref()
        .and_then(|supplement| supplement.available_vram_bytes);
    let available_vram_bytes = nvidia_available_vram_bytes.or(vulkan_available_vram_bytes);
    let available_vram_source = if nvidia_available_vram_bytes.is_some() {
        Some(InformationSource::NvidiaSmi)
    } else {
        vulkan_available_vram_bytes.map(|_| InformationSource::VulkanMemoryBudget)
    };
    let nvidia = nvidia_supplement.map(|supplement| supplement.metadata);

    AcceleratorDevice {
        accelerator: AcceleratorApi::Vulkan,
        vendor,
        name: raw.name,
        provider_id,
        total_vram_bytes,
        available_vram_bytes,
        info_source: InformationSource::Vulkan,
        total_vram_source: total_vram_bytes.map(|_| InformationSource::Vulkan),
        available_vram_source,
        nvidia_info_source: nvidia.as_ref().map(|_| InformationSource::NvidiaSmi),
        nvidia,
    }
}

fn vendor_from_id(vendor_id: u32) -> HardwareVendor {
    match vendor_id {
        0x10DE => HardwareVendor::Nvidia,
        0x1002 => HardwareVendor::Amd,
        0x8086 => HardwareVendor::Intel,
        _ => HardwareVendor::Other,
    }
}

fn provider_scoped_id(raw: &RawVulkanDevice) -> ProviderScopedDeviceId {
    match raw.uuid.as_deref() {
        Some(uuid) if !uuid.is_empty() => ProviderScopedDeviceId {
            provider: AcceleratorApi::Vulkan,
            kind: DeviceIdKind::VulkanUuid,
            value: format!("vulkan:uuid:{}", normalize_uuid(uuid)),
        },
        _ => ProviderScopedDeviceId {
            provider: AcceleratorApi::Vulkan,
            kind: DeviceIdKind::ModelFingerprint,
            value: format!(
                "vulkan:model:{:04x}:{:04x}:{}",
                raw.vendor_id,
                raw.device_id,
                raw.name.as_deref().unwrap_or("unknown")
            ),
        },
    }
}

fn total_device_local_memory(heaps: &[MemoryHeap]) -> Option<u64> {
    let mut found_local_heap = false;
    let total = heaps
        .iter()
        .filter(|heap| heap.device_local)
        .try_fold(0_u64, |total, heap| {
            found_local_heap = true;
            total.checked_add(heap.size_bytes)
        })?;

    (found_local_heap && total > 0).then_some(total)
}

fn available_device_local_memory(heaps: &[MemoryHeap]) -> Option<u64> {
    let mut found_local_heap = false;
    let available =
        heaps
            .iter()
            .filter(|heap| heap.device_local)
            .try_fold(0_u64, |available, heap| {
                found_local_heap = true;
                let budget = heap.budget_bytes?;
                let usage = heap.usage_bytes?;
                if budget > heap.size_bytes {
                    return None;
                }
                available.checked_add(budget.checked_sub(usage)?)
            })?;

    found_local_heap.then_some(available)
}

fn normalize_uuid(uuid: &str) -> String {
    uuid.chars()
        .filter(|character| character.is_ascii_hexdigit())
        .flat_map(char::to_lowercase)
        .collect()
}

fn parse_nvidia_smi_rows(output: &str) -> Vec<NvidiaSupplement> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(',').map(str::trim);
            let uuid = fields.next()?;
            let compute_capability = fields.next().and_then(parse_compute_capability);
            let driver_version = fields.next().and_then(nonempty_value);
            let available_vram_bytes = fields
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .and_then(|mib| mib.checked_mul(1024 * 1024));

            let normalized_uuid = normalize_uuid(uuid);
            if normalized_uuid.len() != 32 {
                return None;
            }

            Some(NvidiaSupplement {
                uuid: normalized_uuid,
                metadata: NvidiaMetadata {
                    compute_capability,
                    driver_version,
                },
                available_vram_bytes,
            })
        })
        .collect()
}

fn parse_compute_capability(value: &str) -> Option<ComputeCapability> {
    let (major, minor) = value.trim().split_once('.')?;
    Some(ComputeCapability {
        major: major.parse().ok()?,
        minor: minor.parse().ok()?,
    })
}

fn nonempty_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.eq_ignore_ascii_case("n/a")).then(|| value.to_owned())
}

fn match_nvidia_supplements(
    raw_devices: &mut [RawVulkanDevice],
    supplements: Vec<NvidiaSupplement>,
) {
    let mut supplements = supplements
        .into_iter()
        .map(|supplement| (normalize_uuid(&supplement.uuid), supplement))
        .collect::<std::collections::HashMap<_, _>>();

    for raw in raw_devices {
        if vendor_from_id(raw.vendor_id) != HardwareVendor::Nvidia {
            continue;
        }
        let Some(uuid) = raw.uuid.as_deref() else {
            continue;
        };
        raw.nvidia_supplement = supplements.remove(&normalize_uuid(uuid));
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod vulkan {
    use super::{
        match_nvidia_supplements, DetectionErrorCode, HardwareVendor, MemoryHeap, ProbeOutcome,
        RawVulkanDevice,
    };
    use ash::{vk, Entry};
    use std::ffi::CStr;
    use std::process::Command;

    pub(super) fn enumerate() -> ProbeOutcome {
        let entry = match unsafe { Entry::load() } {
            Ok(entry) => entry,
            Err(_) => {
                return ProbeOutcome::Unavailable(DetectionErrorCode::VulkanLoaderUnavailable)
            }
        };

        let loader_api_version = unsafe { entry.try_enumerate_instance_version() }
            .ok()
            .flatten()
            .unwrap_or(vk::API_VERSION_1_0);
        let instance_api_version = loader_api_version.min(vk::API_VERSION_1_1);
        let application_info = vk::ApplicationInfo::default().api_version(instance_api_version);
        let create_info = vk::InstanceCreateInfo::default().application_info(&application_info);

        let instance = match unsafe { entry.create_instance(&create_info, None) } {
            Ok(instance) => instance,
            Err(
                vk::Result::ERROR_INCOMPATIBLE_DRIVER | vk::Result::ERROR_INITIALIZATION_FAILED,
            ) => return ProbeOutcome::Unavailable(DetectionErrorCode::VulkanProviderUnavailable),
            Err(_) => return ProbeOutcome::Error(DetectionErrorCode::VulkanInstanceCreationFailed),
        };

        let enumeration = unsafe { instance.enumerate_physical_devices() }
            .map_err(|_| DetectionErrorCode::PhysicalDeviceEnumerationFailed)
            .map(|physical_devices| {
                physical_devices
                    .into_iter()
                    .map(|physical_device| unsafe {
                        let properties = instance.get_physical_device_properties(physical_device);
                        let name = CStr::from_ptr(properties.device_name.as_ptr())
                            .to_string_lossy()
                            .into_owned();
                        let memory =
                            instance.get_physical_device_memory_properties(physical_device);
                        let supports_memory_budget = instance_api_version >= vk::API_VERSION_1_1
                            && instance
                                .enumerate_device_extension_properties(physical_device)
                                .map(|extensions| {
                                    extensions.iter().any(|extension| {
                                        CStr::from_ptr(extension.extension_name.as_ptr())
                                            == vk::EXT_MEMORY_BUDGET_NAME
                                    })
                                })
                                .unwrap_or(false);
                        let memory_budget = if supports_memory_budget {
                            let mut budget = vk::PhysicalDeviceMemoryBudgetPropertiesEXT::default();
                            let mut properties2 = vk::PhysicalDeviceMemoryProperties2::default()
                                .push_next(&mut budget);
                            instance.get_physical_device_memory_properties2(
                                physical_device,
                                &mut properties2,
                            );
                            Some((budget.heap_budget, budget.heap_usage))
                        } else {
                            None
                        };
                        let memory_heaps = memory.memory_heaps[..memory.memory_heap_count as usize]
                            .iter()
                            .enumerate()
                            .map(|(index, heap)| MemoryHeap {
                                size_bytes: heap.size,
                                device_local: heap
                                    .flags
                                    .contains(vk::MemoryHeapFlags::DEVICE_LOCAL),
                                budget_bytes: memory_budget.map(|(budgets, _)| budgets[index]),
                                usage_bytes: memory_budget.map(|(_, usages)| usages[index]),
                            })
                            .collect();
                        let uuid = if instance_api_version >= vk::API_VERSION_1_1 {
                            let mut id_properties = vk::PhysicalDeviceIDProperties::default();
                            let mut properties2 = vk::PhysicalDeviceProperties2::default()
                                .push_next(&mut id_properties);
                            instance
                                .get_physical_device_properties2(physical_device, &mut properties2);
                            let bytes = id_properties.device_uuid;
                            bytes
                                .iter()
                                .any(|byte| *byte != 0)
                                .then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
                        } else {
                            None
                        };

                        RawVulkanDevice {
                            vendor_id: properties.vendor_id,
                            device_id: properties.device_id,
                            name: (!name.is_empty()).then_some(name),
                            uuid,
                            memory_heaps,
                            nvidia_supplement: None,
                        }
                    })
                    .collect::<Vec<_>>()
            });

        unsafe { instance.destroy_instance(None) };

        match enumeration {
            Err(error_code) => ProbeOutcome::Error(error_code),
            Ok(mut devices) => {
                if devices.iter().any(|device| {
                    device.vendor_id == vendor_id(HardwareVendor::Nvidia) && device.uuid.is_some()
                }) {
                    match_nvidia_supplements(&mut devices, query_nvidia_smi());
                }
                ProbeOutcome::Enumerated(devices)
            }
        }
    }

    fn vendor_id(vendor: HardwareVendor) -> u32 {
        match vendor {
            HardwareVendor::Nvidia => 0x10DE,
            HardwareVendor::Amd => 0x1002,
            HardwareVendor::Intel => 0x8086,
            HardwareVendor::Other => u32::MAX,
        }
    }

    #[cfg(target_os = "windows")]
    const NVIDIA_SMI: &str = "nvidia-smi.exe";
    #[cfg(target_os = "linux")]
    const NVIDIA_SMI: &str = "nvidia-smi";

    fn query_nvidia_smi() -> Vec<super::NvidiaSupplement> {
        let output = Command::new(NVIDIA_SMI)
            .args([
                "--query-gpu=uuid,compute_cap,driver_version,memory.free",
                "--format=csv,noheader,nounits",
            ])
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let Ok(output) = String::from_utf8(output.stdout) else {
            return Vec::new();
        };
        super::parse_nvidia_smi_rows(&output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NVIDIA_UUID: &str = "00112233445566778899aabbccddeeff";
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * 1024 * 1024;

    fn raw_device(vendor_id: u32, device_id: u32, name: &str, size: u64) -> RawVulkanDevice {
        RawVulkanDevice {
            vendor_id,
            device_id,
            name: Some(name.to_owned()),
            uuid: None,
            memory_heaps: vec![MemoryHeap {
                size_bytes: size,
                device_local: true,
                budget_bytes: None,
                usage_bytes: None,
            }],
            nvidia_supplement: None,
        }
    }

    #[test]
    fn probe_states_stay_distinct() {
        let cases = [
            (
                ProbeOutcome::Enumerated(Vec::new()),
                DetectionStatus::NoDevices,
                None,
            ),
            (
                ProbeOutcome::UnsupportedPlatform,
                DetectionStatus::UnsupportedPlatform,
                None,
            ),
            (
                ProbeOutcome::Unavailable(DetectionErrorCode::VulkanLoaderUnavailable),
                DetectionStatus::Unavailable,
                Some(DetectionErrorCode::VulkanLoaderUnavailable),
            ),
            (
                ProbeOutcome::Error(DetectionErrorCode::PhysicalDeviceEnumerationFailed),
                DetectionStatus::Error,
                Some(DetectionErrorCode::PhysicalDeviceEnumerationFailed),
            ),
        ];

        for (outcome, expected_status, expected_error) in cases {
            let result = inventory_from_probe(outcome);
            assert_eq!(result.status, expected_status);
            assert_eq!(result.error_code, expected_error);
            assert!(result.devices.is_empty());
        }
    }

    #[test]
    fn vendor_fixtures_share_one_vulkan_device_shape() {
        let fixtures = [
            (0x10DE, 0x2684, "NVIDIA RTX fixture"),
            (0x1002, 0x744C, "AMD Radeon fixture"),
            (0x8086, 0x56A0, "Intel Arc fixture"),
            (0x1234, 0x5678, "Other vendor fixture"),
        ];
        let devices = fixtures
            .into_iter()
            .map(|(vendor_id, device_id, name)| raw_device(vendor_id, device_id, name, 8 * GIB))
            .collect();

        let result = inventory_from_probe(ProbeOutcome::Enumerated(devices));

        assert_eq!(result.status, DetectionStatus::Detected);
        assert_eq!(result.devices.len(), 4);
        assert_eq!(
            result
                .devices
                .iter()
                .map(|device| device.vendor)
                .collect::<Vec<_>>(),
            vec![
                HardwareVendor::Nvidia,
                HardwareVendor::Amd,
                HardwareVendor::Intel,
                HardwareVendor::Other,
            ]
        );
        assert!(result.devices.iter().all(|device| {
            device.accelerator == AcceleratorApi::Vulkan
                && device.info_source == InformationSource::Vulkan
                && device.total_vram_bytes == Some(8 * GIB)
                && device.total_vram_source == Some(InformationSource::Vulkan)
                && device.available_vram_bytes.is_none()
                && device.available_vram_source.is_none()
        }));
        assert!(result.devices[1..]
            .iter()
            .all(|device| device.nvidia.is_none()));
    }

    #[test]
    fn device_local_heaps_are_summed_per_device_only() {
        let mut first = raw_device(0x1002, 0x744C, "AMD split heaps", 0);
        first.memory_heaps = vec![
            MemoryHeap {
                size_bytes: 6 * GIB,
                device_local: true,
                budget_bytes: None,
                usage_bytes: None,
            },
            MemoryHeap {
                size_bytes: 2 * GIB,
                device_local: false,
                budget_bytes: None,
                usage_bytes: None,
            },
            MemoryHeap {
                size_bytes: 2 * GIB,
                device_local: true,
                budget_bytes: None,
                usage_bytes: None,
            },
        ];
        let second = raw_device(0x8086, 0x56A0, "Intel separate device", 4 * GIB);

        let result = inventory_from_probe(ProbeOutcome::Enumerated(vec![first, second]));

        assert_eq!(result.devices[0].total_vram_bytes, Some(8 * GIB));
        assert_eq!(result.devices[1].total_vram_bytes, Some(4 * GIB));
    }

    #[test]
    fn missing_vulkan_memory_or_nvidia_supplement_stays_unknown() {
        let mut nvidia = raw_device(0x10DE, 0x2684, "NVIDIA partial fixture", 0);
        nvidia.uuid = Some(NVIDIA_UUID.to_owned());
        let result = inventory_from_probe(ProbeOutcome::Enumerated(vec![nvidia]));

        assert_eq!(result.status, DetectionStatus::Detected);
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.devices[0].total_vram_bytes, None);
        assert_eq!(result.devices[0].available_vram_bytes, None);
        assert_eq!(result.devices[0].nvidia, None);
        assert_eq!(result.devices[0].provider_id.kind, DeviceIdKind::VulkanUuid);
    }

    #[test]
    fn nvidia_supplement_is_matched_by_uuid_and_keeps_provider_memory_values() {
        let mut nvidia = raw_device(0x10DE, 0x2684, "NVIDIA fixture", 12 * GIB);
        nvidia.memory_heaps[0].budget_bytes = Some(3 * GIB);
        nvidia.memory_heaps[0].usage_bytes = Some(2 * GIB);
        nvidia.uuid = Some(NVIDIA_UUID.to_owned());
        let supplemental = parse_nvidia_smi_rows(&format!(
            "GPU-00112233-4455-6677-8899-aabbccddeeff,8.9,560.35.03,4096\n"
        ));
        let mut raw = vec![nvidia];
        match_nvidia_supplements(&mut raw, supplemental);

        let result = inventory_from_probe(ProbeOutcome::Enumerated(raw));
        let device = &result.devices[0];
        assert_eq!(device.accelerator, AcceleratorApi::Vulkan);
        assert_eq!(device.vendor, HardwareVendor::Nvidia);
        assert_eq!(device.total_vram_bytes, Some(12 * GIB));
        assert_eq!(device.available_vram_bytes, Some(4096 * MIB));
        assert_eq!(
            device.available_vram_source,
            Some(InformationSource::NvidiaSmi)
        );
        assert_eq!(
            device.nvidia,
            Some(NvidiaMetadata {
                compute_capability: Some(ComputeCapability { major: 8, minor: 9 }),
                driver_version: Some("560.35.03".to_owned()),
            })
        );
        assert_eq!(
            device.nvidia_info_source,
            Some(InformationSource::NvidiaSmi)
        );
    }

    #[test]
    fn vulkan_memory_budget_reports_device_local_budget_minus_usage() {
        let mut amd = raw_device(0x1002, 0x744C, "AMD budget fixture", 0);
        amd.memory_heaps = vec![
            MemoryHeap {
                size_bytes: 6 * GIB,
                device_local: true,
                budget_bytes: Some(5 * GIB),
                usage_bytes: Some(2 * GIB),
            },
            MemoryHeap {
                size_bytes: 2 * GIB,
                device_local: false,
                budget_bytes: None,
                usage_bytes: None,
            },
            MemoryHeap {
                size_bytes: 4 * GIB,
                device_local: true,
                budget_bytes: Some(3 * GIB),
                usage_bytes: Some(GIB / 2),
            },
        ];

        let device = &inventory_from_probe(ProbeOutcome::Enumerated(vec![amd])).devices[0];

        assert_eq!(device.available_vram_bytes, Some(11 * GIB / 2));
        assert_eq!(
            device.available_vram_source,
            Some(InformationSource::VulkanMemoryBudget)
        );
    }

    #[test]
    fn incomplete_or_invalid_vulkan_budget_stays_unknown() {
        let heaps = [
            MemoryHeap {
                size_bytes: 8 * GIB,
                device_local: true,
                budget_bytes: Some(6 * GIB),
                usage_bytes: None,
            },
            MemoryHeap {
                size_bytes: 8 * GIB,
                device_local: true,
                budget_bytes: Some(9 * GIB),
                usage_bytes: Some(GIB),
            },
            MemoryHeap {
                size_bytes: 8 * GIB,
                device_local: true,
                budget_bytes: Some(GIB),
                usage_bytes: Some(2 * GIB),
            },
        ];

        for heap in heaps {
            assert_eq!(available_device_local_memory(&[heap]), None);
        }
    }

    #[test]
    fn nvidia_query_values_are_optional_and_invalid_rows_are_discarded() {
        let parsed = parse_nvidia_smi_rows(concat!(
            "GPU-00112233-4455-6677-8899-aabbccddeeff,N/A,N/A,N/A\n",
            "not-a-uuid,8.9,560.35.03,4096\n",
            "GPU-ffeeddcc-bbaa-9988-7766-554433221100,invalid, ,overflow\n"
        ));

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].metadata.compute_capability, None);
        assert_eq!(parsed[0].metadata.driver_version, None);
        assert_eq!(parsed[0].available_vram_bytes, None);
        assert_eq!(parsed[1].metadata.compute_capability, None);
        assert_eq!(parsed[1].metadata.driver_version, None);
        assert_eq!(parsed[1].available_vram_bytes, None);
    }

    #[test]
    fn fallback_identity_is_provider_scoped_and_does_not_use_enumeration_order() {
        let first = provider_scoped_id(&raw_device(0x1002, 0x744C, "AMD fixture", 8 * GIB));
        let second = provider_scoped_id(&raw_device(0x1002, 0x744C, "AMD fixture", 8 * GIB));

        assert_eq!(first.provider, AcceleratorApi::Vulkan);
        assert_eq!(first.kind, DeviceIdKind::ModelFingerprint);
        assert_eq!(first, second);
        assert!(!first.value.contains("index"));
    }

    #[test]
    fn uuid_identity_is_normalized_without_losing_provider_scope() {
        let mut raw = raw_device(0x10DE, 0x2684, "NVIDIA fixture", 8 * GIB);
        raw.uuid = Some("GPU-00112233-4455-6677-8899-AABBCCDDEEFF".to_owned());

        let id = provider_scoped_id(&raw);

        assert_eq!(id.provider, AcceleratorApi::Vulkan);
        assert_eq!(id.kind, DeviceIdKind::VulkanUuid);
        assert_eq!(id.value, "vulkan:uuid:00112233445566778899aabbccddeeff");
    }

    #[test]
    fn device_local_heap_overflow_and_no_local_heaps_are_unknown() {
        assert_eq!(total_device_local_memory(&[]), None);
        assert_eq!(
            total_device_local_memory(&[
                MemoryHeap {
                    size_bytes: 4 * GIB,
                    device_local: false,
                    budget_bytes: None,
                    usage_bytes: None,
                },
                MemoryHeap {
                    size_bytes: 0,
                    device_local: true,
                    budget_bytes: None,
                    usage_bytes: None,
                },
            ]),
            None
        );
        assert_eq!(
            total_device_local_memory(&[
                MemoryHeap {
                    size_bytes: u64::MAX,
                    device_local: true,
                    budget_bytes: None,
                    usage_bytes: None,
                },
                MemoryHeap {
                    size_bytes: 1,
                    device_local: true,
                    budget_bytes: None,
                    usage_bytes: None,
                },
            ]),
            None
        );
    }
}
