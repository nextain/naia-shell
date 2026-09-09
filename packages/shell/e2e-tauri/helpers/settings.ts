import { resolve } from "node:path";
import { S } from "./selectors.js";

/**
 * Retry-safe reload. ⚠️ browser.refresh()(WebDriver POST /refresh)는 헤드리스(cage/WebKitWebDriver)
 * 환경에서 page-load 완료 응답을 못 받아 "aborted due to timeout"으로 세션을 끊는 간헐 버그가 있다.
 * → JS `location.reload()`로 우회: 네비게이션만 트리거하고 즉시 반환, 준비는 appRoot 존재로 판정.
 * (Xvfb 에선 browser.refresh()가 안정적이었으나 cage/Wayland 헤드리스에선 불안정.)
 */
export async function safeRefresh(maxAttempts = 3): Promise<void> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			await browser
				.execute(() => {
					window.location.reload();
				})
				.catch(() => {});
			await browser.pause(800); // reload 네비게이션 시작 여유
			const appRoot = await $(S.appRoot);
			await appRoot.waitForExist({ timeout: 30_000 });
			return;
		} catch {
			if (attempt === maxAttempts - 1)
				throw new Error(
					`safeRefresh(location.reload) failed after ${maxAttempts} attempts`,
				);
			await browser.pause(2_000);
		}
	}
}

/**
 * Enable tools + pre-approve specific tools in localStorage config.
 * Only refreshes the page when config actually changed.
 */
export async function enableToolsForSpec(tools: string[]): Promise<void> {
	const needsRefresh = await browser.execute((toolNames: string[]) => {
		const raw = localStorage.getItem("naia-config");
		const config = raw ? JSON.parse(raw) : {};
		let changed = false;

		if (!config.enableTools) {
			config.enableTools = true;
			changed = true;
		}

		const disabled = Array.isArray(config.disabledSkills)
			? config.disabledSkills
			: [];
		const newDisabled = disabled.filter((s: string) => !toolNames.includes(s));
		if (newDisabled.length !== disabled.length) {
			config.disabledSkills = newDisabled;
			changed = true;
		}

		const allowed = config.allowedTools || [];
		for (const t of toolNames) {
			if (!allowed.includes(t)) {
				allowed.push(t);
				changed = true;
			}
		}
		config.allowedTools = allowed;
		localStorage.setItem("naia-config", JSON.stringify(config));

		return changed;
	}, tools);

	if (needsRefresh) {
		// Retry refresh — WebKitGTK may throw UND_ERR_HEADERS_TIMEOUT intermittently
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await browser.refresh();
				break;
			} catch {
				if (attempt === 2)
					throw new Error("browser.refresh() failed after 3 attempts");
				await browser.pause(2_000);
			}
		}
		// Wait for app to fully load after refresh
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	}
}

/**
 * Fill the settings tab and save, then switch to chat tab.
 * Assumes the settings tab is already visible.
 */
