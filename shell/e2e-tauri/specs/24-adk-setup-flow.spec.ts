// E2E for ADK setup flow (nextain/naia-os#328).
//
// Three scenarios:
//   1. New start, empty folder       → clone → onboarding → first chat
//   2. New start, has_other_files    → new_exists branch (no "use as-is")
//                                    → delete-and-restart → clone → onboarding
//   3. Load existing ADK             → onboarding skipped → first chat
//
// SAFETY: this spec must NEVER touch the user's real `~/naia-adk`.
// All scenarios use a per-run temp directory under
// `process.env.NAIA_E2E_ADK_BASE` (default: OS temp), and clean up after
// themselves.

import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

const E2E_ADK_BASE =
	process.env.NAIA_E2E_ADK_BASE ??
	"C:\\Windows\\Temp\\naia-e2e-adk";

const API_KEY =
	process.env.CAFE_E2E_API_KEY ?? process.env.GEMINI_API_KEY ?? "";

// API_KEY is only needed by S3 (LLM round-trip). S1 and S2 verify branch +
// clone + onboarding entry without making any LLM call, so they must run
// even when the key is absent — that is the primary value we want from #325
// and #326. S3 self-skips when API_KEY is empty.

/** Per-test path so reruns do not collide. */
function tmpAdkPath(tag: string): string {
	return `${E2E_ADK_BASE}-${tag}-${Date.now()}`;
}

/** Wipe localStorage entries that gate ADK setup / onboarding. */
async function resetSetupState(): Promise<void> {
	await browser.execute(() => {
		localStorage.removeItem("naia-config");
		localStorage.removeItem("naia-remote-key");
		localStorage.removeItem("naia-remote-user-id");
		localStorage.removeItem("naia-adk-path");
	});
}

/** Invoke a Tauri command from inside the webview.
 *  Uses Tauri 2's `__TAURI_INTERNALS__` which is always present regardless of
 *  the `withGlobalTauri` setting. The frontend `invoke()` API wraps this same
 *  internal — calling it directly avoids needing a JS import in eval'd code. */
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
			const invoke =
				w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) {
				throw new Error(
					"Tauri invoke not available (neither __TAURI_INTERNALS__ nor __TAURI__.core)",
				);
			}
			return invoke(cmd, a);
		},
		command,
		args,
	)) as T;
}

/** Wait for the splash overlay to disappear so option cards become clickable. */
async function waitForSplashGone(timeout = 30_000): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(() => !document.querySelector(".splash-ring")),
		{ timeout, timeoutMsg: "splash overlay did not disappear" },
	);
}

/** Best-effort cleanup for a scenario's temp dir. */
async function safeDeleteAdk(adkPath: string): Promise<void> {
	try {
		await tauriInvoke("delete_naia_adk", { adkPath });
	} catch {
		/* ignore */
	}
}

