import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — 설정 지식 탭 관리 UI (K4, FR-KB-OS.5~8 / UC-KB-MANAGE).
 *
 * "준비 중" placeholder 를 대체한 실 관리면을 실 UI 로 검증:
 *   - 스코프 표시 + 소스 폴더 add/remove(폴더 다이얼로그)
 *   - 컴파일 트리거(compile_knowledge) + 상태(kb.json 통계) 재조회
 *
 * 설정 정본 = naia-settings/knowledge.json(셸 전용 write). 다이얼로그/컴파일/통계 = IPC 모킹.
 * Prerequisites: Vite dev server @ localhost:1420.
 */

function buildMockScript() {
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
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, protocol) {
		protocol = protocol || "asset";
		return protocol + "://localhost/" + encodeURIComponent(p);
	};

	window.__KNOWLEDGE_E2E__ = { writtenConfig: null, compileCalls: 0, nextFolder: "/docs/gov" };

	function kbEnvelope() {
		return JSON.stringify({
			version: 1,
			kb: {
				cards: [{ id: "c1", status: "accepted" }, { id: "c2", status: "draft" }],
				entities: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
				relations: [{ from: "e1", type: "x", to: "e2" }],
			},
		});
	}

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") return null;
		if (cmd === "plugin:event|unlisten") return;

		// 폴더 선택 다이얼로그(@tauri-apps/plugin-dialog open) → 선택 경로 반환.
		if (cmd === "plugin:dialog|open") return window.__KNOWLEDGE_E2E__.nextFolder;

		// 지식 설정(셸 전용) 영속 — 상태 보존(write→read 일관).
		if (cmd === "read_naia_knowledge_config") {
			var w = window.__KNOWLEDGE_E2E__.writtenConfig;
			return w ? JSON.stringify(w) : "";
		}
		if (cmd === "write_naia_knowledge_config") {
			try { window.__KNOWLEDGE_E2E__.writtenConfig = JSON.parse(args.json); } catch (e) {}
			return;
		}
		// 컴파일 산출 통계 — 컴파일 전엔 미컴파일(""), 후엔 envelope.
		if (cmd === "read_naia_knowledge_kb") {
			return window.__KNOWLEDGE_E2E__.compileCalls > 0 ? kbEnvelope() : "";
		}
		if (cmd === "compile_knowledge") {
			window.__KNOWLEDGE_E2E__.compileCalls++;
			return;
		}

		// 표준 stub.
		if (cmd === "list_skills") return [];
		if (cmd === "list_stt_models") return [];
		if (cmd === "list_audio_output_devices") return [];
		if (cmd === "fetch_linked_channels") return [];
		if (cmd === "gateway_health") return false;
		if (cmd === "get_audit_log") return [];
		if (cmd === "get_audit_stats") return { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 };
		if (cmd === "memory_get_all_facts") return [];
		if (cmd && cmd.startsWith("plugin:store|")) return null;

		return undefined;
	};
})();
`;
}

async function gotoKnowledge(page: import("@playwright/test").Page) {
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();
	// 지식 탭 — data 속성으로 정확 매칭(텍스트 "지식" 오매칭 회피).
	await page.locator('[data-settings-tab="knowledge"]').click();
	await expect(page.getByTestId("knowledge-settings")).toBeVisible({
		timeout: 8_000,
	});
}

test.describe("설정 지식 탭 관리 (K4)", () => {
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
				apiKey: "e2e-mock-key",
				enableTools: true,
				locale: "ko",
				userName: "Luke",
				agentName: "Naia",
				onboardingComplete: true,
				discordSessionMigrated: true,
			}),
		);
	});

	test("관리 UI 렌더 — 준비중 대체, 스코프 default·소스 없음", async ({
		page,
	}) => {
		await gotoKnowledge(page);
		await expect(page.getByTestId("knowledge-scope")).toHaveText("default");
		// "준비 중" 문구가 사라졌다(placeholder 대체 검증).
		await expect(page.getByText("준비 중 (Coming soon)")).not.toBeVisible();
		// 컴파일 버튼은 소스 0 이라 비활성.
		await expect(page.getByTestId("knowledge-compile")).toBeDisabled();
	});

	test("폴더 추가 → 목록 표시 + write_naia_knowledge_config 영속", async ({
		page,
	}) => {
		await gotoKnowledge(page);
		await page.getByTestId("knowledge-add-folder").click();

		await expect(
			page.locator(
				'[data-testid="knowledge-source-list"] [data-path="/docs/gov"]',
			),
		).toBeVisible({ timeout: 5_000 });

		const written = await page.evaluate(
			() => (window as unknown as { __KNOWLEDGE_E2E__: { writtenConfig: unknown } })
				.__KNOWLEDGE_E2E__.writtenConfig,
		);
		expect(JSON.stringify(written)).toContain("/docs/gov");
		await expect(page.getByTestId("knowledge-compile")).toBeEnabled();
	});

	test("폴더 추가 → 컴파일 → compile_knowledge 호출 + 상태(통계) 갱신", async ({
		page,
	}) => {
		test.setTimeout(120_000); // 무거운 테스트(컴파일+오버레이+캔버스 애니메이션) — 60s 디폴트 근접 플래키 방지
		await gotoKnowledge(page);
		await page.getByTestId("knowledge-add-folder").click();
		await expect(
			page.locator(
				'[data-testid="knowledge-source-list"] [data-path="/docs/gov"]',
			),
		).toBeVisible({ timeout: 5_000 });

		// 컴파일 전 = 미컴파일.
		await expect(page.getByTestId("knowledge-status")).toHaveText(
			/미컴파일|컴파일되지/,
		);

		await page.getByTestId("knowledge-compile").click();

		await page.waitForFunction(
			() =>
				(window as unknown as { __KNOWLEDGE_E2E__: { compileCalls: number } })
					.__KNOWLEDGE_E2E__.compileCalls > 0,
			{},
			{ timeout: 5_000 },
		);
		// 컴파일 후 = 통계(카드 2 · 엔티티 3 · 관계 1 · 수락 1) 표시.
		await expect(page.getByTestId("knowledge-status")).toContainText("카드 2");
		await expect(page.getByTestId("knowledge-status")).toContainText(
			"엔티티 3",
		);

		// 컴파일 후 = '그래프 보기' 버튼(평소엔 오버레이 미렌더 = 부하 0).
		await expect(page.getByTestId("knowledge-graph-open")).toBeVisible();
		await expect(page.getByTestId("knowledge-graph-overlay")).toHaveCount(0);
		// 버튼 → 작업영역 채우는 오버레이로 그래프 열림.
		await page.getByTestId("knowledge-graph-open").click();
		await expect(page.getByTestId("knowledge-graph-overlay")).toBeVisible();
		await expect(page.locator(".knowledge-graph-canvas")).toBeVisible();
		// 2D↔3D 토글.
		await page.locator(".knowledge-graph-mode").click();
		await expect(page.getByTestId("knowledge-graph")).toHaveAttribute(
			"data-mode",
			"3d",
		);
		// 닫기 → 오버레이 복귀(unmount).
		await page.getByTestId("knowledge-graph-close").click();
		await expect(page.getByTestId("knowledge-graph-overlay")).toHaveCount(0);
	});
});
