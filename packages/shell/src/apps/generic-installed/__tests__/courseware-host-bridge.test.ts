// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeHandlers = vi.hoisted(
	() => new Map<string, (args?: Record<string, unknown>) => unknown>(),
);
const invokeCalls = vi.hoisted(
	() => [] as Array<{ cmd: string; args?: Record<string, unknown> }>,
);
const adkState = vi.hoisted(() => ({
	adkPath: "/work/naia-adk" as string | null,
	workspaceRoot: undefined as string | undefined,
}));
const setActiveAppMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "frontend_log") return undefined;
		invokeCalls.push({ cmd, args });
		const fn = invokeHandlers.get(cmd);
		if (!fn) throw new Error(`Unhandled command: ${cmd}`);
		return await fn(args);
	}),
	convertFileSrc: (path: string) =>
		`http://asset.localhost/${encodeURIComponent(path)}`,
}));

vi.mock("../../../lib/adk-store", () => ({
	getAdkPath: () => adkState.adkPath,
}));

vi.mock("../../../lib/config", () => ({
	loadConfig: () =>
		adkState.workspaceRoot ? { workspaceRoot: adkState.workspaceRoot } : null,
}));

vi.mock("../../../stores/app", () => ({
	useAppStore: {
		getState: () => ({
			activeApp: "land.naia.blackjack",
			activeAppContext: null,
			activeAppContextOwnerId: null,
			setActiveApp: setActiveAppMock,
			setActiveAppContext: vi.fn(),
		}),
		subscribe: () => () => {},
	},
	PERSISTENT_CONTEXT_TYPES: new Set(["bgm"]),
}));

import { createGenericInstalledApp } from "../GenericInstalledApp";
import {
	COURSEWARE_OPEN_PROJECTS_MSG,
	COURSEWARE_PROVISION_MSG,
	COURSEWARE_READ_FILES_MSG,
	COURSEWARE_RESULT_MSG,
	COURSEWARE_SYNC_FILES_MSG,
	installCoursewareHostBridge,
	resolveCoursewareAdkPath,
} from "../courseware-host-bridge";

const disposers: Array<() => void> = [];

beforeEach(() => {
	invokeHandlers.clear();
	invokeCalls.length = 0;
	setActiveAppMock.mockReset();
	adkState.adkPath = "/work/naia-adk";
	adkState.workspaceRoot = undefined;
});

afterEach(() => {
	cleanup();
	for (const dispose of disposers.splice(0)) {
		dispose();
	}
});

function createMountedFrame(
	appId: string,
	frameSrc = "http://asset.localhost/app",
) {
	const el = document.createElement("iframe");
	document.body.appendChild(el);
	const target = el.contentWindow!;
	const post = vi.spyOn(target, "postMessage").mockImplementation(() => {});
	const dispose = installCoursewareHostBridge(el, frameSrc, appId);
	disposers.push(dispose, () => el.remove());
	return { el, target, post };
}

function sendFromFrame(
	source: Window,
	data: Record<string, unknown>,
	origin = "http://asset.localhost",
) {
	window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}

