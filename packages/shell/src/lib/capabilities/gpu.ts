/**
 * GPU VRAM detection (#2 / FR-VRAM.1) — the input to the VRAM-tier bridge.
 *
 * Calls the Rust `detect_gpu_vram` command (nvidia-smi). Capacity only; never
 * implies real-time capability (windows-manager hard rule F1).
 */

import { invoke } from "@tauri-apps/api/core";
import { Logger } from "../logger";

/**
 * Coerce the Rust `detect_gpu_vram` result to a positive GB number, or null.
 * The command returns a whole-GB number or JSON null.
 */
export function parseVramResult(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0
		? raw
		: null;
}

/**
 * Detect a GPU's total VRAM in GB (the given card, else the first). Returns null when unavailable
 * (non-NVIDIA host / no nvidia-smi / IPC error) — the settings UI then falls
 * back to manual tier selection.
 */
export async function detectGpuVramGb(
	gpuIndex?: number | null,
): Promise<number | null> {
	try {
		// 카드 번호를 넘기면 그 카드의 VRAM(흐름이 쓸 카드). 없으면 첫 카드.
		return parseVramResult(
			gpuIndex == null
				? await invoke("detect_gpu_vram")
				: await invoke("detect_gpu_vram", { gpuIndex }),
		);
	} catch (err) {
		Logger.warn("gpu", "detect_gpu_vram failed", { error: String(err) });
		return null;
	}
}
