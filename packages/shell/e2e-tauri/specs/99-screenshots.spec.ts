import * as fs from "node:fs";
import * as path from "node:path";
import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

/**
 * 99 — Screenshot Capture for Manual
 *
 * Navigates through all app screens and captures screenshots
 * for the user manual on naia.nextain.io.
 *
 * Run: pnpm run test:e2e:tauri --spec e2e-tauri/specs/99-screenshots.spec.ts
 *
 * Screenshots are saved to: naia.nextain.io/public/manual/ko/
 */

const MANUAL_DIR = path.resolve(
	import.meta.dirname,
	"../../../../naia.nextain.io/public/manual/ko",
);

async function screenshot(name: string): Promise<void> {
	fs.mkdirSync(MANUAL_DIR, { recursive: true });
	const filepath = path.join(MANUAL_DIR, `${name}.png`);

	// Force a reflow and wait for paints
	await browser.execute(() => {
		window.dispatchEvent(new Event("resize"));
		document.body.style.display = "none";
		document.body.offsetHeight; // force reflow
		document.body.style.display = "";
	});
	await browser.pause(1000);

	await browser.saveScreenshot(filepath);

	const stats = fs.statSync(filepath);
	if (stats.size < 40000) {
		console.log(
			`[screenshot] WARNING: ${name}.png is too small (${stats.size} bytes). Retrying with longer wait...`,
		);
		await browser.pause(2000);
		await browser.saveScreenshot(filepath);
	}

	console.log(
		`[screenshot] Saved: ${filepath} (${fs.statSync(filepath).size} bytes)`,
	);
}

async function clickTab(selector: string): Promise<void> {
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (el) el.click();
	}, selector);
	await browser.pause(1500); // Wait longer for transition animations
}

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";

