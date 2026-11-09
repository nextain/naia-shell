export interface WebGpuAdapterSummary {
	vendor: string;
	architecture: string;
	description: string;
}

export interface GpuAdapterLike {
	features: {
		has(name: string): boolean;
	};
	info?: {
		vendor?: string;
		architecture?: string;
		description?: string;
	};
}

export interface GpuLike {
	requestAdapter(opts?: {
		powerPreference?: "high-performance" | "low-power";
	}): Promise<GpuAdapterLike | null>;
}

export function readNavigatorGpu(): GpuLike | undefined {
	if (typeof navigator === "undefined" || !("gpu" in navigator)) {
		return undefined;
	}
	const candidate = (navigator as { gpu?: unknown }).gpu;
	if (
		candidate &&
		typeof candidate === "object" &&
		"requestAdapter" in candidate &&
		typeof (candidate as { requestAdapter: unknown }).requestAdapter === "function"
	) {
		return candidate as GpuLike;
	}
	return undefined;
}

export async function checkWebGpu(
	gpu: GpuLike | undefined,
): Promise<
	| { ok: true; adapter: WebGpuAdapterSummary; shaderF16: boolean }
	| { ok: false; message: string }
> {
	if (!gpu) {
		return {
			ok: false,
			message: `navigator.gpu ${String.fromCodePoint(0xc5c6, 0xc74c)}`,
		};
	}
	try {
		const adapter = await gpu.requestAdapter({
			powerPreference: "high-performance",
		});
		if (!adapter) {
			return {
				ok: false,
				message: String.fromCodePoint(
					0xc5b4,
					0xb311,
					0xd130,
					0x20,
					0xc5c6,
					0xc74c,
				),
			};
		}
		const shaderF16 = adapter.features.has("shader-f16");
		const info = adapter.info;
		const summary: WebGpuAdapterSummary = {
			vendor: info?.vendor ?? "",
			architecture: info?.architecture ?? "",
			description: info?.description ?? "",
		};
		return { ok: true, adapter: summary, shaderF16 };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message };
	}
}