export async function configureSettings(opts: {
	provider: string;
	apiKey: string;
	gatewayUrl: string;
	gatewayToken: string;
}): Promise<void> {
	// 공급자와 키는 '두뇌' 구역에 있다 (#541). 설정을 열기만 하면 프로파일이
	// 먼저 나오므로 그 구역을 명시적으로 연다.
	await openSettingsSection("brain");
	// Provider
	const providerSelect = await $(S.providerSelect);
	await providerSelect.waitForDisplayed({ timeout: 10_000 });
	await browser.execute(
		(sel: string, val: string) => {
			const el = document.querySelector(sel) as HTMLSelectElement | null;
			if (!el) throw new Error(`Provider select ${sel} not found`);
			el.scrollIntoView({ block: "center" });
			const setter = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			)?.set;
			if (setter) setter.call(el, val);
			else el.value = val;
			el.dispatchEvent(new Event("change", { bubbles: true }));
		},
		S.providerSelect,
		opts.provider,
	);

	// API Key — use JS native setter (WebDriver setValue may not trigger React state in WebKitGTK)
	await browser.execute(
		(sel: string, val: string) => {
			const el = document.querySelector(sel) as HTMLInputElement | null;
			if (!el) throw new Error(`API key input ${sel} not found`);
			el.scrollIntoView({ block: "center" });
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			if (setter) setter.call(el, val);
			else el.value = val;
			el.dispatchEvent(new Event("input", { bubbles: true }));
		},
		S.apiKeyInput,
		opts.apiKey,
	);

	// Enable tools — use JS click (WebDriver click fails on off-screen checkboxes in WebKitGTK)
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLInputElement | null;
		if (el && !el.checked) {
			el.click();
		}
	}, S.toolsToggle);

	// Gateway URL — use JS to set value (may be off-screen in tab layout)
	await browser.execute(
		(sel: string, val: string) => {
			const el = document.querySelector(sel) as HTMLInputElement | null;
			if (!el) return;
			el.scrollIntoView({ block: "center" });
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			if (setter) setter.call(el, val);
			else el.value = val;
			el.dispatchEvent(new Event("input", { bubbles: true }));
		},
		S.gatewayUrlInput,
		opts.gatewayUrl,
	);

	// Gateway Token
	await browser.execute(
		(sel: string, val: string) => {
			const el = document.querySelector(sel) as HTMLInputElement | null;
			if (!el) return;
			el.scrollIntoView({ block: "center" });
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			if (setter) setter.call(el, val);
			else el.value = val;
			el.dispatchEvent(new Event("input", { bubbles: true }));
		},
		S.gatewayTokenInput,
		opts.gatewayToken,
	);

	// Save — use JS click
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (el) {
			el.scrollIntoView({ block: "center" });
			el.click();
		}
	}, S.settingsSaveBtn);

	// Switch to chat tab (JS click avoids WebKit "element click intercepted")
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (el) {
			el.scrollIntoView({ block: "center" });
			el.click();
		}
	}, S.chatTab);

	// Wait for chat input to become visible
	const chatInput = await $(S.chatInput);
	await chatInput.waitForDisplayed({ timeout: 10_000 });
}

/** 설정 내부 섹션 탭으로 이동한다 (#541: 설정은 내부 탭 구조). */
export async function openSettingsSection(id: string): Promise<void> {
	// 드라이버가 클릭을 거절하는 환경이 있어 clickElement 를 지난다.
	await clickElement(`[data-settings-tab="${id}"]`, 10_000);
	await browser.pause(300);
}

/** Navigate to Settings via the app-bar button and wait for render (#541). */
export async function navigateToSettings(): Promise<void> {
	// 앱바 설정 버튼은 토글이다 — 이미 열려 있으면 다시 누르지 않는다(닫혀 버림).
	// keepAlive 앱은 opacity:0 슬롯으로 숨겨서 offsetParent 로는 판별 불가 —
	// 슬롯의 active 클래스가 유일한 진실이다.
	const alreadyOpen = await browser.execute(() => {
		const panel = document.querySelector(".settings-tab") as HTMLElement | null;
		if (!panel) return false;
		const slot = panel.closest(".content-app__slot");
		if (slot) return slot.classList.contains("content-app__slot--active");
		return true; // keepAlive 슬롯 밖에서 렌더 = 실제로 열린 화면
	});
	if (alreadyOpen) return;
	// querySelector 클릭은 요소가 없으면 무음 no-op 라 실패를 숨긴다 —
	// 버튼 표시를 기다렸다가 실제 클릭으로 연다.
	await clickElement(S.settingsTabBtn, 15_000);
	await browser.pause(500);
}

/** Scroll a specific element into view. */
export async function scrollToSection(selector: string): Promise<void> {
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel);
		if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
	}, selector);
	await browser.pause(300);
}

/** Set an input/textarea value using React-compatible native setter. */
export async function setNativeValue(
	selector: string,
	value: string,
): Promise<void> {
	await browser.execute(
		(sel: string, val: string) => {
			const el = document.querySelector(sel) as
				| HTMLInputElement
				| HTMLTextAreaElement
				| null;
			if (!el) return;
			el.scrollIntoView({ block: "center" });
			const proto =
				el instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (setter) setter.call(el, val);
			else el.value = val;
			el.dispatchEvent(new Event("input", { bubbles: true }));
		},
		selector,
		value,
	);
}

/** Click an element by selector using browser.execute (reliable in WebKitGTK). */
export async function clickBySelector(selector: string): Promise<void> {
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (el) el.click();
	}, selector);
}

import { clickElement } from "./click.js";

