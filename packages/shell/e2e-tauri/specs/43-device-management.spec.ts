import { clickElement } from "../helpers/click.js";
import { S } from "../helpers/selectors.js";
import {
	enableToolsForSpec,
	ensureAppReady,
	invokeTauriCommand,
	navigateToSettings,
	openSettingsSection,
	setNativeValue,
} from "../helpers/settings.js";

/**
 * 43 — Device operations through Settings + Tauri IPC (#570)
 *
 * Does not call skill_device. Pair, verify, approve, describe, rename,
 * rotate, and revoke go through the Settings device section and the
 * device_* commands. Rotate is proven by the previous token failing
 * device_token_verify.
 */
describe("43 — device management", () => {
	let adkPath = "";
	let nodeId = "";
	let firstToken = "";
	let rotatedToken = "";

	before(async () => {
		await ensureAppReady();
		await enableToolsForSpec([]);
		await navigateToSettings();
		await openSettingsSection("brain");
		const section = await $(S.deviceSection);
		await section.waitForDisplayed({ timeout: 15_000 });
		adkPath = (await browser.execute(() =>
			window.localStorage.getItem("naia-adk-path"),
		)) as string;
		if (!adkPath) throw new Error("naia-adk-path is missing");
	});

	it("requests a pair and shows a one-time code", async () => {
		await clickElement('[data-testid="device-pair-request"]');
		const codeEl = await $('[data-testid="device-one-time-code"]');
		await codeEl.waitForDisplayed({ timeout: 10_000 });
		const code = (await codeEl.getText()).trim();
		expect(code).toMatch(/^\d{6}$/);
		const listed = await invokeTauriCommand<{
			requests?: { requestId: string; nodeId: string; status: string }[];
		}>("device_pair_list", {
			adkPath,
		});
		const pending = listed.requests?.find((r) => r.status === "pending");
		expect(pending).toBeTruthy();
		nodeId = pending?.nodeId ?? "";
		await setNativeValue('[data-testid="device-verify-code"]', code);
		await clickElement('[data-testid="device-pair-verify"]');
		await clickElement('[data-testid="device-pair-approve"]');
		const tokenEl = await $('[data-testid="device-one-time-token"]');
		await tokenEl.waitForDisplayed({ timeout: 10_000 });
		firstToken = (await tokenEl.getText()).trim();
		expect(firstToken.startsWith("ndt_")).toBe(true);
		const card = await $(S.deviceNodeCard);
		await card.waitForDisplayed({ timeout: 10_000 });
	});

	it("describes the paired node", async () => {
		await clickElement('[data-testid="device-describe"]');
		const result = await $('[data-testid="device-describe-result"]');
		await result.waitForDisplayed({ timeout: 10_000 });
		expect(await result.getText()).toContain(nodeId);
	});

	it("renames the node", async () => {
		await setNativeValue('[data-testid="device-rename-input"]', "e2e-node");
		await clickElement('[data-testid="device-rename"]');
		await browser.waitUntil(
			async () => {
				const name = await $(".device-node-name").getText();
				return name.trim() === "e2e-node";
			},
			{ timeout: 10_000, timeoutMsg: "renamed name did not appear" },
		);
	});

	it("rotates the token so the previous token no longer verifies", async () => {
		const checkOldBefore = await invokeTauriCommand<{ valid?: boolean }>(
			"device_token_verify",
			{
				adkPath,
				nodeId,
				token: firstToken,
			},
		);
		expect(checkOldBefore.valid).toBe(true);
		await clickElement('[data-testid="device-rotate"]');
		const tokenEl = await $('[data-testid="device-one-time-token"]');
		await browser.waitUntil(
			async () => {
				rotatedToken = (await tokenEl.getText()).trim();
				return rotatedToken.startsWith("ndt_") && rotatedToken !== firstToken;
			},
			{ timeout: 10_000, timeoutMsg: "rotated token did not appear" },
		);
		const oldAfter = await invokeTauriCommand<{ valid?: boolean }>(
			"device_token_verify",
			{
				adkPath,
				nodeId,
				token: firstToken,
			},
		);
		const newAfter = await invokeTauriCommand<{ valid?: boolean }>(
			"device_token_verify",
			{
				adkPath,
				nodeId,
				token: rotatedToken,
			},
		);
		expect(oldAfter.valid).toBe(false);
		expect(newAfter.valid).toBe(true);
	});

	it("revokes the token so the rotated token no longer verifies", async () => {
		await clickElement('[data-testid="device-revoke"]');
		await clickElement('[data-testid="device-revoke-confirm"]');
		await browser.waitUntil(
			async () => {
				const check = await invokeTauriCommand<{ valid?: boolean }>(
					"device_token_verify",
					{
						adkPath,
						nodeId,
						token: rotatedToken,
					},
				);
				return check.valid === false;
			},
			{ timeout: 10_000, timeoutMsg: "revoked token still verified" },
		);
	});
});
