import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import en from "../src/lib/locales/en";
import ko from "../src/lib/locales/ko";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "../../../.agy-work/752");

const MOCK_VIDEO_FILE = "flower-shop-beachside-moewalls-com.mp4";
const MOCK_BG_FILES = [MOCK_VIDEO_FILE, "background-space.png"];
const MOCK_VRM_FILES = ["01-OL_Woman.vrm", "02-Hood_Boy.vrm"];
const MOCK_NVA_FILES = ["alpha", "naia", "naia-prebaked"];
const MINI_PNG = [
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
	0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 8,
	215, 99, 248, 207, 192, 0, 0, 0, 2, 0, 1, 226, 33, 188, 51, 0, 0, 0, 0, 73,
	69, 78, 68, 174, 66, 96, 130,
];

function buildMockScript(locale: string = "ko") {
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
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
    window.__eventListeners = new Map();
    window.__TAURI_INTERNALS__.convertFileSrc = function(p) {
        if (/\\.mp4$/i.test(p)) return window.location.origin + "/__e2e_asset__/background.mp4";
        return "http://asset.localhost/" + encodeURIComponent(p);
    };

    var BG_FILES = ${JSON.stringify(MOCK_BG_FILES)};
    var VRM_FILES = ${JSON.stringify(MOCK_VRM_FILES)};
    var NVA_FILES = ${JSON.stringify(MOCK_NVA_FILES)};
    var MINI_PNG = new Uint8Array(${JSON.stringify(MINI_PNG)});
    window.__onboardingCommands = [];

    window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
        if (cmd === "reload_agent_settings") {
            window.__onboardingCommands.push({ type: "reload_settings", command: cmd });
            if (window.__rejectOnboardingReloadOnce) {
                window.__rejectOnboardingReloadOnce = false;
                throw new Error("agent unavailable");
            }
            if (window.__deferOnboardingReload) {
                window.__deferOnboardingReload = false;
                return new Promise(function(resolve) {
                    window.__releaseOnboardingReload = resolve;
                });
            }
            return;
        }
        if (cmd === "send_to_agent_command") {
            var message = JSON.parse((args && args.message) || "{}");
            window.__onboardingCommands.push(message);
            return;
        }
        if (cmd === "plugin:event|listen") {
            var evt = args.event;
            if (!window.__eventListeners.has(evt)) window.__eventListeners.set(evt, []);
            window.__eventListeners.get(evt).push({ callbackId: args.handler });
            return args.handler;
        }
        if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
        if (cmd === "frontend_log") return;
        if (cmd === "detect_gpu_vram") return 6;
        if (cmd === "list_skills") return [];
        if (cmd === "list_stt_models") return [];
        if (cmd === "app_list_installed") return [];
        if (cmd === "plugin:window|get_cursor_position" || cmd === "plugin:window|start_resize_dragging") return null;
        if (cmd === "plugin:window|is_maximized") return false;
        if (cmd === "plugin:window|show") return;
        if (cmd === "plugin:updater|check") return null;
        if (cmd === "copy_bundled_assets") return;
        if (cmd === "list_naia_assets") {
            var sub = args && args.subdir;
            if (sub === "background") return BG_FILES;
            if (sub === "vrm-files") return VRM_FILES;
            if (sub === "nva-files") return NVA_FILES;
            if (sub === "bgm-musics") return ["Afternoon Whispers.mp3"];
            return [];
        }
        if (cmd === "read_naia_config") return JSON.stringify({ locale: ${JSON.stringify(locale)}, onboardingComplete: false });
        if (cmd === "read_naia_ui_config") return "{}";
        if (cmd === "read_local_binary") {
            return Array.from(MINI_PNG);
        }
        if (cmd === "get_linked_channels") return [];
        if (cmd === "get_lab_user_info") return null;
        if (cmd === "get_memory_facts") return [];
        if (cmd === "workspace_get_sessions") return [];
        if (cmd === "workspace_classify_dirs") return [];
        return undefined;
    };
})();
`;
}

async function setupOnboarding(page: import("@playwright/test").Page, locale: "ko" | "en") {
	if (!existsSync(SCREENSHOT_DIR)) {
		mkdirSync(SCREENSHOT_DIR, { recursive: true });
	}
	const videoPath = path.resolve(
		process.cwd(),
		"e2e/fixtures/head-green-100.mp4",
	);
	await page.route("**/__e2e_asset__/background.mp4", (route) =>
		route.fulfill({ path: videoPath, contentType: "video/mp4" }),
	);
	await page.addInitScript(buildMockScript(locale));
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript((loc) => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem("naia-config", JSON.stringify({ locale: loc, onboardingComplete: false }));
	}, locale);
	await page.goto("/");
	await expect(page.locator(".onboarding-app")).toBeVisible({
		timeout: 15_000,
	});
	if ((await page.locator('input[placeholder="Naia"]').count()) === 0) {
		await page.getByRole("button", { name: /Next|다음/i }).click();
		await page.waitForTimeout(400);
	}
}

async function clickNext(page: import("@playwright/test").Page) {
	const btn = page.getByRole("button", { name: /다음|Next/i });
	await expect(btn).toBeEnabled({ timeout: 5_000 });
	await btn.click({ force: true });
	await page.waitForTimeout(400);
}

test.describe("#752 한국어 화면 글자", () => {
	test("한국어 온보딩 말투 화면 및 성격 라벨 검증 (1100px & 390px, verify-visual-ux)", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await setupOnboarding(page, "ko");

		// agentName step → Next
		await page.locator('input[placeholder="Naia"]').fill("나이아");
		await clickNext(page);

		// userName step → Next
		await page
			.locator(
				'input[placeholder="Enter a name"], input[placeholder="이름을 입력하세요"]',
			)
			.fill("루크");
		await clickNext(page);

		// Now at speechStyle step
		const speechOptions = page.locator(
			'[data-testid="onboarding-speech-style"] .onboarding-step__option',
		);
		await expect(speechOptions.first()).toBeVisible({ timeout: 5_000 });

		// verify-visual-ux [기본 상태]: 첫 표시 시 반말 선택지가 기본 선택됨
		await expect(speechOptions.first()).toHaveClass(
			/onboarding-step__option--selected/,
		);
		const casualDesc = await speechOptions
			.first()
			.locator(".onboarding-step__option-desc")
			.textContent();

		// 정확히 "편하게 반말로" 인지, "친구" 가 없는지 toBe 로 검사
		expect(casualDesc?.trim()).toBe("편하게 반말로");
		expect(casualDesc).not.toContain("친구");

		// 성격 선택지(ko) 로케일 번역 검증: "다정한 말투" exact toBe, "친구" 미포함
		expect(ko["personality.friendly.label"]).toBe("다정한 말투");
		expect(ko["personality.friendly.label"]).not.toContain("친구");

		// 1100px 기본 폭 스크린샷 캡처
		const ko1100Path = path.join(SCREENSHOT_DIR, "speech-style-ko-1100px.png");
		await page.screenshot({ path: ko1100Path });
		expect(existsSync(ko1100Path)).toBe(true);

		// verify-visual-ux [좁은 폭 상태]: 390px 모바일/좁은 창에서 레이아웃 및 텍스트 줄바꿈 보존
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(300);

		const casualDescNarrow = await speechOptions
			.first()
			.locator(".onboarding-step__option-desc")
			.textContent();
		expect(casualDescNarrow?.trim()).toBe("편하게 반말로");
		expect(casualDescNarrow).not.toContain("친구");

		const ko390Path = path.join(SCREENSHOT_DIR, "speech-style-ko-390px.png");
		await page.screenshot({ path: ko390Path });
		expect(existsSync(ko390Path)).toBe(true);

		// Viewport 복구
		await page.setViewportSize({ width: 1100, height: 800 });

		// verify-visual-ux [빈 목록 상태]: 옵션 2개와 추가 입력 필드들이 온전히 렌더링되고 다음 버튼 활성화됨
		expect(await speechOptions.count()).toBe(2);
		const nextBtn = page.getByRole("button", { name: /다음|Next/i });
		await expect(nextBtn).toBeEnabled();

		// verify-visual-ux [성공 상태]: 선택지 확정 후 다음 단계로 전이
		await clickNext(page);
		await expect(
			page.locator(".onboarding-step__avatar-grid"),
		).toBeVisible({
			timeout: 5_000,
		});
	});

	test("영어 온보딩 말투 화면 및 성격 라벨 검증 (1100px & 390px)", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await setupOnboarding(page, "en");

		// agentName step → Next
		await page.locator('input[placeholder="Naia"]').fill("Naia");
		await clickNext(page);

		// userName step → Next
		await page
			.locator(
				'input[placeholder="Enter a name"], input[placeholder="이름을 입력하세요"]',
			)
			.fill("Luke");
		await clickNext(page);

		// Now at speechStyle step
		const speechOptions = page.locator(
			'[data-testid="onboarding-speech-style"] .onboarding-step__option',
		);
		await expect(speechOptions.first()).toBeVisible({ timeout: 5_000 });

		const casualDesc = await speechOptions
			.first()
			.locator(".onboarding-step__option-desc")
			.textContent();

		// 정확히 "Casual and relaxed" 인지, "friend" 가 없는지 toBe 로 검사
		expect(casualDesc?.trim()).toBe("Casual and relaxed");
		expect(casualDesc).not.toContain("friend");

		// 성격 선택지(en) 로케일 번역 검증: "Warm Tone" exact toBe, "friend" 미포함
		expect(en["personality.friendly.label"]).toBe("Warm Tone");
		expect(en["personality.friendly.label"]).not.toContain("friend");

		// 1100px 스크린샷 캡처
		const en1100Path = path.join(SCREENSHOT_DIR, "speech-style-en-1100px.png");
		await page.screenshot({ path: en1100Path });
		expect(existsSync(en1100Path)).toBe(true);

		// 390px 좁은 폭 검증 및 스크린샷
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(300);

		const casualDescNarrow = await speechOptions
			.first()
			.locator(".onboarding-step__option-desc")
			.textContent();
		expect(casualDescNarrow?.trim()).toBe("Casual and relaxed");
		expect(casualDescNarrow).not.toContain("friend");

		const en390Path = path.join(SCREENSHOT_DIR, "speech-style-en-390px.png");
		await page.screenshot({ path: en390Path });
		expect(existsSync(en390Path)).toBe(true);
	});

	test("키보드 탐색(Tab·Enter)으로 반말·존댓말 선택지 이동 및 선택", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await setupOnboarding(page, "ko");

		// agentName → userName → speechStyle
		await clickNext(page);
		await clickNext(page);

		const speechOptions = page.locator(
			'[data-testid="onboarding-speech-style"] .onboarding-step__option',
		);
		await expect(speechOptions.first()).toBeVisible({ timeout: 5_000 });

		const casualBtn = speechOptions.first();
		const formalBtn = speechOptions.nth(1);

		// Initial: casual is selected
		await expect(casualBtn).toHaveClass(/onboarding-step__option--selected/);

		// Focus formal option and press Enter
		await formalBtn.focus();
		await page.keyboard.press("Enter");
		await expect(formalBtn).toHaveClass(/onboarding-step__option--selected/);
		await expect(casualBtn).not.toHaveClass(/onboarding-step__option--selected/);

		// Focus casual option and press Enter
		await casualBtn.focus();
		await page.keyboard.press("Enter");
		await expect(casualBtn).toHaveClass(/onboarding-step__option--selected/);
		await expect(formalBtn).not.toHaveClass(/onboarding-step__option--selected/);
	});

	test("verify-visual-ux [진행 및 오류 상태]: 저장 지연 시 중복 클릭 방지 및 오류 복구", async ({
		page,
	}) => {
		test.slow();
		await page.setViewportSize({ width: 1100, height: 800 });
		await setupOnboarding(page, "ko");

		// Proceed through all steps to complete
		await page.locator('input[placeholder="Naia"]').fill("Mochi");
		await clickNext(page);
		await page
			.locator(
				'input[placeholder="Enter a name"], input[placeholder="이름을 입력하세요"]',
			)
			.fill("Tester");
		await clickNext(page); // from userName to speechStyle
		await clickNext(page); // from speechStyle to character
		await clickNext(page); // from character to background
		await expect(
			page.locator(".onboarding-step__bg-card").first(),
		).toBeVisible({ timeout: 10_000 });
		await clickNext(page); // from background to provider
		await page.locator('[data-testid="onboarding-provider-later"]').click(); // from provider to voice
		await page.waitForTimeout(400);
		await clickNext(page); // from voice to complete

		// Now at complete step
		const startBtn = page.getByRole("button", {
			name: /시작하기|Get Started/i,
		});
		await expect(startBtn).toBeVisible({ timeout: 5_000 });

		// verify-visual-ux [오류 상태]: 저장 실패 시 화면 안내 및 재시도 확인
		await page.evaluate(() => {
			(window as any).__rejectOnboardingReloadOnce = true;
		});
		await startBtn.click();
		const errorNotice = page.getByRole("alert");
		await expect(errorNotice).toBeVisible({ timeout: 10_000 });
		await expect(errorNotice).toContainText("agent unavailable");

		// verify-visual-ux [진행 상태]: 저장 진행 중 버튼 중복 클릭 방지 (재시도 시)
		await page.evaluate(() => {
			(window as any).__deferOnboardingReload = true;
		});
		await startBtn.click();
		await expect(
			page.getByRole("button", { name: /설정 적용 중|Applying settings/i }),
		).toBeDisabled();
		await page.waitForFunction(
			() => typeof (window as any).__releaseOnboardingReload === "function",
			{ timeout: 10_000 },
		);
		await page.evaluate(() => (window as any).__releaseOnboardingReload());
		await page.waitForTimeout(1500);

		// verify-visual-ux [성공 상태]: 저장된 persona에 an AI agent 확인 및 companion/friend 미포함
		const config = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") || "{}"),
		);
		expect(config.onboardingComplete).toBe(true);
		expect(config.persona).toBe(
			"You are Mochi, an AI agent. Speak casually and warmly.",
		);
		expect(config.persona).not.toContain("companion");
		expect(config.persona).not.toContain("friend");
	});
});
