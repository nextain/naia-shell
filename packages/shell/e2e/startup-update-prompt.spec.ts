import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

const TAURI_UPDATE_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	window.__UPDATE_INVOKES__ = [];
	var callbacks = new Map();
	var nextCallbackId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCallbackId++;
		callbacks.set(id, function(data) {
			if (once) callbacks.delete(id);
			return fn && fn(data);
		});
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var callback = callbacks.get(id);
		if (callback) callback(data);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.invoke = async function(cmd) {
		window.__UPDATE_INVOKES__.push(cmd);
		if (cmd === "plugin:updater|check") {
			return {
				rid: 468,
				currentVersion: "0.2.0",
				version: localStorage.getItem("e2e-update-version") || "0.3.0",
				body: "Startup update prompt acceptance",
				rawJson: {},
			};
		}
		// #551(355d173d): installFn 은 download → prepare_app_relaunch → install →
		// relaunch 순서다(updater.ts installFn). Rust prepare_app_relaunch 는 () 를 돌려준다.
		if (cmd === "plugin:updater|download" || cmd === "plugin:updater|install") return null;
		if (cmd === "prepare_app_relaunch" || cmd === "cancel_app_relaunch") return null;
		if (cmd === "plugin:process|restart") return null;
		return undefined;
	};
})();
`;

const SEED_READY_APP = `
localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
localStorage.setItem("naia-config", JSON.stringify({
	onboardingComplete: true,
	provider: "ollama",
	model: "qwen3",
	locale: "ko"
}));
`;

// Anything that fetches or applies the update package. #551 split the old
// download_and_install into download + install; neither may run before consent.
const UPDATE_PAYLOAD_COMMAND =
	/^plugin:updater\|(download|install|download_and_install)$/;

async function openReadyApp(page: import("@playwright/test").Page) {
	await page.addInitScript({ content: TAURI_UPDATE_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_READY_APP });
	await page.goto("/");
	await expect(
		page.getByRole("dialog", { name: "새 버전으로 업데이트할까요?" }),
	).toBeVisible();
}

test("startup update requires consent and Later preserves the existing banner", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 420, height: 720 });
	await openReadyApp(page);
	await page.screenshot({
		path: testInfo.outputPath("startup-update-prompt.png"),
		fullPage: true,
	});

	await expect(page.getByText("현재 버전: 0.2.0")).toBeVisible();
	await expect(page.getByText("새 버전: 0.3.0")).toBeVisible();
	const dialogBox = await page.getByRole("dialog").boundingBox();
	expect(dialogBox).not.toBeNull();
	expect(dialogBox?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(420);
	expect(
		(await page.evaluate(() => window.__UPDATE_INVOKES__)).filter(
			(command) => command === "plugin:updater|check",
		),
	).toHaveLength(1);
	expect(await page.evaluate(() => window.__UPDATE_INVOKES__)).not.toEqual(
		expect.arrayContaining([expect.stringMatching(UPDATE_PAYLOAD_COMMAND)]),
	);

	await page.getByRole("button", { name: "나중에" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.locator(".update-banner")).toBeVisible();
	expect(await page.evaluate(() => window.__UPDATE_INVOKES__)).not.toEqual(
		expect.arrayContaining([expect.stringMatching(UPDATE_PAYLOAD_COMMAND)]),
	);
});

test("one-month deferral hides the same version but not a newer version", async ({
	page,
}) => {
	await openReadyApp(page);

	await page.getByRole("checkbox", { name: "한 달간 보지 않기" }).check();
	await page.getByRole("button", { name: "나중에" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.locator(".update-banner")).toBeHidden();

	await page.reload();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.locator(".update-banner")).toBeHidden();

	await page.evaluate(() =>
		localStorage.setItem("e2e-update-version", "0.3.1"),
	);
	await page.reload();
	await expect(
		page.getByRole("dialog", { name: "새 버전으로 업데이트할까요?" }),
	).toBeVisible();
	await expect(page.getByText("새 버전: 0.3.1")).toBeVisible();
});

test("explicit confirmation installs and relaunches", async ({ page }) => {
	await openReadyApp(page);

	await page.getByRole("button", { name: "지금 업데이트" }).click();
	// #551(355d173d): the package is downloaded while the Agent stays alive, the
	// relaunch guard is claimed, then install and relaunch run in that order.
	const ordered = [
		"plugin:updater|download",
		"prepare_app_relaunch",
		"plugin:updater|install",
		"plugin:process|restart",
	];
	await expect
		.poll(() =>
			page.evaluate(
				(wanted) =>
					window.__UPDATE_INVOKES__.filter((command) => wanted.includes(command)),
				ordered,
			),
		)
		.toEqual(ordered);
	const invokes = await page.evaluate(() => window.__UPDATE_INVOKES__);
	expect(invokes).not.toContain("cancel_app_relaunch");
});

declare global {
	interface Window {
		__UPDATE_INVOKES__: string[];
	}
}