export { clickElement };

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
const NAIA_KEY = process.env.NAIA_API_KEY || "";
// 기본값이 Windows 드라이브 경로로 박혀 있어 다른 기계에서는 설치 화면이
// 먼저 뜬다 (#541). 저장소 위치에서 형제 naia-adk 를 찾는다.
const ADK_FIXTURE =
	process.env.NAIA_E2E_ADK_FIXTURE ??
	resolve(import.meta.dirname, "..", "..", "..", "..", "naia-adk");

const normalizeAdkPath = (path: string): string =>
	path.replaceAll("\\", "/").replace(/\/+$/, "");

async function waitForAppReadySurface(): Promise<void> {
	// Wait for app + tabs to be ready
	// W1.옵션A — timeout 60s 로 늘렸으나 Bazzite + WebKitWebDriver 환경에서도
	// 일부 spec 통과 못함. 윈도우 환경에서 통과 가능성 높음 (사용자 명시 2026-05-29
	// "윈도우 위주로 테스트 하려고해"). 60s 그대로 둠 — windows wdio 환경에서
	// VRM 로딩 시간 충분 대비.
	const appRoot = await $(S.appRoot);
	await appRoot.waitForDisplayed({ timeout: 60_000 });
	await browser.waitUntil(
		async () =>
			browser.execute(
				(sel: string) => !document.querySelector(sel),
				S.onboardingOverlay,
			),
		{ timeout: 60_000 },
	);
	// jikime c0d967e9 baseline 의 ChatApp.tsx 는 chat-tabs 안에 button.chat-tab
	// 3개 (chat / history / channels). origin/main 의 #337 시리즈에서 8 tab 으로
	// 확장됐던 helper 가 cherry-pick 으로 baseline 위에 그대로 들어옴 = mismatch.
	// 3 tab 이 baseline 의 정확한 contract. (debug log 에서 무한 false 확인.)
	await browser.waitUntil(
		async () =>
			browser.execute(
				() => document.querySelectorAll(".chat-tabs .chat-tab").length >= 3,
			),
		{ timeout: 60_000 },
	);
}

/**
 * Ensure the app is ready: bypass onboarding, set base config, wait for tabs.
 * Safe to call multiple times — skips if already configured.
 */
