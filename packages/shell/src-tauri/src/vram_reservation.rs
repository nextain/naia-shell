//! Process-wide admission for local models that reserve accelerator memory.
//!
//! Callers provide an approved workload size and the stable accelerator device
//! ID. Inventory is read fresh for each admission; the settings/profile cache
//! is intentionally not involved.

use crate::accelerator::{self, AcceleratorInventory, DetectionStatus};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

const GIB: u64 = 1_073_741_824;
const EIGHT_GIB: u64 = 8 * GIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LocalModelKind {
    Voice,
    #[allow(dead_code)] // Exposed for the #758 local-LLM consumer that is not in this stage.
    LocalLlm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalModelRequest {
    pub(crate) device_id: String,
    pub(crate) kind: LocalModelKind,
    pub(crate) workload_id: String,
    pub(crate) reservation_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReservationStatus {
    Starting,
    Running,
}

/// The intentionally small view shared with future local-model consumers.
/// It contains no paths, device details, or model configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReservationSnapshot {
    pub(crate) kind: LocalModelKind,
    pub(crate) status: ReservationStatus,
    pub(crate) reservation_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReservationDenialReason {
    InventoryUnavailable,
    DeviceNotFound,
    AvailableVramUnknown,
    InsufficientAvailableVram,
    SameDeviceConflict,
    PolicyUndecided,
    WorkloadAlreadyReserved,
    InvalidReservationSize,
    ReservationAccountingOverflow,
    ReservationTokenExhausted,
}

impl ReservationDenialReason {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InventoryUnavailable => "inventory_unavailable",
            Self::DeviceNotFound => "device_not_found",
            Self::AvailableVramUnknown => "available_vram_unknown",
            Self::InsufficientAvailableVram => "insufficient_available_vram",
            Self::SameDeviceConflict => "same_device_conflict",
            Self::PolicyUndecided => "policy_undecided",
            Self::WorkloadAlreadyReserved => "workload_already_reserved",
            Self::InvalidReservationSize => "invalid_reservation_size",
            Self::ReservationAccountingOverflow => "reservation_accounting_overflow",
            Self::ReservationTokenExhausted => "reservation_token_exhausted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReservationDenial {
    pub(crate) reason: ReservationDenialReason,
    pub(crate) request_bytes: u64,
    /// Effective available bytes after subtracting reservations still starting.
    pub(crate) available_vram_bytes: Option<u64>,
    pub(crate) conflicting_kind: Option<LocalModelKind>,
}

#[derive(Debug)]
struct ReservationEntry {
    request: LocalModelRequest,
    status: ReservationStatus,
}

#[derive(Debug, Default)]
struct ReservationState {
    next_token: u64,
    entries: BTreeMap<u64, ReservationEntry>,
}

/// Clones share the same lock and token space. Tests can construct an isolated
/// manager while production consumers use `process_manager()`.
#[derive(Debug, Clone, Default)]
struct ReservationManager {
    state: Arc<Mutex<ReservationState>>,
}

impl ReservationManager {
    fn lock(&self) -> MutexGuard<'_, ReservationState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn try_reserve_with_inventory(
        &self,
        request: LocalModelRequest,
        inventory: &AcceleratorInventory,
    ) -> Result<ReservationLease, ReservationDenial> {
        let device = inventory
            .devices
            .iter()
            .find(|device| device.provider_id.value == request.device_id);
        let Some(device) = device else {
            let reason = if inventory.status == DetectionStatus::Detected {
                ReservationDenialReason::DeviceNotFound
            } else {
                ReservationDenialReason::InventoryUnavailable
            };
            return Err(denial(reason, request.reservation_bytes, None, None));
        };

        let mut state = self.lock();
        let pending_bytes = checked_starting_total(state.entries.values().filter_map(|entry| {
            (entry.request.device_id == request.device_id
                && entry.status == ReservationStatus::Starting)
                .then_some(entry.request.reservation_bytes)
        }))
        .ok_or_else(|| {
            denial(
                ReservationDenialReason::ReservationAccountingOverflow,
                request.reservation_bytes,
                device.available_vram_bytes,
                None,
            )
        })?;
        let effective_available = device
            .available_vram_bytes
            .and_then(|available| available.checked_sub(pending_bytes));

        let conflict = state.entries.values().find(|entry| {
            entry.request.device_id == request.device_id && entry.request.kind != request.kind
        });
        if let Some(conflict) = conflict {
            let reason = match device.total_vram_bytes {
                Some(total) if total <= EIGHT_GIB => ReservationDenialReason::SameDeviceConflict,
                _ => ReservationDenialReason::PolicyUndecided,
            };
            return Err(denial(
                reason,
                request.reservation_bytes,
                effective_available,
                Some(conflict.request.kind),
            ));
        }

        if request.reservation_bytes == 0 {
            return Err(denial(
                ReservationDenialReason::InvalidReservationSize,
                request.reservation_bytes,
                effective_available,
                None,
            ));
        }

        if state.entries.values().any(|entry| {
            entry.request.device_id == request.device_id
                && entry.request.kind == request.kind
                && entry.request.workload_id == request.workload_id
        }) {
            return Err(denial(
                ReservationDenialReason::WorkloadAlreadyReserved,
                request.reservation_bytes,
                effective_available,
                None,
            ));
        }

        let Some(reported_available) = device.available_vram_bytes else {
            return Err(denial(
                ReservationDenialReason::AvailableVramUnknown,
                request.reservation_bytes,
                None,
                None,
            ));
        };
        let Some(effective_available) = effective_available else {
            return Err(denial(
                ReservationDenialReason::InsufficientAvailableVram,
                request.reservation_bytes,
                Some(0),
                None,
            ));
        };
        if request.reservation_bytes > effective_available {
            return Err(denial(
                ReservationDenialReason::InsufficientAvailableVram,
                request.reservation_bytes,
                Some(effective_available),
                None,
            ));
        }

        let token = state.next_token.checked_add(1).ok_or_else(|| {
            denial(
                ReservationDenialReason::ReservationTokenExhausted,
                request.reservation_bytes,
                Some(effective_available),
                None,
            )
        })?;
        state.next_token = token;
        let kind = request.kind;
        let device_id = request.device_id.clone();
        let reservation_bytes = request.reservation_bytes;
        state.entries.insert(
            token,
            ReservationEntry {
                request,
                status: ReservationStatus::Starting,
            },
        );
        drop(state);

        reservation_log(&format!(
            "reservation granted device_id={device_id} kind={kind:?} bytes={reservation_bytes} available={reported_available} effective_available={effective_available}"
        ));
        Ok(ReservationLease {
            manager: self.clone(),
            token,
            device_id,
            kind,
        })
    }

    fn reservations_for_device(&self, device_id: &str) -> Vec<ReservationSnapshot> {
        self.lock()
            .entries
            .values()
            .filter(|entry| entry.request.device_id == device_id)
            .map(|entry| ReservationSnapshot {
                kind: entry.request.kind,
                status: entry.status,
                reservation_bytes: entry.request.reservation_bytes,
            })
            .collect()
    }

    fn mark_running(&self, token: u64) -> bool {
        let mut state = self.lock();
        let Some(entry) = state.entries.get_mut(&token) else {
            return false;
        };
        entry.status = ReservationStatus::Running;
        true
    }

    fn release(&self, token: u64) {
        let removed = self.lock().entries.remove(&token);
        if let Some(entry) = removed {
            reservation_log(&format!(
                "reservation released device_id={} kind={:?} state={:?} bytes={}",
                entry.request.device_id,
                entry.request.kind,
                entry.status,
                entry.request.reservation_bytes
            ));
        }
    }
}

/// Owns exactly one reservation. Dropping it removes that reservation once.
/// The voice process stores the lease until its child has been reaped.
#[derive(Debug)]
pub(crate) struct ReservationLease {
    manager: ReservationManager,
    token: u64,
    device_id: String,
    kind: LocalModelKind,
}

impl ReservationLease {
    pub(crate) fn mark_running(&self) -> bool {
        let changed = self.manager.mark_running(self.token);
        reservation_log(&format!(
            "reservation mark_running device_id={} kind={:?} changed={changed}",
            self.device_id, self.kind
        ));
        changed
    }
}

impl Drop for ReservationLease {
    fn drop(&mut self) {
        self.manager.release(self.token);
    }
}

fn process_manager() -> &'static ReservationManager {
    static MANAGER: OnceLock<ReservationManager> = OnceLock::new();
    MANAGER.get_or_init(ReservationManager::default)
}

