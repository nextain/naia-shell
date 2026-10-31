// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../logger";
import { resetWarnedCommands, routeCommand } from "../router";
import { createMemoryWebFs, setWebFsForTests } from "../web-fs";
import { INITIAL_WEB_WORKSPACE_CONFIG } from "../web-workspace-commands";

describe("router", () => {
	beforeEach(() => {
		resetWarnedCommands();
		vi.restoreAllMocks();
		setWebFsForTests(createMemoryWebFs());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setWebFsForTests(null);
	});

	it("returns stub values for plugin stubs and initial config for read_naia_config", async () => {
		const appVersion = await routeCommand("plugin:app|version");
		expect(appVersion).toMatch(/^0\.2\.5-dev \((?:[\da-f]+|unknown)\)$/);

		const naiaConfig = await routeCommand("read_naia_config", {
			adkPath: "opfs://naia-adk",
		});
		expect(naiaConfig).toBe(
			JSON.stringify(
				{ ...INITIAL_WEB_WORKSPACE_CONFIG, NAIA_LOCALE: "en" },
				null,
				2,
			),
		);

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