export async function ensureAppReady(): Promise<void> {
	const explicitAdkPath = process.env.NAIA_E2E_ADK_PATH?.trim();
	if (explicitAdkPath) {
		// An explicit ADK is prepared by the caller. Its config.json is the source
		// of truth; do not write a legacy localStorage config or refresh over it.
		const expectedAdkPath = normalizeAdkPath(explicitAdkPath);
		await browser.waitUntil(
			async () => {
				const state = await browser.execute(() => {
					const selectedPath = localStorage.getItem("naia-adk-path") ?? "";
					const raw = localStorage.getItem("naia-config");
					if (!raw) return { selectedPath, ready: false };
					try {
						const config = JSON.parse(raw) as {
							onboardingComplete?: unknown;
							llmRoles?: {
								main?: {
									provider?: unknown;
									model?: unknown;
								};
							};
						};
						const main = config.llmRoles?.main;
						return {
							selectedPath,
							ready:
								config.onboardingComplete === true &&
								typeof main?.provider === "string" &&
								main.provider.length > 0 &&
								typeof main.model === "string" &&
								main.model.length > 0,
						};
					} catch {
						return { selectedPath, ready: false };
					}
				});
				const selectedPath = String(state.selectedPath ?? "");
				if (
					selectedPath &&
					normalizeAdkPath(selectedPath) !== expectedAdkPath
				) {
					throw new Error(
						`selected ADK path mismatch: expected ${explicitAdkPath}, got ${selectedPath}`,
					);
				}
				return (
					normalizeAdkPath(selectedPath) === expectedAdkPath &&
					state.ready === true
				);
			},
			{
				timeout: 60_000,
				timeoutMsg: `explicit ADK did not hydrate: ${explicitAdkPath} (selected path, onboarding, and main provider/model are required)`,
			},
		);
		await waitForAppReadySurface();
		return;
	}

	// Ensure ADK path is set so AdkSetupScreen does not gate the rest of the app.
	// Uses NAIA_E2E_ADK_FIXTURE (default projects/naia-adk) so we never hit a
	// fresh-install screen during specs that just need the chat surface.
	const adkPathConfigured = await browser.execute(
		() => !!localStorage.getItem("naia-adk-path"),
	);
	if (!adkPathConfigured) {
		await browser.execute((p: string) => {
			localStorage.setItem("naia-adk-path", p);
		}, ADK_FIXTURE);
	}

	// Providers like claude-code-cli, ollama, and nextain don't require an apiKey.
	// Consider configured if onboardingComplete is set — apiKey is optional depending on provider.
	const alreadyConfigured = await browser.execute(() => {
		const raw = localStorage.getItem("naia-config");
		if (!raw) return false;
		const config = JSON.parse(raw);
		const noKeyProviders = ["claude-code-cli", "ollama", "nextain"];
		const apiKeyOptional = noKeyProviders.includes(config.provider ?? "");
		return (
			!!config.onboardingComplete &&
			(!!config.apiKey || !!config.naiaKey || apiKeyOptional)
		);
	});

	if (!alreadyConfigured) {
		await browser.execute(
			(geminiKey: string, naiaKey: string) => {
				const existing = localStorage.getItem("naia-config");
				const config = existing ? JSON.parse(existing) : {};
				if (naiaKey && !geminiKey) {
					// Use nextain provider when only naia key is available
					Object.assign(config, {
						provider: "nextain",
						model: config.model || "gemini-2.5-pro",
						apiKey: "",
						naiaKey: naiaKey,
						agentName: config.agentName || "Naia",
						userName: config.userName || "Tester",
						vrmModel: config.vrmModel || "/avatars/01-OL_Woman.vrm",
						persona: config.persona || "Friendly AI companion",
						enableTools: true,
						locale: config.locale || "ko",
						onboardingComplete: true,
						appVisible: true,
					});
				} else {
					Object.assign(config, {
						provider: config.provider || "gemini",
						model: config.model || "gemini-2.5-flash",
						apiKey: config.apiKey || geminiKey,
						agentName: config.agentName || "Naia",
						userName: config.userName || "Tester",
						vrmModel: config.vrmModel || "/avatars/01-OL_Woman.vrm",
						persona: config.persona || "Friendly AI companion",
						enableTools: true,
						locale: config.locale || "ko",
						onboardingComplete: true,
						appVisible: true,
					});
				}
				localStorage.setItem("naia-config", JSON.stringify(config));
			},
			API_KEY,
			NAIA_KEY,
		);
		// Retry refresh — WebKitGTK may throw UND_ERR_HEADERS_TIMEOUT intermittently
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await browser.refresh();
				break;
			} catch {
				if (attempt === 2)
					throw new Error(
						"browser.refresh() failed after 3 attempts in ensureAppReady",
					);
				await browser.pause(2_000);
			}
		}
	} else {
		// Even if already configured, ensure the app is visible so tabs render.
		// A stored config with appVisible:false would block all tab-based waits.
		const appWasHidden = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return false;
			const config = JSON.parse(raw);
			if (config.appVisible === false) {
				config.appVisible = true;
				localStorage.setItem("naia-config", JSON.stringify(config));
				return true;
			}
			return false;
		});
		// If we changed appVisible, refresh so React picks up the new state.
		if (appWasHidden) {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await browser.refresh();
					break;
				} catch {
					if (attempt === 2)
						throw new Error(
							"browser.refresh() failed after 3 attempts in ensureAppReady (appVisible fix)",
						);
					await browser.pause(2_000);
				}
			}
		}
	}

	await waitForAppReadySurface();
}

/**
 * VRM 아바타 피커를 연다 (#541).
 *
 * 아바타 구역은 기본이 영상 아바타(NVA)라 VRM 카드가 렌더되지 않는다. 공급자를
 * 바꿔야 나온다 — 예전 스펙은 그 단계 없이 카드를 세다가 0을 얻었다.
 */
