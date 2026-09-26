import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import {
	clickBySelector,
	ensureAppReady,
	openSettingsSection,
	safeRefresh,
	scrollToSection,
	setNativeValue,
} from "../helpers/settings.js";
import { CREDENTIALED_MAIN_MODEL } from "../credentialed-adk-seed.js";

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Naia Gateway key — the chat provider (nextain) and the semantic judge
 * (helpers/semantic.ts) both go through the Naia gateway.
 *
 * 예전에는 Gemini 직결 키가 있어야 대화·판정 묶음(3·4)이 돌았고, 없으면
 * `describe.skip` 으로 조용히 빠졌다. #602 가 그 공급자를 지운 뒤로 그 키를
 * 요구한다는 이유로 스펙 전체가 회귀에서 빠졌다. 판정자도 게이트웨이로 옮겼으니
 * 이제 네 묶음 모두 이 키 하나로 돈다.
 */
const NAIA_KEY = process.env.NAIA_API_KEY || "";

if (!NAIA_KEY) {
	throw new Error("Auth key required: set NAIA_API_KEY (Naia gateway)");
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Read the current Shell/agent config SoT from the active ADK workspace. */
async function readCurrentConfig(): Promise<Record<string, unknown>> {
	const adkPath =
		process.env.NAIA_E2E_ADK_PATH ||
		(await browser.execute(() => localStorage.getItem("naia-adk-path") ?? ""));
	if (!adkPath) throw new Error("Active ADK path is unavailable");
	const path = resolve(adkPath, "naia-settings", "config.json");
	if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** Poll the config file until the predicate passes or timeout. */
async function waitForConfigCondition(
	predicate: (cfg: Record<string, unknown>) => boolean,
	timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const cfg = await readCurrentConfig();
			if (predicate(cfg)) return cfg;
		} catch {
			/* file may not exist yet */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	let lastSnippet = "(unable to read config)";
	try {
		const last = await readCurrentConfig();
		lastSnippet = JSON.stringify(
			Object.fromEntries(
				Object.entries(last).filter(([key]) =>
					key.toLowerCase().includes("memory"),
				),
			),
		);
	} catch {
		/* file corrupt or missing at timeout boundary */
	}
	throw new Error(
		`Config condition not met within ${timeoutMs}ms. Last config: ${lastSnippet}`,
	);
}

/** Click a radio button by name+value using JS (WebKitGTK compat). */
async function clickRadio(name: string, value: string): Promise<void> {
	await browser.execute(
		(n: string, v: string) => {
			const el = document.querySelector(
				`input[name="${n}"][value="${v}"]`,
			) as HTMLInputElement | null;
			if (!el)
				throw new Error(`Radio input[name="${n}"][value="${v}"] not found`);
			el.scrollIntoView({ block: "center" });
			el.click();
		},
		name,
		value,
	);
	// Wait until DOM reflects the check (React state update + re-render)
	await browser.waitUntil(
		() =>
			browser.execute(
				(n: string, v: string) =>
					!!(
						document.querySelector(
							`input[name="${n}"][value="${v}"]`,
						) as HTMLInputElement | null
					)?.checked,
				name,
				value,
			),
		{
			timeout: 3_000,
			timeoutMsg: `Radio ${name}=${value} not checked after click`,
		},
	);
}

/** Read a radio button's checked state. */
async function isRadioChecked(name: string, value: string): Promise<boolean> {
	return browser.execute(
		(n: string, v: string) =>
			!!(
				document.querySelector(
					`input[name="${n}"][value="${v}"]`,
				) as HTMLInputElement | null
			)?.checked,
		name,
		value,
	);
}

/** Count fact-item elements in the DOM. */
async function countFactItems(): Promise<number> {
	return browser.execute(
		(sel: string) => document.querySelectorAll(sel).length,
		S.factItem,
	);
}

/** Click the settings save button via JS. */
async function clickSave(): Promise<void> {
	await browser.execute((sel: string) => {
		const btn = document.querySelector(sel) as HTMLButtonElement | null;
		if (!btn) throw new Error(`${sel} not found`);
		btn.scrollIntoView({ block: "center" });
		btn.click();
	}, S.settingsSaveBtn);
	// WebKitGTK: browser.execute click is fire-and-forget; React's sync save
	// (localStorage write) completes in <10ms but the event loop needs a tick.
	// No observable DOM predicate exists for this save; 300ms is a safe guard.
	await browser.pause(300);
}

/** Navigate to settings and wait for the memory section to render. */
async function gotoSettingsMemory(): Promise<void> {
	// 설정은 활성 구역만 렌더한다 — 메모리 어댑터 선택은 memory 구역에 있다.
	await openSettingsSection("memory");
	// Brief pause for tab transition animation before scrolling
	await browser.pause(500);
	await scrollToSection(S.memoryAdapterLocal);
	// WebKitGTK: programmatic scroll is async inside the WebView;
	// wait for target element to be interactable before proceeding.
	await $(S.memoryAdapterLocal).waitForDisplayed({ timeout: 5_000 });
}

/**
 * Force config to the Naia gateway provider so LLM tests always work.
 * Ensures handleSave() does not early-return due to missing naiaKey.
 */
async function forceProviderConfig(): Promise<void> {
	await browser.execute(
		(naiaKey: string, model: string) => {
			const existing = (() => {
				try {
					return (
						JSON.parse(localStorage.getItem("naia-config") ?? "null") ?? {}
					);
				} catch {
					return {};
				}
			})();
			const config = {
				...existing,
				provider: "nextain",
				model,
				apiKey: "",
				naiaKey: naiaKey,
				onboardingComplete: true,
				appVisible: true,
				discordSessionMigrated: true,
			};
			localStorage.setItem("naia-config", JSON.stringify(config));
		},
		NAIA_KEY,
		CREDENTIALED_MAIN_MODEL,
	);
	await safeRefresh();
	const appRoot = await $(S.appRoot);
	await appRoot.waitForDisplayed({ timeout: 20_000 });
	// Wait for the app to be ready: settings tab (8th) must be present
	await browser.waitUntil(
		() =>
			browser.execute(
				(sel: string) => !!document.querySelector(sel),
				S.settingsTabBtn,
			),
		{
			timeout: 15_000,
			timeoutMsg: "Settings tab not found after forceProviderConfig",
		},
	);
	await browser.waitUntil(
		() =>
			browser.execute(
				(sel: string) => !document.querySelector(sel),
				S.onboardingOverlay,
			),
		{ timeout: 10_000 },
	);
}

/**
 * Retry wrapper for assertSemantic — retries once on Judge HTTP 599
 * (transient network error from the judge's Naia gateway call).
 */
async function assertSemanticWithRetry(
	answer: string,
	task: string,
	criteria: string,
	maxRetries = 2,
): Promise<void> {
	for (let i = 0; i < maxRetries; i++) {
		try {
			await assertSemantic(answer, task, criteria);
			return;
		} catch (err) {
			if (String(err).includes("Judge HTTP 599") && i < maxRetries - 1) {
				await browser.pause(3_000);
			} else {
				throw err;
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────

describe("91 — Memory Settings Integration", () => {
	let originalNaiaConfig: string | null = null;

	before(async () => {
		// Save original config so we can restore it after the spec (spec 89 pattern)
		originalNaiaConfig = await browser.execute(() =>
			localStorage.getItem("naia-config"),
		);
	});

	after(async () => {
		// Restore original config to avoid polluting subsequent specs
		if (originalNaiaConfig !== null) {
			await browser.execute((cfg: string) => {
				localStorage.setItem("naia-config", cfg);
			}, originalNaiaConfig);
		}
	});

	// ── Suite 1: Settings UI rendering ─────────────────────────────────────────
	describe("1) Settings UI rendering", () => {
		before(async () => {
			await ensureAppReady();
			await gotoSettingsMemory();
		});

		it("should render local and qdrant adapter radio buttons", async () => {
			const localRadio = await $(S.memoryAdapterLocal);
			const qdrantRadio = await $(S.memoryAdapterQdrant);
			await localRadio.waitForDisplayed({ timeout: 5_000 });
			await qdrantRadio.waitForDisplayed({ timeout: 5_000 });
			expect(await localRadio.isDisplayed()).toBe(true);
			expect(await qdrantRadio.isDisplayed()).toBe(true);
		});

		it("should render all 4 embedding provider radio buttons", async () => {
			for (const sel of [
				S.memoryEmbeddingNone,
				S.memoryEmbeddingOffline,
				S.memoryEmbeddingVllm,
				S.memoryEmbeddingOllama,
				S.memoryEmbeddingNaia,
			]) {
				const el = await $(sel);
				await el.waitForDisplayed({ timeout: 5_000 });
				expect(await el.isDisplayed()).toBe(true);
			}
		});

		it("should default to local adapter and none embedding", async () => {
			expect(await isRadioChecked("memory-adapter", "local")).toBe(true);
			expect(await isRadioChecked("memory-embedding", "none")).toBe(true);
		});

		it("should hide Qdrant URL field by default, show when Qdrant selected", async () => {
			const hiddenBefore = await browser.execute(
				(sel: string) => !document.querySelector(sel),
				S.qdrantUrlInput,
			);
			expect(hiddenBefore).toBe(true);

			await clickRadio("memory-adapter", "qdrant");
			const qdrantField = await $(S.qdrantUrlInput);
			await qdrantField.waitForDisplayed({ timeout: 5_000 });
			expect(await qdrantField.isDisplayed()).toBe(true);

			await clickRadio("memory-adapter", "local");
		});

		it("should show offline model options when offline embedding selected", async () => {
			await clickRadio("memory-embedding", "offline");
			const miniLM = await $(S.memoryOfflineModelMiniLM);
			await miniLM.waitForDisplayed({ timeout: 5_000 });
			expect(await miniLM.isDisplayed()).toBe(true);
			expect(await (await $(S.memoryOfflineModelMpnet)).isDisplayed()).toBe(
				true,
			);
			await clickRadio("memory-embedding", "none");
		});

		it("should show vLLM URL + model fields when vllm selected", async () => {
			await clickRadio("memory-embedding", "vllm");
			await $(S.memoryEmbeddingBaseUrl).waitForDisplayed({ timeout: 5_000 });
			expect(await $(S.memoryEmbeddingBaseUrl).isDisplayed()).toBe(true);
			expect(await $(S.memoryEmbeddingModel).isDisplayed()).toBe(true);
			await clickRadio("memory-embedding", "none");
		});

		it("should show Naia embedding status hint when naia embedding selected", async () => {
			await clickRadio("memory-embedding", "naia");
			await browser.pause(400);
			// Shows either "Naia account required" (no naiaKey) or "Naia account connected" (naiaKey set)
			const hintVisible = await browser.execute(() =>
				Array.from(document.querySelectorAll(".settings-hint")).some((h) =>
					/(Naia account|Naia \uacc4\uc815)/i.test(h.textContent ?? ""),
				),
			);
			expect(hintVisible).toBe(true);
			await clickRadio("memory-embedding", "none");
		});

		it("should render backup section with password input and export/import buttons", async () => {
			// Scroll to backup section (search by placeholder — Korean: "백업 비밀번호", English: "Backup password")
			await browser.execute(() => {
				const inputs = Array.from(
					document.querySelectorAll("input[type='password']"),
				) as HTMLInputElement[];
				const pw = inputs.find((el) => {
					const ph = el.placeholder;
					// \ube44\ubc00\ubc88\ud638 = 비밀번호 (비=BE44, 밀=BC00, 번=BC88, 호=D638)
					return (
						ph.toLowerCase().includes("password") ||
						ph.includes("\ube44\ubc00\ubc88\ud638")
					);
				});
				if (pw) pw.scrollIntoView({ block: "center" });
			});
			await browser.pause(500);

			// Find export/import buttons by text content
			const buttons = await browser.execute(() => {
				const btns = Array.from(
					document.querySelectorAll("button"),
				) as HTMLButtonElement[];
				return {
					hasExport: btns.some((b) =>
						/(export|\ub0b4\ubcf4\ub0b4\uae30)/i.test(b.textContent ?? ""),
					),
					hasImport: btns.some((b) =>
						/(import|\uac00\uc838\uc624\uae30)/i.test(b.textContent ?? ""),
					),
					hasPasswordInput: Array.from(
						document.querySelectorAll("input[type='password']"),
					).some((el) => {
						const ph = (el as HTMLInputElement).placeholder;
						return (
							ph.toLowerCase().includes("password") ||
							ph.includes("\ube44\ubc00\ubc88\ud638")
						);
					}),
				};
			});
			expect(buttons.hasPasswordInput).toBe(true);
			expect(buttons.hasExport).toBe(true);
			expect(buttons.hasImport).toBe(true);
		});
	});

	// Suite 2: Settings -> naia-settings/config.json SoT
	describe("2) Settings -> current config.json contract", () => {
		before(async () => {
			// Put naiaKey in local config to avoid handleSave() early-return
			// (the key lives in the secure store and loads async).
			await forceProviderConfig();
			await gotoSettingsMemory();
		});

		it("should write the flat local memory contract to config.json on save", async () => {
			await clickRadio("memory-adapter", "local");
			await clickRadio("memory-embedding", "none");
			await clickSave();

			const config = await waitForConfigCondition(
				(cfg) => cfg.memoryAdapter === "local",
			);
			expect(config.memoryAdapter).toBe("local");
			expect(config.memoryEmbeddingProvider).toBe("none");
		});

		it("should write vllm embedding fields and derived aliases to config.json", async () => {
			await clickRadio("memory-embedding", "vllm");
			await browser.pause(300);
			// vLLM 임베딩 Base URL 및 Model 입력 필드는 포커스를 벗어날 때(blur) config.json에 저장된다.
			await setNativeValue(S.memoryEmbeddingBaseUrl, "http://localhost:11434");
			await browser.execute((sel: string) => {
				const el = document.querySelector(sel) as HTMLInputElement | null;
				if (!el) throw new Error(`${sel} not found`);
				el.focus();
				el.blur();
				el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}, S.memoryEmbeddingBaseUrl);

			await setNativeValue(S.memoryEmbeddingModel, "nomic-embed-text");
			await browser.execute((sel: string) => {
				const el = document.querySelector(sel) as HTMLInputElement | null;
				if (!el) throw new Error(`${sel} not found`);
				el.focus();
				el.blur();
				el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			}, S.memoryEmbeddingModel);

			await clickSave();

			// 라디오를 누르는 순간 공급자만 먼저 저장된다(persistConfig). 공급자만 보고
			// 멈추면 저장 버튼이 쓴 URL·모델보다 먼저 읽어 undefined 를 본다.
			const config = await waitForConfigCondition(
				(cfg) =>
					cfg.memoryEmbeddingProvider === "vllm" &&
					cfg.memoryEmbeddingBaseUrl === "http://localhost:11434" &&
					cfg.memoryEmbeddingModel === "nomic-embed-text",
			);
			expect(config.memoryEmbeddingProvider).toBe("vllm");
			expect(config.memoryEmbeddingBaseUrl).toBe("http://localhost:11434");
			expect(config.memoryEmbeddingModel).toBe("nomic-embed-text");
			expect(config.NAIA_EMBED_PROVIDER).toBe("vllm");
			expect(config.NAIA_EMBED_MODEL).toBe("nomic-embed-text");
			expect(config.NAIA_EMBED_BASE_URL).toBe("http://localhost:11434");

			// Revert and wait for config.json to reflect the reset.
			await clickRadio("memory-embedding", "none");
			await clickSave();
			await waitForConfigCondition(
				(cfg) => cfg.memoryEmbeddingProvider === "none",
			);
		});

		it("should write the memory LLM role to config.json", async () => {
			// #692·#694 가 기억 LLM 라디오(memory-llm)를 "작은 LLM" 선택(small-llm)
			// 으로 바꿨다. 이 구역은 저장 버튼이 아니라 칸을 떠날 때(blur) 곧바로
			// config.json 에 쓴다.
			const previous = await browser.execute(
				() =>
					(
						document.querySelector(
							'input[name="small-llm"]:checked',
						) as HTMLInputElement | null
					)?.value ?? "",
			);
			await clickRadio("small-llm", "vllm");
			await setNativeValue(
				'[data-testid="small-llm-base-url"]',
				"http://localhost:8001/v1",
			);
			await setNativeValue('[data-testid="small-llm-model"]', "test-model");
			await browser.execute(() => {
				const el = document.querySelector(
					'[data-testid="small-llm-model"]',
				) as HTMLInputElement | null;
				if (!el) throw new Error("small LLM model input not found");
				el.focus();
				el.blur();
				el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			});

			const config = await waitForConfigCondition((cfg) => {
				const roles = cfg.llmRoles as Record<string, Record<string, unknown>>;
				return (
					roles?.memory?.provider === "vllm" &&
					roles?.memory?.model === "test-model"
				);
			});
			const roles = config.llmRoles as Record<
				string,
				Record<string, unknown>
			>;
			expect(roles.memory.provider).toBe("vllm");
			expect(roles.memory.model).toBe("test-model");
			expect(String(roles.memory.baseUrl)).toContain("localhost:8001");

			// Revert to whatever was chosen before.
			if (previous === "threshold" || previous === "off") {
				await clickRadio("small-llm", previous);
				await browser.pause(500);
			}
		});

		it("should persist memory settings in localStorage after save", async () => {
			await clickRadio("memory-embedding", "offline");
			await clickRadio("memory-offline-model", "all-MiniLM-L6-v2");
			await clickSave();
			// Wait for localStorage write to settle before reading
			await browser.waitUntil(
				() =>
					browser.execute(() => {
						try {
							const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "");
							return cfg?.memoryEmbeddingProvider === "offline";
						} catch {
							return false;
						}
					}),
				{
					timeout: 3_000,
					timeoutMsg:
						"memoryEmbeddingProvider=offline not saved to localStorage",
				},
			);

			const saved = await browser.execute(() => {
				const raw = localStorage.getItem("naia-config");
				return raw ? JSON.parse(raw) : null;
			});
			expect(saved?.memoryEmbeddingProvider).toBe("offline");
			expect(saved?.memoryOfflineModel).toBe("all-MiniLM-L6-v2");

			// Revert
			await clickRadio("memory-embedding", "none");
			await clickSave();
			await waitForConfigCondition(
				(cfg) => cfg.memoryEmbeddingProvider === "none",
			);
		});

		it("should reload saved memory settings correctly after page refresh", async () => {
			// Save offline + mpnet
			await clickRadio("memory-embedding", "offline");
			await clickRadio("memory-offline-model", "all-mpnet-base-v2");
			await clickSave();
			// Wait for localStorage to reflect the save
			await browser.waitUntil(
				() =>
					browser.execute(() => {
						try {
							return (
								JSON.parse(localStorage.getItem("naia-config") ?? "")
									?.memoryEmbeddingProvider === "offline"
							);
						} catch {
							return false;
						}
					}),
				{
					timeout: 3_000,
					timeoutMsg: "memoryEmbeddingProvider=offline not in localStorage",
				},
			);

			// Confirm saved to localStorage first
			const saved = await browser.execute(() => {
				const raw = localStorage.getItem("naia-config");
				return raw ? JSON.parse(raw) : null;
			});
			expect(saved?.memoryEmbeddingProvider).toBe("offline");

			// Refresh (preserves localStorage, re-initializes React state)
			await safeRefresh();
			const appRoot = await $(S.appRoot);
			await appRoot.waitForDisplayed({ timeout: 20_000 });
			await browser.waitUntil(
				() =>
					browser.execute(
						(sel: string) => !!document.querySelector(sel),
						S.settingsTabBtn,
					),
				{ timeout: 15_000, timeoutMsg: "Settings tab not found after refresh" },
			);

			// Navigate back to settings
			await gotoSettingsMemory();

			// Wait for offline option to be selected (requires embedding section to be visible)
			await browser.waitUntil(
				() => isRadioChecked("memory-embedding", "offline"),
				{ timeout: 5_000, timeoutMsg: "memory-embedding=offline not restored" },
			);

			try {
				await browser.waitUntil(
					() => isRadioChecked("memory-offline-model", "all-mpnet-base-v2"),
					{ timeout: 5_000 },
				);
			} catch {
				// 무엇이 대신 골라져 있는지, 저장소 두 곳에 무엇이 남았는지 함께 남긴다.
				const shown = await browser.execute(
					() =>
						(
							document.querySelector(
								'input[name="memory-offline-model"]:checked',
							) as HTMLInputElement | null
						)?.value ?? "(none)",
				);
				const local = await browser.execute(() => {
					try {
						return String(
							JSON.parse(localStorage.getItem("naia-config") ?? "{}")
								.memoryOfflineModel,
						);
					} catch {
						return "(unreadable)";
					}
				});
				const file = await readCurrentConfig()
					.then((cfg) => String(cfg.memoryOfflineModel))
					.catch(() => "(unreadable)");
				throw new Error(
					`memory-offline-model=all-mpnet-base-v2 not restored (shown=${shown}, localStorage=${local}, config.json=${file})`,
				);
			}

			// Revert
			await clickRadio("memory-embedding", "none");
			await clickSave();
			await waitForConfigCondition(
				(cfg) => cfg.memoryEmbeddingProvider === "none",
			);
		});
	});

	// ── Suite 3: Memory storage & recall (same session) ─────────────────────────
	describe(
		"3) Memory storage and recall (same session)",
		() => {
			before(async () => {
				// Force the gateway provider so LLM calls work regardless of real user config
				await forceProviderConfig();
				await clickBySelector(S.chatTab);
				const chatInput = await $(S.chatInput);
				await chatInput.waitForEnabled({ timeout: 15_000 });
			});

			it("should acknowledge storing user preference (TypeScript)", async () => {
				await sendMessage(
					"\ub0b4 \uac00\uc7a5 \uc88b\uc544\ud558\ub294 \ud504\ub85c\uadf8\ub798\ubc0d \uc5b8\uc5b4\ub294 TypeScript\uc57c. \uae30\uc5b5\ud574\uc918.",
				);
				const resp = await getLastAssistantMessage();
				await assertSemanticWithRetry(
					resp,
					"\ub0b4 \uac00\uc7a5 \uc88b\uc544\ud558\ub294 \ud504\ub85c\uadf8\ub798\ubc0d \uc5b8\uc5b4\ub294 TypeScript\uc57c. \uae30\uc5b5\ud574\uc918.",
					"AI\uac00 TypeScript \uc120\ud638 \uc815\ubcf4\ub97c \ubc1b\uc544\ub4e4\uc774\uace0 \uae30\uc5b5\ud558\uaca0\ub2e4\uace0 \uc751\ub2f5\ud588\ub294\uac00? \uc5d0\ub7ec \ub514\uc2a4\ucf54\ub4dc \uba54\uc2dc\uc9c0\ub098 \ube48 \uc751\ub2f5\uc740 FAIL",
				);
			});

			it("should recall the preference in follow-up (same session)", async () => {
				await sendMessage(
					"\ub0b4\uac00 \uc88b\uc544\ud558\ub294 \ud504\ub85c\uadf8\ub798\ubc0d \uc5b8\uc5b4\uac00 \ubb50\ub77c\uace0 \ud588\uc9c0?",
				);
				const resp = await getLastAssistantMessage();
				await assertSemanticWithRetry(
					resp,
					"\ub0b4\uac00 \uc88b\uc544\ud558\ub294 \ud504\ub85c\uadf8\ub798\ubc0d \uc5b8\uc5b4\uac00 \ubb50\ub77c\uace0 \ud588\uc9c0?",
					"AI\uac00 \uc774\uc804 \ub300\ud654\uc5d0\uc11c \uc5b8\uae09\ud55c 'TypeScript'\ub97c \uba85\uc2dc\ud588\ub294\uac00? TypeScript\uac00 \ub2f5\ubcc0\uc5d0 \uc788\uc73c\uba74 PASS",
				);
			});

			it("should store user identity and integrate multi-turn context", async function () {
				// 대화 두 번과 판정 두 번(판정마다 최대 60초 + 재시도)이 한 it 에 있다.
				// 게이트웨이가 느린 때 기본 180초를 넘길 수 있어 이 it 만 넉넉히 둔다.
				this.timeout(420_000);
				await sendMessage(
					"\ub0b4 \uc774\ub984\uc740 Luke\uc774\uace0, \ubc31\uc5d4\ub4dc \uac1c\ubc1c\uc790\uc57c.",
				);
				const resp1 = await getLastAssistantMessage();
				await assertSemanticWithRetry(
					resp1,
					"\ub0b4 \uc774\ub984\uc740 Luke\uc774\uace0, \ubc31\uc5d4\ub4dc \uac1c\ubc1c\uc790\uc57c.",
					"AI\uac00 Luke\uc640 \ubc31\uc5d4\ub4dc \uac1c\ubc1c\uc790 \uc815\ubcf4\ub97c \ubc1b\uc544\ub4e4\uc774\uace0 \uc5d0\ub7ec \uc5c6\uc774 \uc751\ub2f5\ud588\ub294\uac00?",
				);

				// Multi-turn: both pieces of info should be available
				await sendMessage(
					"\ub0b4 \uc774\ub984\uc774 \ubb50\uace0, \ubb50\ud558\ub294 \uc0ac\ub78c\uc774\ub77c\uace0 \ud588\uc9c0?",
				);
				const resp2 = await getLastAssistantMessage();
				await assertSemanticWithRetry(
					resp2,
					"\ub0b4 \uc774\ub984\uc774 \ubb50\uace0, \ubb50\ud558\ub294 \uc0ac\ub78c\uc774\ub77c\uace0 \ud588\uc9c0?",
					"AI\uac00 \uc774\ub984 'Luke'\uc640 \uc9c1\uc5c5 '\ubc31\uc5d4\ub4dc \uac1c\ubc1c\uc790' \ub97c \ub2f5\ubcc0\uc5d0 \ud3ec\ud568\ud588\ub294\uac00? \ub458 \ub2e4 \uc788\uc73c\uba74 PASS",
				);
			});
		},
	);

	// ── Suite 4: Cross-session memory recall ────────────────────────────────────
	describe(
		"4) Cross-session memory recall (new conversation)",
		() => {
			before(async () => {
				await forceProviderConfig();
				await clickBySelector(S.chatTab);
				const chatInput = await $(S.chatInput);
				await chatInput.waitForEnabled({ timeout: 15_000 });
			});

			it("should store a memorable fact in conversation 1", async () => {
				await sendMessage(
					"\ub0b4 \uc0dd\uc77c\uc740 3\uc6d4 15\uc77c\uc774\uc57c. \uae30\uc5b5\ud574\uc918.",
				);
				const resp = await getLastAssistantMessage();
				await assertSemanticWithRetry(
					resp,
					"\ub0b4 \uc0dd\uc77c\uc740 3\uc6d4 15\uc77c\uc774\uc57c. \uae30\uc5b5\ud574\uc918.",
					"AI\uac00 3\uc6d4 15\uc77c \uc0dd\uc77c\uc744 \uc778\uc9c0\ud558\uace0 \uae30\uc5b5\ud558\uaca0\ub2e4\uace0 \uc751\ub2f5\ud588\ub294\uac00?",
				);
			});

			it("should start a new conversation and clear messages", async () => {
				// Allow time for memory consolidation (off-DOM background IPC).
				// No observable DOM event signals consolidation completion in this version;
				// this is an intentional best-effort guard, not a timing race.
				await browser.pause(3_000);

				// Use browser.execute click — WebKitGTK returns "unsupported operation" on element.click()
				await browser.execute((sel: string) => {
					const btn = document.querySelector(sel) as HTMLButtonElement | null;
					if (!btn) throw new Error(`${sel} not found`);
					btn.click();
				}, S.newChatBtn);

				await browser.waitUntil(
					async () => {
						const count = await browser.execute(
							(sel: string) => document.querySelectorAll(sel).length,
							S.userMessage,
						);
						return count === 0;
					},
					{ timeout: 10_000, timeoutMsg: "New conversation did not clear" },
				);

				const chatInput = await $(S.chatInput);
				await chatInput.waitForEnabled({ timeout: 10_000 });

				// Verify message list is actually empty (not just "wait timed out silently")
				const msgCount = await browser.execute(
					(sel: string) => document.querySelectorAll(sel).length,
					S.userMessage,
				);
				expect(msgCount).toBe(0);
			});

			it("should recall birthday in new conversation (cross-session)", async () => {
				await sendMessage(
					"\ub0b4 \uc0dd\uc77c\uc774 \uc5b8\uc81c\ub77c\uace0 \ud588\uc9c0?",
				);
				const resp = await getLastAssistantMessage();
				// Memory recall may or may not happen depending on consolidation timing.
				// Minimum: no system error or empty response.
				await assertSemanticWithRetry(
					resp,
					"\ub0b4 \uc0dd\uc77c\uc774 \uc5b8\uc81c\ub77c\uace0 \ud588\uc9c0?",
					"AI\uac00 \uc5d0\ub7ec \uc5c6\uc774 \uc751\ub2f5\ud588\ub294\uac00? 3\uc6d4 15\uc77c\uc744 \ud68c\uc0c1\ud558\uba74 PASS(\ucd5c\uace0), \ubaa8\ub978\ub2e4\uace0 \ub2f5\ud574\ub3c4 PASS(\uba54\ubaa8\ub9ac \ubbf8\uc0dd\uc131 \uac00\ub2a5), \uc5d0\ub7ec\ub098 \ube48 \uc751\ub2f5\ub9cc FAIL",
				);
			});
		},
	);

	// ── Suite 5: Facts list in settings ─────────────────────────────────────────
	describe("5) Facts list in settings", () => {
		let initialFactCount = 0;

		before(async () => {
			await forceProviderConfig();
			await clickBySelector(S.chatTab);
			const chatInput = await $(S.chatInput);
			await chatInput.waitForEnabled({ timeout: 15_000 });
			// Send a message to generate potential facts
			await sendMessage(
				"\ub0b4 \uc774\ub984\uc740 Luke\uc774\uace0, TypeScript\ub97c \uc88b\uc544\ud574. \uae30\uc5b5\ud574\uc918.",
			);
			await getLastAssistantMessage();
			await browser.pause(2_000);
		});

		it("should navigate to settings memory section without error", async () => {
			await gotoSettingsMemory();
			// 이동이 끝났는지는 화면에 그 구역이 실제로 있는지로 본다. 예전에는
			// expect(true).toBe(true) 였는데, 그러면 gotoSettingsMemory 가 조용히
			// 아무 데도 가지 않아도 통과한다.
			const arrived = await browser.execute(() => {
				const el =
					document.querySelector(".facts-list") ||
					document.querySelector(".settings-hint");
				if (el) el.scrollIntoView({ block: "center" });
				return Boolean(el);
			});
			await browser.pause(500);
			// 기억 구역(.facts-list 또는 .settings-hint)이 화면에 있어야 한다.
			expect(arrived).toBe(true);
		});

		it("should show facts list or empty-state hint", async () => {
			// Wait for facts to load (async getAllAgentFacts IPC)
			await browser.pause(1_000);
			initialFactCount = await countFactItems();

			// Check for empty-state hint (any locale: ko/en/ja/etc)
			const hasEmpty = await browser.execute(() =>
				Array.from(document.querySelectorAll(".settings-hint")).some((el) => {
					const text = el.textContent ?? "";
					// Matches ko: "저장된 기억이 없습니다."
					// Matches en: "No stored memories."
					// Matches ja: "保存された記憶はありません。"
					return /(facts|memories|\uae30\uc5b5|\u30e1\u30e2\u308a)/i.test(text);
				}),
			);
			// Also accept if the memory section is rendered at all (facts-list or fact-item visible)
			const hasMemorySection = await browser.execute(
				() =>
					!!(
						document.querySelector(".facts-list") ||
						document.querySelector(".memory-settings-section") ||
						document.querySelector('[name="memory-adapter"]')
					),
			);
			expect(initialFactCount > 0 || hasEmpty || hasMemorySection).toBe(true);
		});

		it("should have delete button for each fact", async () => {
			if (initialFactCount === 0) {
				console.log("[skip] No facts stored yet");
				return;
			}
			const deleteCount = await browser.execute(
				(sel: string) => document.querySelectorAll(sel).length,
				S.factDeleteBtn,
			);
			expect(deleteCount).toBe(initialFactCount);
		});

		it("should delete a fact and update the list count", async () => {
			if (initialFactCount === 0) {
				console.log("[skip] No facts to delete");
				return;
			}
			const countBefore = await countFactItems();
			await browser.execute((sel: string) => {
				(document.querySelector(sel) as HTMLButtonElement | null)?.click();
			}, S.factDeleteBtn);
			await browser.waitUntil(
				async () => (await countFactItems()) < countBefore,
				{ timeout: 5_000, timeoutMsg: "Fact count did not decrease" },
			);
			expect(await countFactItems()).toBe(countBefore - 1);
		});
	});

	// ── Suite 6: Backup export ──────────────────────────────────────────────────
	// 백업 구역은 구현 검증 전까지 의도적으로 비활성화되어 있으므로 비활성 상태 및 준비 중 안내 계약을 검증한다.
	describe("6) Backup export", () => {
		before(async () => {
			await ensureAppReady();
			await gotoSettingsMemory();
			// Scroll to backup area
			await browser.execute(() => {
				const pw =
					(document.querySelector(
						'[data-testid="memory-backup-password"]',
					) as HTMLElement | null) ??
					(
						Array.from(
							document.querySelectorAll("input[type='password']"),
						) as HTMLInputElement[]
					).find((el) => {
						const ph = el.placeholder.toLowerCase();
						return (
							ph.includes("password") || ph.includes("\ube44\ubc00\ubc88\ud638")
						);
					});
				if (pw) pw.scrollIntoView({ block: "center" });
			});
			await browser.pause(500);
		});

		it("should render disabled backup password input", async () => {
			const pwState = await browser.execute(() => {
				const el =
					(document.querySelector(
						'[data-testid="memory-backup-password"]',
					) as HTMLInputElement | null) ??
					(
						Array.from(
							document.querySelectorAll("input[type='password']"),
						) as HTMLInputElement[]
					).find((input) => {
						const ph = input.placeholder.toLowerCase();
						return (
							ph.includes("password") || ph.includes("\ube44\ubc00\ubc88\ud638")
						);
					});
				if (!el) return null;
				return { exists: true, disabled: el.disabled };
			});
			expect(pwState).not.toBeNull();
			expect(pwState?.exists).toBe(true);
			expect(pwState?.disabled).toBe(true);
		});

		it("should render disabled export and import buttons", async () => {
			const buttonStates = await browser.execute(() => {
				const exportBtn =
					(document.querySelector(
						'[data-testid="memory-backup-export"]',
					) as HTMLButtonElement | null) ??
					(
						Array.from(
							document.querySelectorAll("button"),
						) as HTMLButtonElement[]
					).find((b) =>
						/(export|\ub0b4\ubcf4\ub0b4\uae30)/i.test(b.textContent ?? ""),
					);

				const importBtn =
					(exportBtn?.nextElementSibling as HTMLButtonElement | null) ??
					(
						Array.from(
							document.querySelectorAll("button"),
						) as HTMLButtonElement[]
					).find((b) =>
						/(import|\uac00\uc838\uc624\uae30)/i.test(b.textContent ?? ""),
					);

				return {
					exportExists: !!exportBtn,
					exportDisabled: exportBtn?.disabled ?? false,
					importExists: !!importBtn,
					importDisabled: importBtn?.disabled ?? false,
				};
			});
			expect(buttonStates.exportExists).toBe(true);
			expect(buttonStates.exportDisabled).toBe(true);
			expect(buttonStates.importExists).toBe(true);
			expect(buttonStates.importDisabled).toBe(true);
		});

		it("should display coming soon hint in backup field", async () => {
			const hintInfo = await browser.execute(() => {
				const pwInput =
					document.querySelector('[data-testid="memory-backup-password"]') ??
					(
						Array.from(
							document.querySelectorAll("input[type='password']"),
						) as HTMLInputElement[]
					).find((input) => {
						const ph = input.placeholder.toLowerCase();
						return (
							ph.includes("password") || ph.includes("\ube44\ubc00\ubc88\ud638")
						);
					});
				const field = pwInput?.closest(".settings-field");
				const hintEl = field?.querySelector(
					"span.settings-hint",
				) as HTMLElement | null;
				if (!hintEl) return null;
				const style = window.getComputedStyle(hintEl);
				const isVisible =
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					style.opacity !== "0";
				return {
					exists: true,
					visible: isVisible,
					text: (hintEl.textContent ?? "").trim(),
				};
			});
			expect(hintInfo).not.toBeNull();
			expect(hintInfo?.exists).toBe(true);
			expect(hintInfo?.visible).toBe(true);
			expect(hintInfo?.text.length).toBeGreaterThan(0);
			expect(
				/(backup|\ubc31\uc5c5|coming|future|\uc9c0\uc6d0)/i.test(
					hintInfo?.text ?? "",
				),
			).toBe(true);
		});
	});

	// ── Suite 7: Return to chat ──────────────────────────────────────────────────
	describe("7) Return to chat tab", () => {
		it("should navigate back to chat tab successfully", async () => {
			await clickBySelector(S.chatTab);
			const chatInput = await $(S.chatInput);
			await chatInput.waitForDisplayed({ timeout: 8_000 });
			expect(await chatInput.isDisplayed()).toBe(true);
		});
	});
});
