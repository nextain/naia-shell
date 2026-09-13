import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../adk-store", () => ({
	getAdkPath: () => "/tmp/test-adk",
}));

import {
	listDeviceNodes,
	renameDeviceNode,
	revokeDeviceToken,
	rotateDeviceToken,
	verifyDeviceToken,
} from "../device-store";

describe("device-store", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("lists nodes through device_node_list", async () => {
		mockInvoke.mockResolvedValueOnce({
			nodes: [{ nodeId: "n1", displayName: "desk", revoked: false }],
		});
		const nodes = await listDeviceNodes();
		expect(mockInvoke).toHaveBeenCalledWith("device_node_list", {
			adkPath: "/tmp/test-adk",
		});
		expect(nodes[0]?.nodeId).toBe("n1");
	});

	it("renames through device_node_rename", async () => {
		mockInvoke.mockResolvedValueOnce({ nodeId: "n1", displayName: "e2e-node" });
		const node = await renameDeviceNode("n1", "e2e-node");
		expect(mockInvoke).toHaveBeenCalledWith("device_node_rename", {
			adkPath: "/tmp/test-adk",
			nodeId: "n1",
			displayName: "e2e-node",
		});
		expect(node.displayName).toBe("e2e-node");
	});

	it("rotates through device_token_rotate", async () => {
		mockInvoke.mockResolvedValueOnce({
			node: { nodeId: "n1" },
			token: "ndt_new",
		});
		const rotated = await rotateDeviceToken("n1");
		expect(mockInvoke).toHaveBeenCalledWith("device_token_rotate", {
			adkPath: "/tmp/test-adk",
			nodeId: "n1",
		});
		expect(rotated.token).toBe("ndt_new");
	});

	it("revokes through device_token_revoke", async () => {
		mockInvoke.mockResolvedValueOnce({ ok: true });
		await revokeDeviceToken("n1");
		expect(mockInvoke).toHaveBeenCalledWith("device_token_revoke", {
			adkPath: "/tmp/test-adk",
			nodeId: "n1",
		});
	});

	it("verifies through device_token_verify", async () => {
		mockInvoke.mockResolvedValueOnce({ valid: false });
		await expect(verifyDeviceToken("n1", "old")).resolves.toBe(false);
	});
});