/// Reserve an accelerator for a local model using a fresh provider inventory.
/// Call this before spawning the process and keep the returned lease for its
/// full lifetime.
pub(crate) async fn try_reserve(
    request: LocalModelRequest,
) -> Result<ReservationLease, ReservationDenial> {
    reservation_log(&format!(
        "try_reserve device_id={} kind={:?} bytes={}",
        request.device_id, request.kind, request.reservation_bytes
    ));
    try_reserve_with_loader(process_manager(), request, accelerator::list_accelerators).await
}

/// Return only active reservation kind, state, and bytes for a stable device ID.
#[allow(dead_code)] // Reserved for the #758 local-LLM consumer contract.
pub(crate) fn reservations_for_device(device_id: &str) -> Vec<ReservationSnapshot> {
    process_manager().reservations_for_device(device_id)
}

async fn try_reserve_with_loader<F>(
    manager: &ReservationManager,
    request: LocalModelRequest,
    load: F,
) -> Result<ReservationLease, ReservationDenial>
where
    F: FnOnce() -> AcceleratorInventory + Send + 'static,
{
    let request_bytes = request.reservation_bytes;
    let inventory = tokio::task::spawn_blocking(load).await.map_err(|_| {
        denial(
            ReservationDenialReason::InventoryUnavailable,
            request_bytes,
            None,
            None,
        )
    })?;
    manager.try_reserve_with_inventory(request, &inventory)
}

