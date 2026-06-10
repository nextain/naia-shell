import { S } from "../helpers/selectors.js";

const LOCAL_VRM = "/home/luke/dev/naia-os/assets/AvatarSample_B.vrm";
const LOCAL_BG =
	"/home/luke/dev/naia-os/assets/branding/naia-app-icon-square.png";

describe("71 — local avatar file loading", () => {
	it("should load local VRM/background from absolute paths", async () => {
		await browser.execute(
			(vrmPath: string, bgPath: string) => {
				const raw = localStorage.getItem("naia-config");
				const config = raw ? JSON.parse(raw) : {};
				config.provider = config.provider || "gemini";
				config.model = config.model || "gemini-2.5-flash";
				config.apiKey = config.apiKey || "e2e-dummy-key";
				config.enableTools = true;
				config.onboardingComplete = true;
				config.vrmModel = vrmPath;
				config.backgroundImage = bgPath;
				config.customVrms = Array.from(
					new Set([...(config.customVrms || []), vrmPath]),
				);
				config.customBgs = Array.from(
					new Set([...(config.customBgs || []), bgPath]),
				);
				localStorage.setItem("naia-config", JSON.stringify(config));
			},
			LOCAL_VRM,
			LOCAL_BG,
		);

		await browser.refresh();

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 20_000 });

		await browser.waitUntil(
			async () =>
				browser.execute((expected: string) => {
					const root = document.querySelector("[data-avatar-model-path]");
					if (!root) return false;
					const model = root.getAttribute("data-avatar-model-path");
					return model === expected;
				}, LOCAL_VRM),
			{ timeout: 20_000, timeoutMsg: "Avatar model path did not update" },
		);

		try {
			await browser.waitUntil(
				async () =>
					browser.execute(() => {
						const root = document.querySelector("[data-avatar-loaded]");
						return root?.getAttribute("data-avatar-loaded") === "true";
					}),
				{ timeout: 20_000, timeoutMsg: "Local VRM did not finish loading" },
			);
		} catch (err) {
			const diagnostics = await browser.execute(() => {
				const root = document.querySelector("[data-avatar-loaded]");
				return {
					loaded: root?.getAttribute("data-avatar-loaded") ?? "",
					modelPath: root?.getAttribute("data-avatar-model-path") ?? "",
					loadError: root?.getAttribute("data-avatar-load-error") ?? "",
					loadStage: root?.getAttribute("data-avatar-load-stage") ?? "",
				};
			});
			throw new Error(
				`Local VRM did not finish loading: ${JSON.stringify(diagnostics)} (${String(err)})`,
			);
		}

		// Open settings and verify local cards are selected
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.settingsTabBtn);

		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });

		const hasActiveCustomVrm = await browser.execute((path: string) => {
			const card = document.querySelector(`.vrm-card[title="${path}"]`);
			return !!card && card.classList.contains("active");
		}, LOCAL_VRM);
		expect(hasActiveCustomVrm).toBe(true);

		const hasActiveCustomBg = await browser.execute((path: string) => {
			const card = document.querySelector(`.bg-card[title="${path}"]`);
			return !!card && card.classList.contains("active");
		}, LOCAL_BG);
		expect(hasActiveCustomBg).toBe(true);
	});
});
