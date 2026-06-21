import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — Memory settings UI verification.
 *
 * Tests that the memory settings section in SettingsTab correctly renders
 * adapter options, embedding provider options, backup UI, and persists config.
 *
 * Prerequisites:
 *   Vite dev server running at localhost:1420
 */

const API_KEY = "e2e-mock-key";

/** Base IPC mock, reused and extended per test. */
function buildMockScript(overrides = "") {
	return `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	var callbacks = new Map();
	var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;

	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	window.__TAURI_INTERNALS__.convertFileSrc = function(filePath, protocol) {
		protocol = protocol || "asset";
		return protocol + "://localhost/" + encodeURIComponent(filePath);
	};

	window.__MEMORY_SETTINGS_E2E__ = {
		exportCalls: 0,
		importCalls: 0,
		factsRequested: 0,
		deletedFacts: 0,
		lastExportPassword: null,
		lastDeletedFactId: null,
		writtenConfig: null,
	};

	var MOCK_FACTS = [
		{
			id: "f1",
			content: "User prefers TypeScript",
			entities: ["TypeScript"],
			topics: ["preference"],
			createdAt: 1000,
			updatedAt: 1000,
			importance: 0.8,
			recallCount: 2,
			lastAccessed: 2000,
			strength: 0.7,
			sourceEpisodes: [],
		},
		{
			id: "f2",
			content: "User's name is Luke",
			entities: ["Luke"],
			topics: ["identity"],
			createdAt: 1000,
			updatedAt: 1000,
			importance: 0.9,
			recallCount: 5,
			lastAccessed: 3000,
			strength: 0.9,
			sourceEpisodes: [],
		},
	];

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") return null;
		if (cmd === "plugin:event|unlisten") return;

		if (cmd === "memory_get_all_facts") {
			window.__MEMORY_SETTINGS_E2E__.factsRequested++;
			return MOCK_FACTS;
		}
		if (cmd === "memory_delete_fact") {
			window.__MEMORY_SETTINGS_E2E__.deletedFacts++;
			window.__MEMORY_SETTINGS_E2E__.lastDeletedFactId = args.factId;
			return true;
		}
		if (cmd === "memory_export_backup") {
			window.__MEMORY_SETTINGS_E2E__.exportCalls++;
			window.__MEMORY_SETTINGS_E2E__.lastExportPassword = args.password;
			return Array.from(new Uint8Array(10));
		}
		if (cmd === "memory_import_backup") {
			window.__MEMORY_SETTINGS_E2E__.importCalls++;
			return;
		}

		// 실 영속 경로: handleSave → writeNaiaConfig → write_naia_config(stripForAgent 적용 JSON).
		// agent 가 읽는 config.json 싱크. 비밀키(*ApiKey)만 strip, 비밀 아닌 메모리 필드는 그대로 실린다.
		if (cmd === "write_naia_config") {
			try { window.__MEMORY_SETTINGS_E2E__.writtenConfig = JSON.parse(args.json); } catch (e) {}
			return;
		}
		// ⚠️ sync_gateway_config 는 2026-06-12 제거된 죽은 IPC(Rust 미구현 phantom). 호출되지 않아야 정상 —
		// 무해 stub 만 두고, 실 계약 검증은 write_naia_config 로 한다.
		if (cmd === "sync_gateway_config") return;

		// Standard stubs
		if (cmd === "sync_openclaw_config") return;
		if (cmd === "restart_gateway") return;
		if (cmd === "send_to_agent_command") return;
		if (cmd === "cancel_stream") return;
		if (cmd === "get_audit_log") return [];
		if (cmd === "get_audit_stats") return { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 };
		if (cmd === "list_skills") return [];
		if (cmd === "list_stt_models") return [];
		if (cmd === "list_audio_output_devices") return [];
		if (cmd === "fetch_linked_channels") return [];
		if (cmd === "gateway_health") return false;
		if (cmd === "read_openclaw_memory_files") return [];
		if (cmd && cmd.startsWith("plugin:store|")) return null;

		${overrides}

		return undefined;
	};
})();
`;
}