describe("24 — ADK Setup Flow (#328)", function () {
	// clone + init + assets can take 1-3 minutes; default 60s mocha timeout
	// is too short. Override at the suite level.
	this.timeout(300_000);

	const empty = tmpAdkPath("empty");
	const hasOther = tmpAdkPath("hasother");
	const existing = tmpAdkPath("existing");

	after(async () => {
		await safeDeleteAdk(empty);
		await safeDeleteAdk(hasOther);
		await safeDeleteAdk(existing);
	});

	it("S1: new start in empty folder → onboarding entered", async () => {
		await safeDeleteAdk(empty);
		await resetSetupState();
		await safeRefresh();

		const setup = await $(S.adkSetupScreen);
		await setup.waitForDisplayed({ timeout: 30_000 });
		await waitForSplashGone();

		// First card is "신규 시작" — open new mode.
		const cards = await $$(S.adkSetupOptionCard);
		await cards[0].click();

		const input = await $(S.adkSetupInput);
		await input.waitForDisplayed({ timeout: 5_000 });
		await input.setValue(empty);

		const confirm = await $(S.adkSetupConfirmBtn);
		await confirm.click();

		// Clone + init + assets can take a while; allow generous timeout.
		const overlay = await $(S.onboardingOverlay);
		await overlay.waitForDisplayed({ timeout: 240_000 });
	});

	it("S2: folder with other files → new_exists branch (delete-only)", async () => {
		// Pre-create a non-empty folder without naia-settings/ via Tauri 2
		// internals. write_naia_asset is the cheapest existing command that
		// creates an arbitrary file inside the ADK path — but it writes
		// under naia-settings/, which would put us in the has_settings branch.
		// Instead, use init_naia_settings then delete the naia-settings dir,
		// leaving stray VRM/bgm placeholder files behind.
		await tauriInvoke<void>("init_naia_settings", { adkPath: hasOther });
		await tauriInvoke<void>("delete_naia_settings", { adkPath: hasOther });

		await resetSetupState();
		await safeRefresh();

		const setup = await $(S.adkSetupScreen);
		await setup.waitForDisplayed({ timeout: 30_000 });
		await waitForSplashGone();

		// Open new mode and enter the pre-populated path.
		const cards = await $$(S.adkSetupOptionCard);
		await cards[0].click();
		const input = await $(S.adkSetupInput);
		await input.waitForDisplayed({ timeout: 5_000 });
		await input.setValue(hasOther);
		await (await $(S.adkSetupConfirmBtn)).click();

		// Expect new_exists branch — only the "delete-and-restart" card should
		// be present (no "use as-is" because there is no naia-settings/).
		await browser.waitUntil(
			async () => {
				const headlines = await $$(S.adkSetupHeadline);
				if (headlines.length === 0) return false;
				const text = await headlines[0].getText();
				return text.includes("폴더에 파일이 있어요");
			},
			{ timeout: 15_000, timeoutMsg: "has_other_files headline not shown" },
		);

		const cardCount = (await $$(S.adkSetupOptionCard)).length;
		expect(cardCount).toBe(1); // only delete-and-restart

		// Click delete-and-restart and wait for onboarding.
		const deleteCard = (await $$(S.adkSetupOptionCard))[0];
		await deleteCard.click();
		const overlay = await $(S.onboardingOverlay);
		await overlay.waitForDisplayed({ timeout: 240_000 });
	});

	(API_KEY ? it : it.skip)("S3: load existing ADK → onboarding skipped (provider preconfigured)", async () => {
		// Build a minimal "existing ADK" by running init + copy + writing
		// provider config so onboarding skips.
		await tauriInvoke<void>("init_naia_settings", { adkPath: existing });
		await tauriInvoke<void>("copy_bundled_assets", { adkPath: existing });
		await browser.execute(
			(p: string, key: string) => {
				localStorage.setItem(
					"naia-config",
					JSON.stringify({
						workspaceRoot: p,
						provider: "gemini",
						model: "gemini-2.5-flash",
						apiKey: key,
						agentName: "Naia",
						userName: "E2E",
						vrmModel: "/avatars/01-Sendagaya-Shino-uniform.vrm",
						persona: "Friendly companion",
						enableTools: true,
						locale: "ko",
						onboardingComplete: true,
					}),
				);
				localStorage.setItem("naia-adk-path", p);
			},
			existing,
			API_KEY,
		);
		await safeRefresh();

		// ADK setup must NOT appear (path cached + config complete).
		const setupGone = await browser.execute((sel: string) => {
			return !document.querySelector(sel);
		}, S.adkSetupScreen);
		expect(setupGone).toBe(true);

		// Onboarding must NOT appear.
		const onboardingGone = await browser.execute((sel: string) => {
			return !document.querySelector(sel);
		}, S.onboardingOverlay);
		expect(onboardingGone).toBe(true);

		// First chat round-trip.
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 30_000 });
		await chatInput.setValue("hello");
		await (await $(S.chatSendBtn)).click();

		const assistant = await $(S.completedAssistantMessage);
		await assistant.waitForDisplayed({ timeout: 60_000 });
		const text = await assistant.getText();
		expect(text.length).toBeGreaterThan(0);
	});
});