export async function openVrmAvatarPicker(): Promise<void> {
	await openSettingsSection("avatar");
	await browser.execute(() => {
		const select = document.getElementById(
			"avatar-provider",
		) as HTMLSelectElement | null;
		if (!select || select.value === "vrm") return;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set;
		setter?.call(select, "vrm");
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await browser.pause(500);
}

// ── 온보딩을 처음 상태로 되돌리기 (#564) ──────────────────────────────────────
//
// 왜 헬퍼가 필요한가: 스펙 넷(09·13·67·54b)이 저마다 같은 세 줄을 적고 있었다.
//
//   localStorage.removeItem("naia-config");
//   await safeRefresh();
//   await $(S.onboardingOverlay).waitForDisplayed();
//
// 그런데 그 세 줄로는 온보딩이 돌아오지 않는다. 자동 실행에서는 `App.tsx` 가
// 매 부팅마다 `naia-config` 를 다시 써서 마법사를 건너뛰기 때문이다. 새로 고침
// 직후 `onboardingComplete: true` 가 되돌아와 오버레이가 영영 뜨지 않았고, 네
// 스펙이 30초를 기다리다 함께 죽었다.
//
// 두 번째 자리는 워크스페이스 파일이다. `config.json` 이 설정의 정본이므로,
// 브라우저 캐시만 비우면 남은 값이 다시 실려 온다. 그래서 파일도 함께 비운다.

/** `App.tsx` 와 같은 이름을 쓴다 — 어긋나면 표식이 아무 일도 하지 않는다. */
const FORCE_ONBOARDING_KEY = "naia-e2e-force-onboarding";

/**
 * 페이지 안에서 Tauri 명령을 부른다.
 *
 * `__TAURI_INTERNALS__` 는 `withGlobalTauri` 설정과 무관하게 늘 있다. 프런트의
 * `invoke()` 도 결국 이것을 감싼다 — eval 되는 코드에서 import 를 피하려고 직접
 * 쓴다(24-adk-setup-flow 가 같은 방식이다).
 */
async function tauriInvokeInPage<T>(
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

/**
 * 온보딩을 처음 상태로 되돌리고, 마법사가 실제로 뜰 때까지 기다린다.
 *
 * `seed` 는 되돌린 뒤에도 남길 값이다(예: `{ locale: "ko" }`). 파일이 둘 다
 * 없으면 부팅 병합은 `null` 을 내고 호출자가 기존 캐시를 유지하므로, 여기 적은
 * 값은 새로 고침 뒤에도 살아남는다.
 *
 * 표식을 지우는 것은 오버레이를 본 **뒤**다. `App.tsx` 의 씨앗 블록은 렌더마다
 * 도는 자리라, 부팅 한 번에 지워 버리면 마법사 중간에 다시 건너뛰게 된다.
 */
export async function resetOnboarding(
	seed: Record<string, unknown> = {},
): Promise<void> {
	// 1) 워크스페이스 파일을 비운다 — 설정의 정본이 그쪽이다.
	const adkPath = await browser.execute(() =>
		localStorage.getItem("naia-adk-path"),
	);
	if (adkPath) {
		await tauriInvokeInPage("reset_naia_config_files", { adkPath });
	}

	// 2) 브라우저 캐시를 비우고, 이번 부팅은 마법사를 보라는 표식을 세운다.
	await browser.execute(
		(key: string, s: Record<string, unknown>) => {
			localStorage.setItem(key, "1");
			if (Object.keys(s).length === 0) localStorage.removeItem("naia-config");
			else localStorage.setItem("naia-config", JSON.stringify(s));
		},
		FORCE_ONBOARDING_KEY,
		seed,
	);

	await safeRefresh();
	await waitForOnboardingSurface();

	// 3) 표식은 여기서 지운다. 남겨 두면 뒤따르는 다른 스펙 파일까지 마법사가
	//    뜨는 상태가 되어, 이 헬퍼가 고치려던 것과 반대 방향으로 어긋난다.
	await browser.execute((key: string) => {
		localStorage.removeItem(key);
	}, FORCE_ONBOARDING_KEY);
}

/** 온보딩 표면의 관측값. 관측값으로 원인을 단정하지 않는다. */
interface OnboardingSurface {
	readonly uiMode: string | null;
	readonly hasOverlay: boolean;
	readonly windowGeometry: {
		readonly innerWidth: number;
		readonly innerHeight: number;
		readonly outerWidth: number;
		readonly outerHeight: number;
		readonly clientWidth: number;
		readonly clientHeight: number;
		readonly devicePixelRatio: number;
	};
	readonly errorText: string[];
	readonly onboardingComplete: unknown;
	readonly hasMarker: boolean;
	readonly adkPath: string | null;
}

async function readOnboardingSurface(): Promise<OnboardingSurface> {
	return (await browser.execute((key: string) => {
		const raw = localStorage.getItem("naia-config");
		let onboardingComplete: unknown = "(config 없음)";
		if (raw) {
			try {
				onboardingComplete = JSON.parse(raw).onboardingComplete ?? null;
			} catch {
				onboardingComplete = "(config 파싱 실패)";
			}
		}
		const shell = document.querySelector<HTMLElement>("[data-ui-mode]");
		const visibleText = (selector: string): string[] =>
			Array.from(document.querySelectorAll<HTMLElement>(selector))
				.map((element) => {
					const style = window.getComputedStyle(element);
					if (style.display === "none" || style.visibility === "hidden") {
						return "";
					}
					return (element.innerText || element.textContent || "")
						.trim()
						.replace(/\s+/g, " ")
						.slice(0, 500);
				})
				.filter(Boolean)
				.slice(0, 4);
		const errorText = Array.from(
			new Set([
				...visibleText('[role="alert"]'),
				...visibleText("output[aria-live]"),
			]),
		).slice(0, 4);
		return {
			uiMode: shell?.dataset.uiMode ?? null,
			hasOverlay: Boolean(document.querySelector('[data-testid="onboarding"]')),
			windowGeometry: {
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				outerWidth: window.outerWidth,
				outerHeight: window.outerHeight,
				clientWidth: document.documentElement.clientWidth,
				clientHeight: document.documentElement.clientHeight,
				devicePixelRatio: window.devicePixelRatio,
			},
			errorText,
			onboardingComplete,
			hasMarker: localStorage.getItem(key) === "1",
			adkPath: localStorage.getItem("naia-adk-path"),
		};
	}, FORCE_ONBOARDING_KEY)) as OnboardingSurface;
}

/** 30초 동안 한 번만 기다리고, 실패하면 관측값을 함께 보고한다. */
async function waitForOnboardingSurface(): Promise<void> {
	let surface = await readOnboardingSurface();
	try {
		await $(S.onboardingOverlay).waitForDisplayed({ timeout: 30_000 });
	} catch (error) {
		surface = await readOnboardingSurface();
		const reason = error instanceof Error ? error.message : String(error);
		const geometry = surface.windowGeometry;
		throw new Error(
			`Onboarding surface did not become visible within 30 seconds: ${reason}; ` +
			`uiMode=${surface.uiMode ?? "unknown"}, ` +
			`overlay=${surface.hasOverlay ? "present" : "missing"}, ` +
			`window=${geometry.innerWidth}x${geometry.innerHeight}, ` +
			`outer=${geometry.outerWidth}x${geometry.outerHeight}, ` +
			`client=${geometry.clientWidth}x${geometry.clientHeight}, ` +
			`dpr=${geometry.devicePixelRatio}, ` +
			`errorText=${surface.errorText.length > 0 ? JSON.stringify(surface.errorText) : "none"}, ` +
			`onboardingComplete=${String(surface.onboardingComplete)}, ` +
			`marker=${surface.hasMarker ? "set" : "unset"}, ` +
			`adkPath=${surface.adkPath ?? "unset"}`,
		);
	}
}


/**
 * 설정 값을 **파일까지** 저장한다.
 *
 * `localStorage` 만 고치고 새로 고치면 값이 사라진다. `config.json` 이 정본이라
 * 부팅 병합에서 파일이 이기기 때문이다(FR-CONFIG-SOT.1). 54b 의 locale·
 * speechStyle 단정 열다섯 개가 그 자리에서 죽었다 — 스펙은 캐시에 썼고 화면은
 * 파일에서 다시 읽었다.
 *
 * 제품의 되쓰기 경로를 그대로 탄다. `saveConfig` 가 내는 것과 같은 사건을 내고,
 * `App.tsx` 의 디바운스(800ms)가 파일에 밀어 넣을 때까지 기다린다.
 */
export async function persistConfigPatch(
	patch: Record<string, unknown>,
): Promise<void> {
	await browser.execute((p: Record<string, unknown>) => {
		const raw = localStorage.getItem("naia-config");
		const config = raw ? JSON.parse(raw) : {};
		Object.assign(config, p);
		localStorage.setItem("naia-config", JSON.stringify(config));
		window.dispatchEvent(new CustomEvent("naia-config-changed"));
	}, patch);
	// 디바운스 800ms + 파일 쓰기 여유. 이 기다림을 빼면 새로 고침이 먼저 일어나
	// 값이 사라진다.
	await browser.pause(1500);
}
