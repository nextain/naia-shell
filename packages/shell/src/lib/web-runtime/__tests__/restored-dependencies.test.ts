// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../i18n";
import { emitWebEvent, handleEventListen, handleEventUnlisten, registerCallback, resetEventBus } from "../event-bus";
import { WEB_ADK_PATH, webAdkOpfsPath } from "../web-adk-path";
import { WEB_BACKGROUND_ASSETS } from "../web-assets";

afterEach(() => resetEventBus());

describe("restored web dependencies", () => {
	it("delivers matching events with their id and stops after unlisten", () => {
		const listener = vi.fn();
		const id = handleEventListen({ event: "naia_auth_complete", handler: registerCallback(listener) });
		emitWebEvent("other", { ignored: true });
		emitWebEvent("naia_auth_complete", { userId: "user-1" });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({ event: "naia_auth_complete", id, payload: { userId: "user-1" } });
		handleEventUnlisten({ event: "naia_auth_complete", eventId: id });
		emitWebEvent("naia_auth_complete", {});
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("resolves the web workspace root and relative paths consistently", () => {
		expect(webAdkOpfsPath(WEB_ADK_PATH)).toBe("naia-adk");
		expect(webAdkOpfsPath(`${WEB_ADK_PATH}/knowledge/card.md`)).toBe("naia-adk/knowledge/card.md");
		expect(webAdkOpfsPath("/knowledge/card.md")).toBe("naia-adk/knowledge/card.md");
		expect(webAdkOpfsPath("naia-adk/knowledge/card.md")).toBe("naia-adk/knowledge/card.md");
	});

	it("shows background names in the selected language and updates existing catalog entries", async () => {
		const previous = getLocale();
		try {
			await setLocale("en");
			expect(WEB_BACKGROUND_ASSETS[0].label).toBe("Dawn city");
			await setLocale("ko");
			expect(WEB_BACKGROUND_ASSETS[0].label).toBe("새벽 도시");
			expect(WEB_BACKGROUND_ASSETS.every((asset) => typeof asset.label === "string" && asset.label.length > 0)).toBe(true);
		} finally {
			await setLocale(previous);
		}
	});
});
