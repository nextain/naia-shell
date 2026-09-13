import { invoke } from "@tauri-apps/api/core";
import { getAdkPath } from "./adk-store";
import { Logger } from "./logger";

export interface DeviceNode {
	nodeId: string;
	displayName: string;
	platform: string;
	createdAt: number;
	updatedAt: number;
	revoked: boolean;
	hasToken: boolean;
}

export interface DevicePairRequest {
	requestId: string;
	nodeId: string;
	displayName: string;
	platform: string;
	status: string;
	createdAt: number;
}

function requireAdkPath(): string {
	const adkPath = getAdkPath();
	if (!adkPath) throw new Error("ADK path is required");
	return adkPath;
}

export async function listDeviceNodes(): Promise<DeviceNode[]> {
	const adkPath = getAdkPath();
	if (!adkPath) return [];
	try {
		const result = await invoke<{ nodes?: DeviceNode[] }>("device_node_list", {
			adkPath,
		});
		return result.nodes ?? [];
	} catch (e) {
		Logger.warn("device-store", "device_node_list failed", { error: String(e) });
		return [];
	}
}

export async function describeDeviceNode(nodeId: string): Promise<DeviceNode> {
	return invoke<DeviceNode>("device_node_describe", {
		adkPath: requireAdkPath(),
		nodeId,
	});
}

export async function renameDeviceNode(
	nodeId: string,
	displayName: string,
): Promise<DeviceNode> {
	return invoke<DeviceNode>("device_node_rename", {
		adkPath: requireAdkPath(),
		nodeId,
		displayName,
	});
}

export async function rotateDeviceToken(
	nodeId: string,
): Promise<{ node: DeviceNode; token: string }> {
	return invoke<{ node: DeviceNode; token: string }>("device_token_rotate", {
		adkPath: requireAdkPath(),
		nodeId,
	});
}

export async function revokeDeviceToken(nodeId: string): Promise<void> {
	await invoke("device_token_revoke", {
		adkPath: requireAdkPath(),
		nodeId,
	});
}

export async function verifyDeviceToken(
	nodeId: string,
	token: string,
): Promise<boolean> {
	const result = await invoke<{ valid?: boolean }>("device_token_verify", {
		adkPath: requireAdkPath(),
		nodeId,
		token,
	});
	return result.valid === true;
}

export async function listDevicePairRequests(): Promise<DevicePairRequest[]> {
	const adkPath = getAdkPath();
	if (!adkPath) return [];
	try {
		const result = await invoke<{ requests?: DevicePairRequest[] }>(
			"device_pair_list",
			{ adkPath },
		);
		return result.requests ?? [];
	} catch (e) {
		Logger.warn("device-store", "device_pair_list failed", { error: String(e) });
		return [];
	}
}

export async function requestDevicePair(input?: {
	nodeId?: string;
	displayName?: string;
	platform?: string;
}): Promise<DevicePairRequest & { code: string }> {
	return invoke<DevicePairRequest & { code: string }>("device_pair_request", {
		adkPath: requireAdkPath(),
		nodeId: input?.nodeId,
		displayName: input?.displayName,
		platform: input?.platform,
	});
}

export async function verifyDevicePair(
	requestId: string,
	code: string,
): Promise<DevicePairRequest> {
	return invoke<DevicePairRequest>("device_pair_verify", {
		adkPath: requireAdkPath(),
		requestId,
		code,
	});
}

export async function approveDevicePair(
	requestId: string,
): Promise<{ node: DeviceNode; token: string }> {
	return invoke<{ node: DeviceNode; token: string }>("device_pair_approve", {
		adkPath: requireAdkPath(),
		requestId,
	});
}

export async function rejectDevicePair(
	requestId: string,
): Promise<DevicePairRequest> {
	return invoke<DevicePairRequest>("device_pair_reject", {
		adkPath: requireAdkPath(),
		requestId,
	});
}