fn checked_starting_total(bytes: impl IntoIterator<Item = u64>) -> Option<u64> {
    bytes
        .into_iter()
        .try_fold(0_u64, |total, value| total.checked_add(value))
}

fn denial(
    reason: ReservationDenialReason,
    request_bytes: u64,
    available_vram_bytes: Option<u64>,
    conflicting_kind: Option<LocalModelKind>,
) -> ReservationDenial {
    reservation_log(&format!(
        "reservation denied reason={} request_bytes={request_bytes} available_bytes={available_vram_bytes:?} conflicting_kind={conflicting_kind:?}",
        reason.code()
    ));
    ReservationDenial {
        reason,
        request_bytes,
        available_vram_bytes,
        conflicting_kind,
    }
}

fn reservation_log(message: &str) {
    // Cargo fixtures must not write to the user's normal application log.
    #[cfg(not(test))]
    crate::log_verbose(&format!("[vram_reservation] {message}"));
    #[cfg(test)]
    let _ = message;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accelerator::{
        AcceleratorApi, AcceleratorDevice, AcceleratorInventory, DeviceIdKind, HardwareVendor,
        InformationSource, ProviderScopedDeviceId,
    };
    use std::sync::{Arc, Barrier};

    fn device(id: &str, total: Option<u64>, available: Option<u64>) -> AcceleratorDevice {
        AcceleratorDevice {
            accelerator: AcceleratorApi::Vulkan,
            vendor: HardwareVendor::Nvidia,
            name: Some("fixture device".to_string()),
            provider_id: ProviderScopedDeviceId {
                provider: AcceleratorApi::Vulkan,
                kind: DeviceIdKind::VulkanUuid,
                value: format!("vulkan:uuid:{id}"),
            },
            total_vram_bytes: total,
            available_vram_bytes: available,
            info_source: InformationSource::Vulkan,
            total_vram_source: total.map(|_| InformationSource::Vulkan),
            available_vram_source: available.map(|_| InformationSource::VulkanMemoryBudget),
            nvidia: None,
            nvidia_info_source: None,
        }
    }

    fn inventory(devices: Vec<AcceleratorDevice>) -> AcceleratorInventory {
        AcceleratorInventory {
            status: if devices.is_empty() {
                DetectionStatus::NoDevices
            } else {
                DetectionStatus::Detected
            },
            devices,
            error_code: None,
        }
    }

    fn request(
        device_id: &str,
        kind: LocalModelKind,
        workload: &str,
        bytes: u64,
    ) -> LocalModelRequest {
        LocalModelRequest {
            device_id: format!("vulkan:uuid:{device_id}"),
            kind,
            workload_id: workload.to_string(),
            reservation_bytes: bytes,
        }
    }

    fn eight_gib(id: &str, available: Option<u64>) -> AcceleratorInventory {
        inventory(vec![device(id, Some(EIGHT_GIB), available)])
    }

    #[test]
    fn eight_gib_device_rejects_opposite_kind_in_both_directions_and_keeps_existing_lease() {
        for (existing, requested) in [
            (LocalModelKind::Voice, LocalModelKind::LocalLlm),
            (LocalModelKind::LocalLlm, LocalModelKind::Voice),
        ] {
            let manager = ReservationManager::default();
            let fixture = eight_gib("a", Some(EIGHT_GIB));
            let lease = manager
                .try_reserve_with_inventory(request("a", existing, "first", GIB), &fixture)
                .unwrap();
            let denied = manager
                .try_reserve_with_inventory(request("a", requested, "second", GIB), &fixture)
                .unwrap_err();
            assert_eq!(denied.reason, ReservationDenialReason::SameDeviceConflict);
            assert_eq!(denied.conflicting_kind, Some(existing));
            assert_eq!(manager.reservations_for_device("vulkan:uuid:a").len(), 1);
            drop(lease);
        }
    }

    #[test]
    fn reservations_on_different_devices_do_not_conflict() {
        let manager = ReservationManager::default();
        let fixture = inventory(vec![
            device("a", Some(EIGHT_GIB), Some(EIGHT_GIB)),
            device("b", Some(EIGHT_GIB), Some(EIGHT_GIB)),
        ]);
        let voice = manager
            .try_reserve_with_inventory(request("a", LocalModelKind::Voice, "voice", GIB), &fixture)
            .unwrap();
        let llm = manager
            .try_reserve_with_inventory(
                request("b", LocalModelKind::LocalLlm, "llm", GIB),
                &fixture,
            )
            .unwrap();
        assert_eq!(manager.reservations_for_device("vulkan:uuid:a").len(), 1);
        assert_eq!(manager.reservations_for_device("vulkan:uuid:b").len(), 1);
        drop((voice, llm));
    }

    #[test]
    fn devices_above_eight_gib_deny_unresolved_cross_kind_policy() {
        let manager = ReservationManager::default();
        let fixture = inventory(vec![device("a", Some(16 * GIB), Some(16 * GIB))]);
        let voice = manager
            .try_reserve_with_inventory(request("a", LocalModelKind::Voice, "voice", GIB), &fixture)
            .unwrap();
        let denied = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::LocalLlm, "llm", GIB),
                &fixture,
            )
            .unwrap_err();
        assert_eq!(denied.reason, ReservationDenialReason::PolicyUndecided);
        assert_eq!(denied.reason.code(), "policy_undecided");
        assert_eq!(manager.reservations_for_device("vulkan:uuid:a").len(), 1);
        drop(voice);
    }

    #[test]
    fn missing_or_insufficient_available_vram_denies_without_total_vram_fallback() {
        let manager = ReservationManager::default();
        let unknown = inventory(vec![device("a", Some(16 * GIB), None)]);
        let denied = manager
            .try_reserve_with_inventory(request("a", LocalModelKind::Voice, "voice", GIB), &unknown)
            .unwrap_err();
        assert_eq!(denied.reason, ReservationDenialReason::AvailableVramUnknown);
        assert_eq!(denied.available_vram_bytes, None);

        let low = inventory(vec![device("b", Some(16 * GIB), Some(GIB - 1))]);
        let denied = manager
            .try_reserve_with_inventory(request("b", LocalModelKind::Voice, "voice", GIB), &low)
            .unwrap_err();
        assert_eq!(
            denied.reason,
            ReservationDenialReason::InsufficientAvailableVram
        );
        assert_eq!(denied.available_vram_bytes, Some(GIB - 1));
    }

    #[test]
    fn only_starting_reservations_are_subtracted_from_fresh_available_bytes() {
        let manager = ReservationManager::default();
        let fixture = inventory(vec![device("a", Some(16 * GIB), Some(8 * GIB))]);
        let starting = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::LocalLlm, "first", 3 * GIB),
                &fixture,
            )
            .unwrap();
        let denied = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::LocalLlm, "second", 6 * GIB),
                &fixture,
            )
            .unwrap_err();
        assert_eq!(
            denied.reason,
            ReservationDenialReason::InsufficientAvailableVram
        );
        assert_eq!(denied.available_vram_bytes, Some(5 * GIB));

        assert!(starting.mark_running());
        let running_reservation = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::LocalLlm, "third", 6 * GIB),
                &fixture,
            )
            .unwrap();
        drop((starting, running_reservation));
    }

    #[test]
    fn failed_start_drops_the_unpublished_lease_and_allows_a_retry() {
        let manager = ReservationManager::default();
        let fixture = eight_gib("a", Some(EIGHT_GIB));
        let lease = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::Voice, "profile", 2 * GIB),
                &fixture,
            )
            .unwrap();
        let failed_start: Result<(), &str> = (|| {
            let _lease = lease;
            Err("child spawn failed")
        })();
        assert_eq!(failed_start, Err("child spawn failed"));
        assert!(manager.reservations_for_device("vulkan:uuid:a").is_empty());
        assert!(manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::Voice, "profile", 2 * GIB),
                &fixture
            )
            .is_ok());
    }

    #[test]
    fn snapshots_expose_only_kind_state_and_reserved_bytes() {
        let manager = ReservationManager::default();
        let fixture = eight_gib("a", Some(EIGHT_GIB));
        let _lease = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::Voice, "private-model-id", GIB),
                &fixture,
            )
            .unwrap();
        let snapshot = manager
            .reservations_for_device("vulkan:uuid:a")
            .pop()
            .unwrap();
        let json = serde_json::to_value(snapshot).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("kind"));
        assert!(object.contains_key("status"));
        assert!(object.contains_key("reservationBytes"));
        assert!(!json.to_string().contains("private-model-id"));
    }

    #[test]
    fn concurrent_opposite_kind_requests_on_eight_gib_have_one_winner() {
        let manager = ReservationManager::default();
        let fixture = eight_gib("a", Some(EIGHT_GIB));
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = [LocalModelKind::Voice, LocalModelKind::LocalLlm]
            .into_iter()
            .map(|kind| {
                let manager = manager.clone();
                let fixture = fixture.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    manager
                        .try_reserve_with_inventory(request("a", kind, "workload", GIB), &fixture)
                })
            })
            .collect();
        barrier.wait();
        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_err()).count(),
            1
        );
        assert_eq!(manager.reservations_for_device("vulkan:uuid:a").len(), 1);
        drop(outcomes);
    }

    #[test]
    fn checked_starting_total_detects_overflow() {
        assert_eq!(checked_starting_total([u64::MAX, 1]), None);
    }

    #[tokio::test]
    async fn a_failed_inventory_read_is_not_cached_for_the_next_reservation() {
        let manager = ReservationManager::default();
        let failed = AcceleratorInventory {
            status: DetectionStatus::Unavailable,
            devices: Vec::new(),
            error_code: None,
        };
        let error = try_reserve_with_loader(
            &manager,
            request("a", LocalModelKind::Voice, "voice", GIB),
            move || failed,
        )
        .await
        .unwrap_err();
        assert_eq!(error.reason, ReservationDenialReason::InventoryUnavailable);
        assert!(manager.reservations_for_device("vulkan:uuid:a").is_empty());

        let next = try_reserve_with_loader(
            &manager,
            request("a", LocalModelKind::Voice, "voice", GIB),
            || eight_gib("a", Some(EIGHT_GIB)),
        )
        .await
        .unwrap();
        assert_eq!(manager.reservations_for_device("vulkan:uuid:a").len(), 1);
        drop(next);
    }

    #[cfg(unix)]
    #[test]
    fn child_is_reaped_before_its_starting_lease_can_be_released() {
        let manager = ReservationManager::default();
        let fixture = eight_gib("a", Some(EIGHT_GIB));
        let lease = manager
            .try_reserve_with_inventory(
                request("a", LocalModelKind::Voice, "profile", GIB),
                &fixture,
            )
            .unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("sleep fixture process should start");

        let status = crate::terminate_and_reap_child(&mut child);
        assert!(status.is_some(), "child must be reaped before returning");
        assert!(child.try_wait().unwrap().is_some());
        assert_eq!(manager.reservations_for_device("vulkan:uuid:a").len(), 1);

        drop(lease);
        assert!(manager.reservations_for_device("vulkan:uuid:a").is_empty());
    }
}
