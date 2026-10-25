import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * #453 — GOLDEN JOURNEY: select → engine ready → default voice → synth wired.
 *
 * This is the "definition of done" for local voice. The silence regression
 * ("engine ready but no sound") was invisible to isolated tests because each
 * piece passed alone; only the whole seam exposed it. This locks the seam:
 *
 *  1. Selecting naia-local-voice on a healthy engine shows the section READY —
 *     NOT "install required" and NOT "engine off" (the states the user saw).
 *  2. The voice palette (/ref/voices) is NON-EMPTY — the preset picker's source.
 *     An empty palette is exactly what made "프리셋 고르기" a network error and
 *     left resolve_voice("default") with nothing to return → silence.
 *  3. No error banner surfaces on the healthy path.
 *
 * The runtime side (empty voice dir → no_reference_voice) is locked separately
 * in voxcpm2-tensorrt/tests/test_http_service.py; the install step now
 * self-generates the default voice so the palette is never empty in production.
 */

const API_KEY = "e2e-mock-key";

function buildMock(): string {
	return `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var callbacks = new Map(); var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once){ var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;
	var eventListeners = new Map();
	var secrets = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto){ return (proto||"asset") + "://localhost/" + encodeURIComponent(p); };
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") { if(!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		// Credentials live in the selected ADK's native store (secure_store_*,
		// 09bbe62b); the first-ADK migration copies the seeded naiaKey into it.
		if (cmd === "secure_store_get") return secrets.get(args.expectedStorePath + ":" + args.name) || null;
		if (cmd === "secure_store_set") { secrets.set(args.expectedStorePath + ":" + args.name, args.value); return null; }
		if (cmd === "secure_store_delete") { secrets.delete(args.expectedStorePath + ":" + args.name); return null; }
		// Legacy device store is empty: Store.entries() resolves to an array.
		if (cmd === "plugin:store|entries") return [];
		if (cmd === "detect_gpu_vram") return 8;
		// Engine is INSTALLED and RUNNING — the healthy path.
		if (cmd === "voxcpm2_status") return true;
		if (cmd === "voxcpm2_installation_status") return { phase: "ready", ready: true, canStart: true, summary: "ready", steps: [] };
		if (cmd === "install_voxcpm2_runtime") return null;
		if (cmd === "start_voxcpm2") return { port: 8910, local_access_token: "b".repeat(64) };
		if (cmd === "stop_voxcpm2") return null;
		if (cmd === "write_slots_manifest" || cmd === "write_naia_config") return null;
		return undefined;
	};
})();
`;
}

test("golden journey: local voice ready, default voice present, no error (#453)", async ({
	page,
}) => {
	// The webview talks to the local engine over loopback HTTP (not Tauri IPC).
	// Mock the runtime contract so the journey is deterministic and GPU-free.
	await page.route("**/health", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				ready: true,
				tts: true,
				avatar: false,
				tts_enabled: true,
				avatar_enabled: false,
				backend: "tensorrt_locdit",
				capabilities: ["tts"],
			}),
		}),
	);
	// The preset picker now browses the CLOUD catalog (engine-independent) —
	// stub the gateway endpoint so the journey stays deterministic and keyless.
	let presetHits = 0;
	await page.route("**/v1/ref-audio/presets", (route) => {
		presetHits++;
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				presets: [
					{
						id: "cc0-ko-female-01",
						name: "여성 음색 1",
						locale: "ko",
						gender: "female",
						duration_seconds: 8,
						sample_url:
							"https://stnaiapub83b29893.blob.core.windows.net/ref-audio/cc0/cc0-ko-female-01.wav",
						sample_format: "wav",
						source: "mozilla-common-voice",
						license: "cc0",
					},
				],
				total: 1,
			}),
		});
	});

	await page.addInitScript(buildMock());
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(
		(configJson: string) => localStorage.setItem("naia-config", configJson),
		JSON.stringify({
			provider: "nextain",
			model: "gemini-3.5-flash",
			naiaKey: API_KEY,
			enableTools: false,
			ttsEnabled: true,
			ttsProvider: "naia-local-voice",
			localGpuTier: "windows-voice-6g",
			locale: "ko",
			onboardingComplete: true,
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();
	await page.locator('[data-settings-tab="voice"]').click();

	const ttsSelect = page.getByTestId("gateway-tts-provider");
	await expect(ttsSelect).toBeVisible({ timeout: 15_000 });
	await ttsSelect.selectOption("naia-local-voice");

	// 1) READY — none of the failure/blocked states the user reported.
	await expect(page.getByTestId("voxcpm2-install-error")).toHaveCount(0);
	await expect(
		page.getByTestId("local-voice-installation-status"),
	).toHaveCount(0);
	await expect(page.getByTestId("ref-audio-engine-off")).toHaveCount(0);

	// 2) The preset picker (cloud catalog) opens with a non-empty voice list —
	// the "빈 프리셋" regression the user hit.
	await page
		.locator("details summary")
		.filter({ hasText: /프리셋|preset/i })
		.first()
		.click();
	await expect(page.locator(".ref-preset-item")).toHaveCount(1, {
		timeout: 15_000,
	});
	expect(presetHits).toBeGreaterThan(0);
	await expect(page.locator(".settings-error")).toHaveCount(0);
});
