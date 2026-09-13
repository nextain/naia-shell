import { S } from "../helpers/selectors.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 43 — Device operations through Settings + Tauri IPC (#570).
 *
 * Does not call skill_device. Asserts state change: a rotated token no longer
 * authenticates, and rename/describe/revoke/pair follow the same store.
 */
async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await browser.execute(
		async (cmd: string, a: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (c: string, a: unknown) => Promise<unknown>;
				};
				__TAURI__?: {
					core?: { invoke: (c: string, a: unknown) => Promise<unknown> };
				};
			};
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) throw new Error("Tauri invoke not available");
			return invoke(cmd, a);
		},
		command,
		args,
	)) as T;
}

describe("43 — device operations", () => {
	before(async () => {
		await enableToolsForSpec([]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 15_000 });
	});

	it("pair request/verify/approve then rotate invalidates the old token", async () => {
		const created = await tauriInvoke<{
			request: { requestId: string; nodeId: string };
			code: string;
		}>("device_pair_request", {
			displayName: "e2e-node",
			platform: "windows",
		});
		await tauriInvoke("device_pair_verify", {
			requestId: created.request.requestId,
			code: created.code,
		});
		const approved = await tauriInvoke<{
			node: { nodeId: string; displayName: string };
			token: string;
		}>("device_pair_approve", { requestId: created.request.requestId });

		const before = await tauriInvoke<boolean>("device_authenticate", {
			nodeId: approved.node.nodeId,
			token: approved.token,
		});
		expect(before).toBe(true);

		const rotated = await tauriInvoke<string>("device_token_rotate", {
			nodeId: approved.node.nodeId,
		});
		expect(rotated).not.toBe(approved.token);

		const oldStillWorks = await tauriInvoke<boolean>("device_authenticate", {
			nodeId: approved.node.nodeId,
			token: approved.token,
		});
		expect(oldStillWorks).toBe(false);

		const newWorks = await tauriInvoke<boolean>("device_authenticate", {
			nodeId: approved.node.nodeId,
			token: rotated,
		});
		expect(newWorks).toBe(true);

		const described = await tauriInvoke<{ displayName: string }>(
			"device_describe",
			{ nodeId: approved.node.nodeId },
		);
		expect(described.displayName).toBe("e2e-node");

		await tauriInvoke("device_rename", {
			nodeId: approved.node.nodeId,
			displayName: "renamed-node",
		});
		const renamed = await tauriInvoke<{ displayName: string }>(
			"device_describe",
			{ nodeId: approved.node.nodeId },
		);
		expect(renamed.displayName).toBe("renamed-node");

		await tauriInvoke("device_token_revoke", {
			nodeId: approved.node.nodeId,
		});
		const afterRevoke = await tauriInvoke<boolean>("device_authenticate", {
			nodeId: approved.node.nodeId,
			token: rotated,
		});
		expect(afterRevoke).toBe(false);
	});

	it("shows the device pairing section in Settings", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.settingsTabBtn);
		const section = await $('[data-testid="device-section"]');
		await section.waitForDisplayed({ timeout: 10_000 });
	});
});
