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
			await browser.execute(() => { window.location.reload(); }).catch(() => {});
			await browser.pause(800); // reload 네비게이션 시작 여유
			const appRoot = await $(S.appRoot);
			await appRoot.waitForExist({ timeout: 30_000 });
			return;
		} catch {
			if (attempt === maxAttempts - 1)
				throw new Error(`safeRefresh(location.reload) failed after ${maxAttempts} attempts`);
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

/** Navigate to the Settings tab and wait for render. */
export async function navigateToSettings(): Promise<void> {
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (el) el.click();
	}, S.settingsTabBtn);
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

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
const NAIA_KEY = process.env.NAIA_API_KEY || "";
const ADK_FIXTURE =
	process.env.NAIA_E2E_ADK_FIXTURE ||
	"D:\\alpha-adk\\projects\\naia-adk";

/**
 * Ensure the app is ready: bypass onboarding, set base config, wait for tabs.
 * Safe to call multiple times — skips if already configured.
 */
export async function ensureAppReady(): Promise<void> {
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
						vrmModel:
							config.vrmModel || "/avatars/01-Sendagaya-Shino-uniform.vrm",
						persona: config.persona || "Friendly AI companion",
						enableTools: true,
						locale: config.locale || "ko",
						onboardingComplete: true,
						panelVisible: true,
					});
				} else {
					Object.assign(config, {
						provider: config.provider || "gemini",
						model: config.model || "gemini-2.5-flash",
						apiKey: config.apiKey || geminiKey,
						agentName: config.agentName || "Naia",
						userName: config.userName || "Tester",
						vrmModel:
							config.vrmModel || "/avatars/01-Sendagaya-Shino-uniform.vrm",
						persona: config.persona || "Friendly AI companion",
						enableTools: true,
						locale: config.locale || "ko",
						onboardingComplete: true,
						panelVisible: true,
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
		// Even if already configured, ensure the panel is visible so tabs render.
		// A stored config with panelVisible:false would block all tab-based waits.
		const panelWasHidden = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return false;
			const config = JSON.parse(raw);
			if (config.panelVisible === false) {
				config.panelVisible = true;
				localStorage.setItem("naia-config", JSON.stringify(config));
				return true;
			}
			return false;
		});
		// If we changed panelVisible, refresh so React picks up the new state.
		if (panelWasHidden) {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await browser.refresh();
					break;
				} catch {
					if (attempt === 2)
						throw new Error(
							"browser.refresh() failed after 3 attempts in ensureAppReady (panelVisible fix)",
						);
					await browser.pause(2_000);
				}
			}
		}
	}

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
	// jikime c0d967e9 baseline 의 ChatPanel.tsx 는 chat-tabs 안에 button.chat-tab
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
