// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import {
	IEUMOFFICE_APP_ID,
	installIeumOfficeHostBridge,
} from "../../apps/generic-installed/ieumoffice-host-bridge";
import {
	buildFallbackNaiaPreset,
	detectIeumOfficeStatus,
	setIeumOfficeMcpEnabled,
} from "../ieumoffice-mcp";
import {
	isModelFacingToolAllowed,
	setIeumOfficeMcpToolsAllowed,
} from "../model-facing-tools";

describe("ieumoffice-mcp shell integration & model tool boundary (#870)", () => {
	afterEach(() => {
		mockInvoke.mockReset();
		setIeumOfficeMcpToolsAllowed(false);
		localStorage.clear();
	});

	it("allows mcp__ieumoffice__* tools only when IeumOffice MCP is active while keeping generic mcp__* blocked", async () => {
		expect(isModelFacingToolAllowed("mcp__ieumoffice__docs_edit")).toBe(false);
		expect(isModelFacingToolAllowed("mcp__server__tool")).toBe(false);

		const connectedStatus = {
			installed: true,
			binaryPath: "/usr/local/bin/ieumoffice",
			version: "0.10.0",
			mcpEnabled: true,
			autoConnected: true,
			mcpLaunch: { command: "/usr/local/bin/ieumoffice", args: ["mcp"] },
			officialRepoUrl: "https://github.com/pblsketch/ieumoffice",
			officialReleasesUrl: "https://github.com/pblsketch/ieumoffice/releases",
			officialSiteUrl: "https://ieumoffice.com",
			naiaPreset: buildFallbackNaiaPreset(),
		};

		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "ieumoffice_detect_status") return connectedStatus;
			if (cmd === "ieumoffice_set_mcp_enabled") {
				return {
					...connectedStatus,
					mcpEnabled: false,
					autoConnected: false,
				};
			}
			return undefined;
		});

		const status = await detectIeumOfficeStatus();
		expect(status.installed).toBe(true);
		expect(isModelFacingToolAllowed("mcp__ieumoffice__docs_edit")).toBe(true);
		expect(isModelFacingToolAllowed("mcp__server__tool")).toBe(false);

		await setIeumOfficeMcpEnabled(false);
		expect(isModelFacingToolAllowed("mcp__ieumoffice__docs_edit")).toBe(false);
	});

	it("enforces appId, source window, and origin on installIeumOfficeHostBridge", async () => {
		const frame = document.createElement("iframe");
		const postSpy = vi.fn();
		Object.defineProperty(frame, "contentWindow", {
			value: { postMessage: postSpy },
			configurable: true,
		});

		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "ieumoffice_detect_status") {
				return {
					installed: true,
					binaryPath:
						"/Applications/IeumOffice.app/Contents/Resources/cli/ieumoffice",
					version: "0.12.12",
					mcpEnabled: true,
					autoConnected: true,
					officialRepoUrl: "https://github.com/pblsketch/ieumoffice",
					officialReleasesUrl:
						"https://github.com/pblsketch/ieumoffice/releases",
					officialSiteUrl: "https://ieumoffice.com",
					naiaPreset: buildFallbackNaiaPreset(),
				};
			}
			return undefined;
		});

		const dispose = installIeumOfficeHostBridge(
			frame,
			"http://asset.localhost/apps/land.naia.ieumoffice/index.html",
			IEUMOFFICE_APP_ID,
		);

		// Untrusted origin is ignored
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: "https://evil.example",
				source: frame.contentWindow,
				data: { type: "naia-ieumoffice:get-status", id: "req-bad" },
			}),
		);
		expect(
			mockInvoke.mock.calls.some(([cmd]) => cmd === "ieumoffice_detect_status"),
		).toBe(false);

		// Trusted asset origin & source succeeds
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: "http://asset.localhost",
				source: frame.contentWindow,
				data: { type: "naia-ieumoffice:get-status", id: "req-ok" },
			}),
		);

		await vi.waitFor(() => {
			expect(postSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "naia-ieumoffice:result",
					id: "req-ok",
					ok: true,
				}),
				"http://asset.localhost",
			);
		});

		dispose();
	});
});