describe("99 — manual screenshots", () => {
	before(async () => {
		// Set the exact resolution requested by the master (400x768)
		// This also helps stabilize the WebKitGTK rendering pipeline during capture
		try {
			await browser.setWindowSize(400, 768);
		} catch (e) {
			console.log(
				"[screenshot] Note: setWindowSize failed, trying to continue",
				e,
			);
		}

		// Bypass onboarding
		await browser.execute((key: string) => {
			const config = {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: key,
				agentName: "AI 아바타",
				userName: "Tester",
				vrmModel: "/avatars/01-Sendagaya-Shino-uniform.vrm",
				persona: "Friendly AI companion",
				enableTools: true,
				onboardingComplete: true,
				locale: "ko",
				gatewayUrl: "ws://localhost:18789",
				gatewayToken: "naia-dev-token",
			};
			localStorage.setItem("naia-config", JSON.stringify(config));
		}, API_KEY);
		await safeRefresh();

		// Wait for app to fully load
		try {
			const chatInput = await $(S.chatInput);
			await chatInput.waitForDisplayed({ timeout: 30_000 });
		} catch {
			// App may not load fully in screenshot session — continue with best effort
		}
	});

	it("should capture main screen", async () => {
		try {
			const chatInput = await $(S.chatInput);
			await chatInput.waitForDisplayed({ timeout: 15_000 });
		} catch {
			// best effort
		}
		await browser.pause(1000);
		await screenshot("main-screen");
	});

	it("should capture chat text input", async () => {
		try {
			const chatInput = await $(S.chatInput);
			await chatInput.waitForEnabled({ timeout: 10_000 });
			await browser.execute((sel: string) => {
				const el = document.querySelector(sel) as HTMLTextAreaElement;
				if (el) {
					const nativeSetter = Object.getOwnPropertyDescriptor(
						HTMLTextAreaElement.prototype,
						"value",
					)?.set;
					if (nativeSetter) nativeSetter.call(el, "서울 날씨 알려줘");
					el.dispatchEvent(new Event("input", { bubbles: true }));
				}
			}, S.chatInput);
			await browser.pause(300);
		} catch {
			// best effort
		}
		await screenshot("chat-text");

		// Clear input
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLTextAreaElement;
			if (el) {
				const nativeSetter = Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)?.set;
				if (nativeSetter) nativeSetter.call(el, "");
				el.dispatchEvent(new Event("input", { bubbles: true }));
			}
		}, S.chatInput);
	});

	it("should capture history tab", async () => {
		await clickTab(S.historyTab);
		try {
			// Wait for data or empty state to render
			await browser.waitUntil(
				async () => {
					return await browser.execute(
						(s1: string, s2: string) =>
							!!document.querySelector(s1) || !!document.querySelector(s2),
						S.historyItem,
						S.historyEmpty,
					);
				},
				{ timeout: 5000 },
			);
		} catch {}
		await screenshot("history-tab");
	});

	it("should capture progress tab", async () => {
		await clickTab(S.progressTabBtn);
		try {
			await browser.waitUntil(
				async () => {
					return await browser.execute(
						() =>
							!!document.querySelector(".progress-event-item") ||
							!!document.querySelector(".diagnostics-status-grid"),
					);
				},
				{ timeout: 5000 },
			);
		} catch {}
		await screenshot("progress-tab");
	});

	it("should capture skills tab", async () => {
		await clickTab(S.skillsTab);
		try {
			await $(S.skillsCard).waitForDisplayed({ timeout: 5000 });
		} catch {}
		await screenshot("skills-tab");
	});

	it("should capture channels tab", async () => {
		await clickTab(S.channelsTabBtn);
		try {
			await browser.waitUntil(
				async () => {
					return await browser.execute(
						(sel: string) => !document.querySelector(sel),
						".channels-loading",
					);
				},
				{ timeout: 10000 },
			);
		} catch {}
		await screenshot("channels-tab");
	});

	it("should capture agents tab", async () => {
		await clickTab(S.agentsTabBtn);
		try {
			await $(S.agentCard).waitForDisplayed({ timeout: 5000 });
		} catch {}
		await screenshot("agents-tab");
	});

	it("should capture diagnostics tab", async () => {
		await clickTab(S.diagnosticsTabBtn);
		try {
			await $(".diagnostics-status-grid").waitForDisplayed({ timeout: 5000 });
		} catch {}
		await screenshot("diagnostics-tab");
	});
	it("should capture skills card expanded", async () => {
		// Click first skill card to expand
		await browser.execute((cardSel: string) => {
			const card = document.querySelector(cardSel);
			const header = card?.querySelector(
				".skill-card-header",
			) as HTMLElement | null;
			if (header) header.click();
		}, S.skillsCard);
		await browser.pause(300);
		await screenshot("skills-card");

		// Collapse
		await browser.execute((cardSel: string) => {
			const card = document.querySelector(cardSel);
			const header = card?.querySelector(
				".skill-card-header",
			) as HTMLElement | null;
			if (header) header.click();
		}, S.skillsCard);
	});

	it("should capture settings tab overview", async () => {
		await clickTab(S.settingsTabBtn);
		await screenshot("settings-overview");
	});

	it("should capture settings theme section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".theme-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-theme");
	});

	it("should capture settings avatar section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".avatar-section, .vrm-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-avatar");
	});

	it("should capture settings AI section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".ai-section, .provider-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-ai");
	});

	it("should capture settings voice section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".voice-section, .tts-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-voice");
	});

	it("should capture settings tools section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".tools-section, .gateway-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-tools");
	});

	it("should capture settings channels section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".channels-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-channels");
	});

	it("should capture settings device section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".device-section, .device-nodes-list");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-device");
	});

	it("should capture settings lab section", async () => {
		await browser.execute(() => {
			const el = document.querySelector(".lab-info-block, .lab-section");
			if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
		});
		await browser.pause(300);
		await screenshot("settings-lab-connected");
	});

	it("should capture tabs layout", async () => {
		await clickTab(S.chatTab);
		await screenshot("tabs-layout");
	});
});
