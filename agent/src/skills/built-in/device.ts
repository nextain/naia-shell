import {
	approveDevicePair,
	approveNodePair,
	describeNode,
	listDevicePairings,
	listNodePairRequests,
	listNodes,
	rejectDevicePair,
	rejectNodePair,
	renameNode,
	requestNodePair,
	revokeDeviceToken,
	rotateDeviceToken,
	verifyNodePair,
} from "../../gateway/device-proxy.js";
import { deviceDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createDeviceSkill(): SkillDefinition {
	return {
		name: `skill_${deviceDescriptor.name}`,
		description: deviceDescriptor.description,
		parameters: deviceDescriptor.inputSchema,
		tier: 1,
		requiresGateway: true,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			const gateway = ctx.gateway;

			if (!gateway?.isConnected()) {
				return {
					success: false,
					output: "",
					error:
						"Gateway not connected. Device management requires a running Gateway.",
				};
			}

			switch (action) {
				case "node_list": {
					const result = await listNodes(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "node_describe": {
					const nodeId = args.nodeId as string;
					if (!nodeId) {
						return {
							success: false,
							output: "",
							error: "nodeId is required for node_describe",
						};
					}
					const result = await describeNode(gateway, nodeId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "node_rename": {
					const nodeId = args.nodeId as string;
					const name = args.name as string;
					if (!nodeId) {
						return {
							success: false,
							output: "",
							error: "nodeId is required for node_rename",
						};
					}
					if (!name) {
						return {
							success: false,
							output: "",
							error: "name is required for node_rename",
						};
					}
					const result = await renameNode(gateway, nodeId, name);
					return { success: true, output: JSON.stringify(result) };
				}

				case "pair_request": {
					const nodeId = args.nodeId as string;
					if (!nodeId) {
						return {
							success: false,
							output: "",
							error: "nodeId is required for pair_request",
						};
					}
					const result = await requestNodePair(gateway, nodeId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "pair_list": {
					const result = await listNodePairRequests(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "pair_approve": {
					const requestId = args.requestId as string;
					if (!requestId) {
						return {
							success: false,
							output: "",
							error: "requestId is required for pair_approve",
						};
					}
					const result = await approveNodePair(gateway, requestId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "pair_reject": {
					const requestId = args.requestId as string;
					if (!requestId) {
						return {
							success: false,
							output: "",
							error: "requestId is required for pair_reject",
						};
					}
					const result = await rejectNodePair(gateway, requestId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "pair_verify": {
					const requestId = args.requestId as string;
					const code = args.code as string;
					if (!requestId) {
						return {
							success: false,
							output: "",
							error: "requestId is required for pair_verify",
						};
					}
					if (!code) {
						return {
							success: false,
							output: "",
							error: "code is required for pair_verify",
						};
					}
					const result = await verifyNodePair(gateway, requestId, code);
					return { success: true, output: JSON.stringify(result) };
				}

				case "device_list": {
					const result = await listDevicePairings(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "device_approve": {
					const deviceId = args.deviceId as string;
					if (!deviceId) {
						return {
							success: false,
							output: "",
							error: "deviceId is required for device_approve",
						};
					}
					const result = await approveDevicePair(gateway, deviceId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "device_reject": {
					const deviceId = args.deviceId as string;
					if (!deviceId) {
						return {
							success: false,
							output: "",
							error: "deviceId is required for device_reject",
						};
					}
					const result = await rejectDevicePair(gateway, deviceId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "token_rotate": {
					const deviceId = args.deviceId as string;
					if (!deviceId) {
						return {
							success: false,
							output: "",
							error: "deviceId is required for token_rotate",
						};
					}
					const result = await rotateDeviceToken(gateway, deviceId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "token_revoke": {
					const deviceId = args.deviceId as string;
					if (!deviceId) {
						return {
							success: false,
							output: "",
							error: "deviceId is required for token_revoke",
						};
					}
					const result = await revokeDeviceToken(gateway, deviceId);
					return { success: true, output: JSON.stringify(result) };
				}

				default:
					return {
						success: false,
						output: "",
						error: `Unknown action: ${action}`,
					};
			}
		},
	};
}
