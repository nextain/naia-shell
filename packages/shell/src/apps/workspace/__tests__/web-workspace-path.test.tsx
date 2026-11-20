// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCenterProps } from "../../../lib/app-registry";
import { setLocale } from "../../../lib/i18n";
import {
	resetWebAdkStatusForTests,
	setWebAdkStatus,
} from "../../../lib/web-runtime/web-adk-status";
import { setWebAssetsModeForTests } from "../../../lib/web-runtime/web-assets";
import { WEB_BGM_MUSIC_CHANGED_EVENT } from "../../../lib/web-runtime/web-bgm-music";
import {
	getWebWorkspaceFile,
	importWebWorkspaceFile,
	openWebWorkspaceImportRoot,
} from "../../../lib/web-runtime/web-workspace-files";
import WebWorkspace, {
	isVisibleWebWorkspaceEntry,
	sortWebWorkspaceEntries,
} from "../WebWorkspace";
import { DeferredHerdrWorkspaceCenterArea } from "../index";

describe("web workspace path", () => {
	afterEach(() => {
		cleanup();
		localStorage.removeItem("naia-adk-path");
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		resetWebAdkStatusForTests();
	});

	function installImportStorage(
		files: Map<string, File>,
		temporary = new Map<string, File>(),
	) {
		let failWrite = false;
		function mockDirectory(directoryName: string, contents: Map<string, File>) {
			const directory = {
				kind: "directory",
				name: directoryName,
				async *values() {
					for (const name of contents.keys()) yield { kind: "file", name };
				},
				isSameEntry: async (candidate: unknown) => candidate === directory,
				async getFileHandle(name: string, options?: { create?: boolean }) {
					if (!contents.has(name) && !options?.create)
						throw new DOMException("Missing file", "NotFoundError");
					return {
						getFile: async () => contents.get(name),
						createWritable: async () => ({
							write: async (file: File) => {
								contents.set(name, file);
								if (failWrite)
									throw new DOMException("Storage full", "QuotaExceededError");
							},
							close: async () => {},
							abort: async () => {},
						}),
						move: async (destination: unknown, nextName: string) => {
							expect(destination).toBe(work);
							files.set(nextName, contents.get(name)!);
							contents.delete(name);
						},
					};
				},
				removeEntry: async (name: string) => {
					contents.delete(name);
				},
			};
			return directory;
		}
		const work = mockDirectory("work", files);
		const staging = mockDirectory("naia-workspace-import-staging", temporary);
		const workspace = {
			getDirectoryHandle: async () => work,
			async *values() {
				yield work;
			},
		};
		vi.stubGlobal("navigator", {
			storage: {
				getDirectory: async () => ({
					getDirectoryHandle: async (name: string) =>
						name === staging.name ? staging : workspace,
				}),
			},
			locks: { request: async (_name: string, task: () => unknown) => task() },
		});
		setWebAdkStatus({ phase: "ready" });
		return { failWrite: () => { failWrite = true; } };
	}

	it("stores the imported file under the displayed work folder and preserves a same-name file", async () => {
		await setLocale("ko");
		const original = new File(["original"], "회의.txt");
		const incoming = new File(["new"], "회의.txt");
		const files = new Map([["회의.txt", original]]);
		installImportStorage(files);
		const { container } = render(<WebWorkspace />);

		const choose = screen.getByRole("button", { name: "작업 폴더 선택" });
		const upload = screen.getByRole("button", { name: "파일 가져오기" });
		expect(upload).toBeDisabled();
		await waitFor(() => expect(choose).toBeEnabled());
		fireEvent.click(choose);
		expect(await screen.findByTestId("web-workspace-import-destination")).toHaveTextContent("저장 위치 work");
		fireEvent.click(upload);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [incoming] },
		});
		expect(await screen.findByRole("button", { name: /회의 \(2\)\.txt/ })).toBeVisible();
		expect(await getWebWorkspaceFile("opfs://naia-adk/work/회의.txt")).toBe(original);
		expect(await getWebWorkspaceFile("opfs://naia-adk/work/회의 (2).txt")).toBe(incoming);
	});

	it("keeps existing data after a failed work-folder write and blocks other destinations", async () => {
		const original = new File(["original"], "memo.txt");
		const leftover = "12a34b56-2080-4000-8000-123456789000";
		const userFile = new File(["old"], `.naia-workspace-import-${leftover}`);
		const files = new Map([
			["memo.txt", original],
			[userFile.name, userFile],
			[leftover, new File(["also a user file"], leftover)],
		]);
		const before = [...files.entries()];
		const stagedFiles = new Map([[leftover, new File(["partial"], leftover)]]);
		const storage = installImportStorage(files, stagedFiles);
		const target = await openWebWorkspaceImportRoot();
		const incoming = new File(["new"], "memo.txt");
		expect(isVisibleWebWorkspaceEntry(userFile.name, "opfs://naia-adk/work")).toBe(true);
		expect(await getWebWorkspaceFile(`opfs://naia-adk/work/${userFile.name}`)).toBe(userFile);
		await expect(
			importWebWorkspaceFile({ ...target, path: "opfs://naia-adk/naia-settings" }, incoming),
		).rejects.toMatchObject({ name: "InvalidCharacterError" });
		await expect(
			importWebWorkspaceFile({ ...target, directory: { ...target.directory } }, incoming),
		).rejects.toMatchObject({ name: "NotFoundError" });
		storage.failWrite();
		await expect(importWebWorkspaceFile(target, incoming)).rejects.toMatchObject({
			name: "QuotaExceededError",
		});
		expect([...files.entries()]).toEqual(before);
		expect(stagedFiles.size).toBe(0);
	});

	it("R34 refreshes an open bgm-musics folder when music is added and removed", async () => {
		await setLocale("ko");
		let songPresent = false;
		const music = {
			name: "bgm-musics",
			kind: "directory",
			async *values() {
				if (songPresent) yield { name: "새 노래.wav", kind: "file" };
			},
		};
		const settings = {
			name: "naia-settings",
			kind: "directory",
			async *values() {
				if (songPresent) yield music;
			},
			async getDirectoryHandle() {
				if (!songPresent) throw new DOMException("Missing directory", "NotFoundError");
				return music;
			},
		};
		const workspace = {
			getDirectoryHandle: async () => settings,
			async *values() { yield settings; },
		};
		vi.stubGlobal("navigator", {
			storage: {
				getDirectory: async () => ({ getDirectoryHandle: async () => workspace }),
			},
		});
		setWebAdkStatus({ phase: "ready" });
		render(<WebWorkspace />);
		fireEvent.click(await screen.findByText("📁 naia-settings"));
		fireEvent.click(await screen.findByText("📁 bgm-musics"));
		expect(await screen.findByText(/아직 음악이 없습니다/)).toBeVisible();

		songPresent = true;
		act(() => { window.dispatchEvent(new Event(WEB_BGM_MUSIC_CHANGED_EVENT)); });
		expect(await screen.findByRole("button", { name: /새 노래\.wav/ })).toBeVisible();
		songPresent = false;
		act(() => { window.dispatchEvent(new Event(WEB_BGM_MUSIC_CHANGED_EVENT)); });
		expect(await screen.findByText(/아직 음악이 없습니다/)).toBeVisible();
	});

	it("shows the configured browser workspace path", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-adk-path", "opfs://naia-adk");
		render(<DeferredHerdrWorkspaceCenterArea {...({} as AppCenterProps)} />);
		expect(screen.getByTestId("web-workspace-path")).toHaveTextContent("opfs://naia-adk");
	});

	it("does not display a stale native path as a browser workspace", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-adk-path", "/native/stale");
		render(<DeferredHerdrWorkspaceCenterArea {...({} as AppCenterProps)} />);
		expect(screen.queryByTestId("web-workspace-path")).toBeNull();
	});

	it("FR-WEB-KIOSK-R3.5~8 removes online button, rewords offline label, filters internal ADK files, and exposes knowledge tab + resizer in kiosk mode", async () => {
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");

		for (const hidden of [
			"naia-settings",
			"projects",
			"CLAUDE.md",
			"GEMINI.md",
			"README.md",
			"agents-rules-detail.json",
			"persona",
			"conversations",
			"kiosk-demo",
			".bundle",
		]) {
			expect(isVisibleWebWorkspaceEntry(hidden, "opfs://naia-adk", true)).toBe(
				false,
			);
		}
		for (const allowedRoot of [
			"AGENTS.md",
			"rules",
			"memory",
			"knowledge",
			".agents",
			".users",
			"slides",
		]) {
			expect(
				isVisibleWebWorkspaceEntry(allowedRoot, "opfs://naia-adk", true),
			).toBe(true);
		}
		expect(
			sortWebWorkspaceEntries(
				[
					{ name: "slides", kind: "directory" },
					{ name: "knowledge", kind: "directory" },
					{ name: "memory", kind: "directory" },
				],
				"opfs://naia-adk",
				true,
			).map((e) => e.name),
		).toEqual(["memory", "knowledge", "slides"]);
		expect(
			isVisibleWebWorkspaceEntry("naia.md", "opfs://naia-adk/knowledge", true),
		).toBe(true);
		await expect(
			getWebWorkspaceFile("opfs://naia-adk/.bundle/knowledge/naia.md"),
		).rejects.toThrow("web_workspace_invalid_path");

		await expect(
			getWebWorkspaceFile("opfs://naia-adk/.agents/skills/manage-discord-sessions/SKILL.md"),
		).rejects.toThrow("web_workspace_invalid_path");
		await expect(
			getWebWorkspaceFile("opfs://naia-adk/CLAUDE.md"),
		).rejects.toThrow("web_workspace_invalid_path");
		await expect(
			getWebWorkspaceFile("opfs://naia-adk/knowledge/../naia-settings/x.json"),
		).rejects.toThrow("web_workspace_invalid_path");

		render(<WebWorkspace />);
		expect(screen.queryByRole("button", { name: "파일 가져오기" })).toBeNull();
		expect(
			screen.getByTestId("web-workspace-tab-offline"),
		).toHaveTextContent("브라우저 안 오프라인 공간");
		expect(screen.queryByText(/온라인/)).toBeNull();

		// 지식은 knowledge 폴더 하나로만 보인다: 탐색기에 따로 둔 "지식" 탭은 없다.
		expect(screen.queryByTestId("web-workspace-tab-knowledge")).toBeNull();
		expect(screen.queryByTestId("web-workspace-knowledge-list")).toBeNull();

		// AGENTS.md (지나가 실제로 읽는 글) is open by default in the viewer when WebWorkspace mounts in kiosk mode
		expect(screen.getByTestId("web-workspace-resizer")).toBeInTheDocument();
		const viewer = screen.getByTestId("web-workspace-viewer");
		const barCode = viewer.querySelector(".web-workspace-viewer-bar code");
		expect(barCode?.textContent).toBe("AGENTS.md");
		expect(barCode?.getAttribute("title")).toBe(
			"opfs://naia-adk/AGENTS.md",
		);
	});

	it("defaults file explorer to closed on mobile portrait and allows toggling open and closed", async () => {
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const origInnerWidth = window.innerWidth;
		const origInnerHeight = window.innerHeight;
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 412,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 915,
		});
		try {
			render(<WebWorkspace />);
			// Closed by default on mobile portrait when a file is open
			expect(screen.queryByTestId("web-workspace-tree")).toBeNull();
			const toggleBtn = screen.getByTestId("web-workspace-tree-toggle");
			expect(toggleBtn).toHaveAttribute("aria-expanded", "false");

			// Open file explorer
			fireEvent.click(toggleBtn);
			expect(screen.getByTestId("web-workspace-tree")).toBeInTheDocument();
			expect(toggleBtn).toHaveAttribute("aria-expanded", "true");

			// Collapse via tree header button
			fireEvent.click(screen.getByTestId("web-workspace-tree-collapse"));
			expect(screen.queryByTestId("web-workspace-tree")).toBeNull();
			expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
		} finally {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: origInnerWidth,
			});
			Object.defineProperty(window, "innerHeight", {
				configurable: true,
				value: origInnerHeight,
			});
		}
	});

	it("does not mutate layout storage keys when toggling explorer and closes explorer tree when switching to portrait orientation", async () => {
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");

		localStorage.setItem("naia:layoutOrientation", "landscape");
		localStorage.setItem("naia:chatHeightRatio", "0.64");
		localStorage.setItem("naia:naiaWidth", "280");
		localStorage.setItem("naia:chatMode", "workspace");
		localStorage.setItem("naia:railCollapsed", "true");

		const { container } = render(<WebWorkspace />);
		const toggleBtn = screen.getByTestId("web-workspace-tree-toggle");

		// Toggle explorer closed then open on desktop landscape
		fireEvent.click(toggleBtn);
		expect(container.querySelector(".web-workspace--tree-closed")).not.toBeNull();
		fireEvent.click(toggleBtn);
		expect(container.querySelector(".web-workspace--tree-open")).not.toBeNull();

		// Switching orientation to portrait closes the explorer tree so the viewer fills 100%
		act(() => {
			window.dispatchEvent(
				new CustomEvent("naia:layout-orientation-change", {
					detail: "portrait",
				}),
			);
		});
		expect(screen.getByTestId("web-workspace-tree-toggle")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(container.querySelector(".web-workspace--tree-closed")).not.toBeNull();

		// All user layout settings remain intact
		expect(localStorage.getItem("naia:layoutOrientation")).toBe("landscape");
		expect(localStorage.getItem("naia:chatHeightRatio")).toBe("0.64");
		expect(localStorage.getItem("naia:naiaWidth")).toBe("280");
		expect(localStorage.getItem("naia:chatMode")).toBe("workspace");
		expect(localStorage.getItem("naia:railCollapsed")).toBe("true");
	});

	it("R17 imports an .nva file into work/ even without FileSystemFileHandle.move and shows binary preview instead of text editor", async () => {
		await setLocale("ko");
		const files = new Map<string, File>();
		const stagingFiles = new Map<string, File>();
		function mockDirWithoutMove(
			directoryName: string,
			contents: Map<string, File>,
		) {
			const directory = {
				kind: "directory",
				name: directoryName,
				async *values() {
					for (const name of contents.keys()) yield { kind: "file", name };
				},
				isSameEntry: async (candidate: unknown) => candidate === directory,
				async getFileHandle(name: string, options?: { create?: boolean }) {
					if (!contents.has(name) && !options?.create)
						throw new DOMException("Missing file", "NotFoundError");
					return {
						getFile: async () => contents.get(name),
						createWritable: async () => ({
							write: async (file: File) => {
								contents.set(name, file);
							},
							close: async () => {},
							abort: async () => {},
						}),
					};
				},
				removeEntry: async (name: string) => {
					contents.delete(name);
				},
			};
			return directory;
		}
		const work = mockDirWithoutMove("work", files);
		const staging = mockDirWithoutMove(
			"naia-workspace-import-staging",
			stagingFiles,
		);
		const workspace = {
			getDirectoryHandle: async () => work,
			async *values() {
				yield work;
			},
		};
		vi.stubGlobal("navigator", {
			storage: {
				getDirectory: async () => ({
					getDirectoryHandle: async (name: string) =>
						name === staging.name ? staging : workspace,
				}),
			},
			locks: { request: async (_name: string, task: () => unknown) => task() },
		});
		setWebAdkStatus({ phase: "ready" });

		const nvaIncoming = new File(["PK\x03\x04binary-nva"], "내 아바타.nva", {
			type: "application/zip",
		});
		const { container } = render(<WebWorkspace />);
		const choose = screen.getByRole("button", { name: "작업 폴더 선택" });
		const upload = screen.getByRole("button", { name: "파일 가져오기" });
		await waitFor(() => expect(choose).toBeEnabled());
		fireEvent.click(choose);
		expect(
			await screen.findByTestId("web-workspace-import-destination"),
		).toHaveTextContent("저장 위치 work");
		fireEvent.click(upload);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [nvaIncoming] },
		});

		const uploadedRow = await screen.findByRole("button", {
			name: /내 아바타\.nva/,
		});
		expect(uploadedRow).toBeVisible();
		expect(stagingFiles.size).toBe(0);
		expect(await getWebWorkspaceFile("opfs://naia-adk/work/내 아바타.nva")).toBe(
			nvaIncoming,
		);

		fireEvent.click(uploadedRow);
		expect(await screen.findByText(/미리 볼 수 없습니다/)).toBeVisible();
		expect(screen.getByRole("button", { name: "내려받기" })).toBeVisible();
	});
});
