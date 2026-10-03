// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../logger";
import { resetWarnedCommands, routeCommand } from "../router";

describe("router", () => {
	beforeEach(() => {
		resetWarnedCommands();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns identical stub values as tauri-base-mock for two or more commands", async () => {
		const appVersion = await routeCommand("plugin:app|version");
		expect(appVersion).toBe("0.1.3");

		const naiaConfig = await routeCommand("read_naia_config");
		expect(naiaConfig).toBeNull();

		const storeLoad = await routeCommand("plugin:store|load");
		expect(storeLoad).toBe(1);
	});

	it("rejects unlisted commands and desktop-only commands with desktop_only:<cmd> and logs warn once per command", async () => {
		const warnSpy = vi.spyOn(Logger, "warn").mockImplementation(() => {});

		// 1. Unlisted command
		const unlistedCmd = "unlisted_dummy_cmd";
		await expect(routeCommand(unlistedCmd)).rejects.toThrowError(
			`desktop_only:${unlistedCmd}`,
		);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenLastCalledWith(
			"WebRuntime",
			`desktop_only:${unlistedCmd}`,
		);

		// Call same unlisted command again: warn should not be called again
		await expect(routeCommand(unlistedCmd)).rejects.toThrowError(
			`desktop_only:${unlistedCmd}`,
		);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		// 2. Desktop-only command
		const desktopOnlyCmd = "reboot_computer";
		await expect(routeCommand(desktopOnlyCmd)).rejects.toThrowError(
			`desktop_only:${desktopOnlyCmd}`,
		);
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenLastCalledWith(
			"WebRuntime",
			`desktop_only:${desktopOnlyCmd}`,
		);

		// Call same desktop-only command again: warn should not be called again
		await expect(routeCommand(desktopOnlyCmd)).rejects.toThrowError(
			`desktop_only:${desktopOnlyCmd}`,
		);
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});
