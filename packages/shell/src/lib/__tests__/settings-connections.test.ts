import { describe, expect, it } from "vitest";
import { isConnectionsTabEnabled } from "../settings-connections";

describe("isConnectionsTabEnabled", () => {
	it("enables the tab in native Tauri", () => {
		expect(
			isConnectionsTabEnabled({ isTauri: true, search: "", isDev: false }),
		).toBe(true);
	});

	it("keeps the browser product tab disabled without the preview query", () => {
		expect(
			isConnectionsTabEnabled({ isTauri: false, search: "", isDev: true }),
		).toBe(false);
	});

	it("enables the browser preview when the query is set", () => {
		expect(
			isConnectionsTabEnabled({
				isTauri: false,
				search: "?naiaPreview=discord-connections",
				isDev: true,
			}),
		).toBe(true);
	});
});