/** Navigate to SettingsTab → Memory sub-tab, wait for memory content. */
async function gotoSettings(page: import("@playwright/test").Page) {
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });

	// 설정 버튼(로케일 ko="설정" / en="Settings"). ⚠️ /설정/i 부분매칭은 "재설정 (앱 재시작)"(RefAudioSection)
	// 도 매칭하므로 ^앵커 정확매칭으로 그 오매칭을 회피한다.
	await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();

	// SettingsTab 내 Memory 서브탭 — 저장소(adapter)/facts/backup. embedding·small-LLM 은 "모델" 탭으로 이전됨.
	await page.locator(".settings-tab-btn", { hasText: /기억|Memory/i }).click();

	// 메모리 콘텐츠(활성화된 adapter 라디오)가 보이면 도착.
	await expect(
		page.locator('input[name="memory-adapter"][value="local"]'),
	).toBeVisible({ timeout: 8_000 });
}

/** Navigate to SettingsTab → "모델"(Models) 탭. embedding/small-LLM 은 전면 재구성으로 이 탭에서 렌더된다.
 *  ⚠️ AI 탭 라벨이 "AI 모델"이라 /모델/ 부분매칭은 2개 → ^앵커 정확매칭. */
async function gotoModels(page: import("@playwright/test").Page) {
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();
	await page.getByRole("button", { name: /^(모델|Models)$/ }).click();
	await expect(
		page.locator('input[name="memory-embedding"][value="none"]'),
	).toBeVisible({ timeout: 8_000 });
}

