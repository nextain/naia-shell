import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("installed app metadata", () => {
	it("returns localized metadata and permissions through the real Tauri backend", async () => {
		const adk = process.env.NAIA_E2E_ADK_PATH;
		if (!adk) throw new Error("Missing isolated E2E ADK");
		const app = join(adk, ".naia", "apps", "test.bridge");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "app.json"), JSON.stringify({
			id: "test.bridge", name: "Bridge", nameKo: "연결", descriptionEn: "Description",
			thumbnailUrl: "https://example.com/preview.png", permissions: ["model.ask", "speech", "locale"],
		}));
		const apps = await browser.execute(async () => {
			const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
			return await internals.invoke("app_list_installed");
		});
		expect(apps).toEqual(expect.arrayContaining([expect.objectContaining({
			id: "test.bridge", nameKo: "연결", descriptionEn: "Description",
			thumbnailUrl: "https://example.com/preview.png", permissions: ["model.ask", "speech", "locale"],
		})]));
	});
});