describe("courseware-host-bridge", () => {
	it("ignores unlisted appIds, wrong origins, wrong frame sources, and mismatched appIds", () => {
		const unknownApp = createMountedFrame("land.naia.other");
		const blackjack = createMountedFrame("land.naia.blackjack");

		sendFromFrame(unknownApp.target, {
			type: COURSEWARE_PROVISION_MSG,
			id: "req-1",
			appId: "land.naia.other",
			projectSlug: "blackjack-lab",
			files: [{ path: "README.md", content: "# Hi\n" }],
		});
		sendFromFrame(
			blackjack.target,
			{
				type: COURSEWARE_PROVISION_MSG,
				id: "req-2",
				appId: "land.naia.blackjack",
				projectSlug: "blackjack-lab",
				files: [{ path: "README.md", content: "# Hi\n" }],
			},
			"https://evil.invalid",
		);
		sendFromFrame(unknownApp.target, {
			type: COURSEWARE_PROVISION_MSG,
			id: "req-3",
			appId: "land.naia.blackjack",
			projectSlug: "blackjack-lab",
			files: [{ path: "README.md", content: "# Hi\n" }],
		});
		sendFromFrame(blackjack.target, {
			type: COURSEWARE_PROVISION_MSG,
			id: "req-4",
			appId: "land.naia.nts-edu-helper",
			projectSlug: "blackjack-lab",
			files: [{ path: "README.md", content: "# Hi\n" }],
		});

		expect(invokeCalls).toHaveLength(0);
		expect(blackjack.post).not.toHaveBeenCalled();
	});

	it("provisions starter files, syncs editor changes, and reads local files back", async () => {
		const frame = createMountedFrame("land.naia.blackjack");

		invokeHandlers.set("courseware_provision_starter", () => ({
			projectDir: "/work/naia-adk/projects/naia-blackjack-studio",
			projectSlug: "naia-blackjack-studio",
			writtenFiles: ["blackjack-rules.js", "AGENTS.md"],
			skippedFiles: [],
		}));
		invokeHandlers.set("courseware_sync_files", () => ({
			project_dir: "/work/naia-adk/projects/naia-blackjack-studio",
			project_slug: "naia-blackjack-studio",
			written_files: ["blackjack-rules.js"],
			skipped_files: [],
		}));
		invokeHandlers.set("courseware_read_files", () => [
			{ path: "blackjack-rules.js", content: "// edited in OpenCode\n" },
		]);

		sendFromFrame(frame.target, {
			type: COURSEWARE_PROVISION_MSG,
			id: "prov-1",
			appId: "land.naia.blackjack",
			projectSlug: "naia-blackjack-studio",
			files: [
				{ path: "blackjack-rules.js", content: "// starter\n" },
				{ path: "AGENTS.md", content: "# Socratic Tutor\n" },
			],
			overwrite: false,
		});

		await waitFor(() => {
			expect(frame.post).toHaveBeenCalledWith(
				{
					type: COURSEWARE_RESULT_MSG,
					id: "prov-1",
					action: "provision",
					ok: true,
					data: {
						projectDir: "/work/naia-adk/projects/naia-blackjack-studio",
						projectSlug: "naia-blackjack-studio",
						writtenFiles: ["blackjack-rules.js", "AGENTS.md"],
						skippedFiles: [],
					},
				},
				"http://asset.localhost",
			);
		});

		sendFromFrame(frame.target, {
			type: COURSEWARE_SYNC_FILES_MSG,
			id: "sync-1",
			appId: "land.naia.blackjack",
			projectSlug: "naia-blackjack-studio",
			files: [{ path: "blackjack-rules.js", content: "// updated\n" }],
		});

		await waitFor(() => {
			expect(frame.post).toHaveBeenCalledWith(
				expect.objectContaining({
					type: COURSEWARE_RESULT_MSG,
					id: "sync-1",
					action: "sync-files",
					ok: true,
				}),
				"http://asset.localhost",
			);
		});

		sendFromFrame(frame.target, {
			type: COURSEWARE_READ_FILES_MSG,
			id: "read-1",
			appId: "land.naia.blackjack",
			projectSlug: "naia-blackjack-studio",
			paths: ["blackjack-rules.js"],
		});

		await waitFor(() => {
			expect(frame.post).toHaveBeenCalledWith(
				{
					type: COURSEWARE_RESULT_MSG,
					id: "read-1",
					action: "read-files",
					ok: true,
					files: [
						{ path: "blackjack-rules.js", content: "// edited in OpenCode\n" },
					],
					data: [
						{ path: "blackjack-rules.js", content: "// edited in OpenCode\n" },
					],
				},
				"http://asset.localhost",
			);
		});

		expect(invokeCalls.map((c) => c.cmd)).toEqual([
			"courseware_provision_starter",
			"courseware_sync_files",
			"courseware_read_files",
		]);
	});

	it("rejects traversal paths, missing adkPath, and invalid project slugs before invoking Tauri", () => {
		const frame = createMountedFrame("land.naia.nts-edu-helper");

		sendFromFrame(frame.target, {
			type: COURSEWARE_PROVISION_MSG,
			id: "bad-slug",
			appId: "land.naia.nts-edu-helper",
			projectSlug: "../escape",
			files: [{ path: "01-plan.md", content: "# Plan\n" }],
		});
		expect(frame.post).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: COURSEWARE_RESULT_MSG,
				id: "bad-slug",
				ok: false,
				error: "invalid_project_slug",
			}),
			"http://asset.localhost",
		);

		sendFromFrame(frame.target, {
			type: COURSEWARE_SYNC_FILES_MSG,
			id: "bad-path",
			appId: "land.naia.nts-edu-helper",
			projectSlug: "nts-ax-studio",
			files: [{ path: "../secret.md", content: "nope" }],
		});
		expect(frame.post).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: COURSEWARE_RESULT_MSG,
				id: "bad-path",
				ok: false,
				error: "invalid_files",
			}),
			"http://asset.localhost",
		);

		adkState.adkPath = null;
		adkState.workspaceRoot = "/work/mirrored-adk";
		expect(resolveCoursewareAdkPath()).toBe("/work/mirrored-adk");

		adkState.workspaceRoot = undefined;
		sendFromFrame(frame.target, {
			type: COURSEWARE_READ_FILES_MSG,
			id: "no-adk",
			appId: "land.naia.nts-edu-helper",
			projectSlug: "nts-ax-studio",
			paths: ["01-plan.md"],
		});
		expect(frame.post).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: COURSEWARE_RESULT_MSG,
				id: "no-adk",
				ok: false,
				error: "adk_not_configured",
			}),
			"http://asset.localhost",
		);
		expect(invokeCalls).toHaveLength(0);
	});

	it("dynamically wires courseware bridge in GenericInstalledApp for courseware apps", async () => {
		const AppComp = createGenericInstalledApp(
			"/work/naia-adk/apps/land.naia.nts-edu-helper/index.html",
			[],
			"land.naia.nts-edu-helper",
			["speech", "model.ask", "locale", "clipboard.write"],
		);
		const { container } = render(
			React.createElement(AppComp, {
				naia: {
					onToolCall: () => () => {},
				} as never,
			}),
		);
		const iframe = container.querySelector("iframe")!;
		expect(iframe).toBeTruthy();

		await waitFor(() => {
			sendFromFrame(iframe.contentWindow!, {
				type: COURSEWARE_OPEN_PROJECTS_MSG,
				id: "open-proj-dyn",
				appId: "land.naia.nts-edu-helper",
			});
			expect(setActiveAppMock).toHaveBeenCalledWith("projects");
		});
	});
});