test.describe("Memory Settings UI", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(buildMockScript());
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		await page.addInitScript(
			(configJson: string) => {
				localStorage.setItem("naia-config", configJson);
			},
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: API_KEY,
				enableTools: true,
				locale: "ko",
				userName: "Luke",
				agentName: "Naia",
				onboardingComplete: true,
				discordSessionMigrated: true,
			}),
		);
	});

	test("memory tab renders adapter options (storage)", async ({ page }) => {
		await gotoSettings(page);

		// Adapter radio buttons — 저장소(local/qdrant)는 메모리 탭에 남는다(embedding 은 모델 탭으로 이전).
		await expect(
			page.locator('input[name="memory-adapter"][value="local"]'),
		).toBeVisible();
		await expect(
			page.locator('input[name="memory-adapter"][value="qdrant"]'),
		).toBeVisible();
	});

	test("모델 탭 renders embedding options (none/offline/vllm/ollama/naia)", async ({
		page,
	}) => {
		await gotoModels(page);
		for (const v of ["none", "offline", "vllm", "ollama", "naia"]) {
			await expect(
				page.locator(`input[name="memory-embedding"][value="${v}"]`),
			).toBeVisible();
		}
	});

	test("Qdrant adapter shows URL and API key fields when selected", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Qdrant fields should be hidden initially (default = local)
		await expect(page.locator('input[placeholder*="6333"]')).not.toBeVisible();

		// Select Qdrant adapter
		await page.locator('input[name="memory-adapter"][value="qdrant"]').click();

		// Qdrant URL and API key fields should appear
		await expect(page.locator('input[placeholder*="6333"]')).toBeVisible();
		await expect(
			page.locator('input[type="password"][placeholder*="..."]').last(),
		).toBeVisible();
	});

	test("offline embedding shows model selection when selected", async ({
		page,
	}) => {
		await gotoModels(page);

		// Select offline embedding
		await page
			.locator('input[name="memory-embedding"][value="offline"]')
			.click();

		// Model selection radio buttons should appear
		await expect(
			page.locator(
				'input[name="memory-offline-model"][value="all-MiniLM-L6-v2"]',
			),
		).toBeVisible();
		await expect(
			page.locator(
				'input[name="memory-offline-model"][value="all-mpnet-base-v2"]',
			),
		).toBeVisible();
	});

	test("offline embedding shows compute device(cpu/gpu/auto) + saves to config", async ({
		page,
	}) => {
		await gotoModels(page);
		await page
			.locator('input[name="memory-embedding"][value="offline"]')
			.click();

		// naia-embedded 컴퓨트 device 라디오(offline 전용)가 나타난다.
		for (const d of ["cpu", "gpu", "auto"]) {
			await expect(
				page.locator(`input[name="memory-embedding-device"][value="${d}"]`),
			).toBeVisible();
		}

		// gpu 선택 → 저장 → config.json(write_naia_config)에 memoryEmbeddingDevice=gpu 실린다.
		await page
			.locator('input[name="memory-embedding-device"][value="gpu"]')
			.click();
		await page.locator(".settings-save-btn").first().click();
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig !== null,
			{},
			{ timeout: 5_000 },
		);
		const written = await page.evaluate(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig,
		);
		expect(written?.memoryEmbeddingProvider).toBe("offline");
		expect(written?.memoryEmbeddingDevice).toBe("gpu");
	});

	test("vllm/ollama embedding shows base URL, key, and model fields", async ({
		page,
	}) => {
		// openai-compat radio was replaced with separate vllm + ollama radios that
		// share the same field layout (base URL / API key / model).
		await gotoModels(page);

		await page
			.locator('input[name="memory-embedding"][value="vllm"]')
			.click();

		await expect(
			page.locator('input[placeholder*="localhost:11434"]'),
		).toBeVisible();
		await expect(
			page.locator('input[placeholder*="text-embedding-ada-002"]'),
		).toBeVisible();
		await expect(
			page.locator('input[type="password"][placeholder="sk-..."]').last(),
		).toBeVisible();
	});

	test("naia embedding shows Naia account required hint when not logged in", async ({
		page,
	}) => {
		await gotoModels(page);

		await page.locator('input[name="memory-embedding"][value="naia"]').click();

		// No naiaKey in config, so should show "required" hint
		await expect(
			page.getByText(/Naia account required|Naia 계정 필요/i),
		).toBeVisible();
	});

	test("backup section shows password field and export/import buttons", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Backup password input
		await expect(
			page
				.locator(
					'input[type="password"][placeholder*="password"], input[type="password"][placeholder*="비밀번호"]',
				)
				.first(),
		).toBeVisible();

		// Export button
		await expect(
			page.getByRole("button", { name: /export|내보내기/i }),
		).toBeVisible();

		// Import button
		await expect(
			page.getByRole("button", { name: /import|가져오기/i }),
		).toBeVisible();
	});

	test("facts list loads and displays memory stats", async ({ page }) => {
		await gotoSettings(page);

		// Wait for facts to load (mocked as 2 items)
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.factsRequested > 0,
			{},
			{ timeout: 10_000 },
		);

		// Memory stats should show fact count
		await expect(page.getByText(/2.*fact|사실 2/i)).toBeVisible({
			timeout: 5_000,
		});

		// Fact contents should be visible in the list
		await expect(page.getByText("User prefers TypeScript")).toBeVisible();
	});

	test("delete fact invokes memory_delete_fact IPC and removes from list", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Wait for facts to load
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.factsRequested > 0,
			{},
			{ timeout: 10_000 },
		);

		// Click first delete button
		await page.locator(".fact-delete-btn").first().click();

		// IPC should have been called
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.deletedFacts > 0,
			{},
			{ timeout: 5_000 },
		);
		const deleteResult = await page.evaluate(() => ({
			deletedFacts: (window as any).__MEMORY_SETTINGS_E2E__?.deletedFacts,
			lastDeletedFactId: (window as any).__MEMORY_SETTINGS_E2E__
				?.lastDeletedFactId,
		}));
		expect(deleteResult.deletedFacts).toBe(1);
		// First fact is "f1" (User prefers TypeScript)
		expect(deleteResult.lastDeletedFactId).toBe("f1");

		// Fact should be removed from the list
		await expect(page.getByText("User prefers TypeScript")).not.toBeVisible();
	});

	test("export backup invokes memory_export_backup IPC", async ({ page }) => {
		await gotoSettings(page);

		// Find backup password input and fill it
		const pwInput = page
			.locator(
				'input[type="password"][placeholder*="password"], input[type="password"][placeholder*="비밀번호"]',
			)
			.last();
		await pwInput.fill("test-password");

		// Click Export
		await page.getByRole("button", { name: /export|내보내기/i }).click();

		// Verify IPC was called
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.exportCalls > 0,
			{},
			{ timeout: 5_000 },
		);
		const result = await page.evaluate(() => ({
			exportCalls: (window as any).__MEMORY_SETTINGS_E2E__?.exportCalls,
			lastExportPassword: (window as any).__MEMORY_SETTINGS_E2E__
				?.lastExportPassword,
		}));
		expect(result.exportCalls).toBe(1);
		expect(result.lastExportPassword).toBe("test-password");
	});

	test("save persists memory fields to config.json (write_naia_config)", async ({
		page,
	}) => {
		await gotoSettings(page);

		// 저장소(adapter)는 메모리 탭. Qdrant 선택.
		await page.locator('input[name="memory-adapter"][value="qdrant"]').click();
		await page
			.locator('input[placeholder*="6333"]')
			.fill("http://localhost:6333");

		// embedding 은 모델 탭으로 이전 — 공유 state 이므로 모델 탭에서 vllm 설정 후 저장하면 adapter 와 함께 영속.
		await page.getByRole("button", { name: /^(모델|Models)$/ }).click();
		await page
			.locator('input[name="memory-embedding"][value="vllm"]')
			.click();
		await page
			.locator('input[placeholder*="localhost:11434"]')
			.fill("http://localhost:11434");
		await page
			.locator('input[placeholder*="text-embedding-ada-002"]')
			.fill("nomic-embed-text");

		// Save (모델 탭 save 버튼)
		await page.locator(".settings-save-btn").first().click();

		// 실 영속 경로 검증: write_naia_config(config.json — agent 가 읽는 싱크)에 메모리 필드가 실린다.
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig !== null,
			{},
			{ timeout: 5_000 },
		);

		const written = await page.evaluate(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig,
		);

		expect(written?.memoryAdapter).toBe("qdrant");
		expect(written?.qdrantUrl).toBe("http://localhost:6333");
		expect(written?.memoryEmbeddingProvider).toBe("vllm");
		expect(written?.memoryEmbeddingBaseUrl).toBe("http://localhost:11434");
		expect(written?.memoryEmbeddingModel).toBe("nomic-embed-text");
	});

	test("save persists local adapter and no embedding (defaults) to config.json", async ({
		page,
	}) => {
		await gotoSettings(page);

		// local is default, none is default — just save without changing memory settings
		// (use class selector to avoid strict-mode collisions with other "save" buttons)
		await page.locator(".settings-save-btn").first().click();

		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig !== null,
			{},
			{ timeout: 5_000 },
		);

		const written = await page.evaluate(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig,
		);

		// local adapter with no embedding should be persisted
		expect(written?.memoryAdapter).toBe("local");
		expect(written?.memoryEmbeddingProvider).toBe("none");
		// qdrant fields should be null/absent (stripForAgent + undefined 직렬화 생략)
		expect(written?.qdrantUrl == null).toBe(true);
	});

	test("save persists memory fields to localStorage", async ({ page }) => {
		await gotoSettings(page);

		// 저장소 Qdrant(메모리 탭) + URL
		await page.locator('input[name="memory-adapter"][value="qdrant"]').click();
		await page
			.locator('input[placeholder*="6333"]')
			.fill("http://localhost:6333");

		// embedding vllm(모델 탭, 공유 state) → 저장 시 adapter 와 함께 localStorage 영속
		await page.getByRole("button", { name: /^(모델|Models)$/ }).click();
		await page
			.locator('input[name="memory-embedding"][value="vllm"]')
			.click();
		await page
			.locator('input[placeholder*="localhost:11434"]')
			.fill("http://localhost:11434");

		// Save (모델 탭 save 버튼)
		await page.locator(".settings-save-btn").first().click();

		// Read back from localStorage
		const saved = await page.evaluate(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});

		expect(saved?.memoryAdapter).toBe("qdrant");
		expect(saved?.qdrantUrl).toBe("http://localhost:6333");
		expect(saved?.memoryEmbeddingProvider).toBe("vllm");
		expect(saved?.memoryEmbeddingBaseUrl).toBe("http://localhost:11434");
	});

	test("모델 탭 — main 요약/small/embedding 3 컴포넌트 + embedding device 저장", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
		await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();
		// "모델"(Models) 서브탭으로 이동. ⚠️ AI 탭 라벨이 "AI 모델"이라 /모델/ 부분매칭은 2개 → ^앵커 정확매칭.
		await page.getByRole("button", { name: /^(모델|Models)$/ }).click();

		// 3 컴포넌트의 small LLM / embedding 라디오 그룹이 보인다(main LLM 은 요약+이동 버튼).
		await expect(
			page.locator('input[name="memory-llm"][value="naia"]'),
		).toBeVisible({ timeout: 8_000 });
		await expect(
			page.locator('input[name="memory-embedding"][value="offline"]'),
		).toBeVisible();

		// embedding offline → device gpu → 저장 → config.json 반영(통합 탭에서도 동일 계약).
		await page
			.locator('input[name="memory-embedding"][value="offline"]')
			.click();
		await page
			.locator('input[name="memory-embedding-device"][value="gpu"]')
			.click();
		await page.locator(".settings-save-btn").first().click();
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig !== null,
			{},
			{ timeout: 5_000 },
		);
		const w = await page.evaluate(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.writtenConfig,
		);
		expect(w?.memoryEmbeddingProvider).toBe("offline");
		expect(w?.memoryEmbeddingDevice).toBe("gpu");
	});
});
