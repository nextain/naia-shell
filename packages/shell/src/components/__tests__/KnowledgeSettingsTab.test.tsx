// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: (...args: unknown[]) => mockOpen(...args),
}));

vi.mock("../../lib/adk-store", () => ({ getAdkPath: () => "/adk" }));

import { KnowledgeSettingsTab } from "../KnowledgeSettingsTab";

function defaultInvoke(empty = true) {
	return async (cmd: string) => {
		if (cmd === "read_naia_knowledge_config")
			return empty
				? ""
				: JSON.stringify({
						version: 1,
						scope: "default",
						sources: [{ path: "/docs/gov" }],
					});
		if (cmd === "read_naia_knowledge_kb") return "";
		return undefined;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockInvoke.mockImplementation(defaultInvoke(true));
});
afterEach(() => cleanup());

describe("KnowledgeSettingsTab (FR-KB-OS.5~8 — 설정 지식 탭 관리)", () => {
	it("초기: 빈 config → 스코프 default·소스 없음 안내·컴파일 비활성", async () => {
		render(<KnowledgeSettingsTab />);
		await waitFor(() =>
			expect(screen.getByTestId("knowledge-scope").textContent).toBe("default"),
		);
		expect(screen.queryByTestId("knowledge-source-list")).toBeNull();
		expect(
			(screen.getByTestId("knowledge-compile") as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("폴더 추가 → 목록 표시 + write_naia_knowledge_config 호출", async () => {
		mockOpen.mockResolvedValue("/docs/gov");
		render(<KnowledgeSettingsTab />);
		await waitFor(() =>
			expect(screen.getByTestId("knowledge-scope").textContent).toBe("default"),
		);

		fireEvent.click(screen.getByTestId("knowledge-add-folder"));

		await waitFor(() => {
			const list = screen.getByTestId("knowledge-source-list");
			expect(list.querySelector('[data-path="/docs/gov"]')).toBeTruthy();
		});
		expect(mockInvoke).toHaveBeenCalledWith(
			"write_naia_knowledge_config",
			expect.objectContaining({
				adkPath: "/adk",
				json: expect.stringContaining("/docs/gov"),
			}),
		);
		// 소스 생기면 컴파일 활성
		expect(
			(screen.getByTestId("knowledge-compile") as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("취소(다이얼로그 null) → 변경 없음", async () => {
		mockOpen.mockResolvedValue(null);
		render(<KnowledgeSettingsTab />);
		await waitFor(() =>
			expect(screen.getByTestId("knowledge-scope").textContent).toBe("default"),
		);
		fireEvent.click(screen.getByTestId("knowledge-add-folder"));
		await Promise.resolve();
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"write_naia_knowledge_config",
			expect.anything(),
		);
	});

	it("기존 소스 로드 → 제거 시 목록에서 사라지고 write 호출", async () => {
		mockInvoke.mockImplementation(defaultInvoke(false));
		render(<KnowledgeSettingsTab />);
		await waitFor(() =>
			expect(
				screen
					.getByTestId("knowledge-source-list")
					.querySelector('[data-path="/docs/gov"]'),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByTestId("knowledge-source-remove"));
		await waitFor(() =>
			expect(screen.queryByTestId("knowledge-source-list")).toBeNull(),
		);
		expect(mockInvoke).toHaveBeenCalledWith(
			"write_naia_knowledge_config",
			expect.anything(),
		);
	});

	it("컴파일 성공 → compile_knowledge 호출 후 상태(통계) 재조회", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "read_naia_knowledge_config")
				return JSON.stringify({
					version: 1,
					scope: "default",
					sources: [{ path: "/docs/gov" }],
				});
			if (cmd === "read_naia_knowledge_kb")
				return JSON.stringify({
					version: 1,
					kb: {
						cards: [{ id: "c1", status: "accepted" }],
						entities: [{ id: "e1" }],
						relations: [],
					},
				});
			if (cmd === "compile_knowledge") return undefined;
			return undefined;
		});
		render(<KnowledgeSettingsTab />);
		await waitFor(() =>
			expect(
				screen
					.getByTestId("knowledge-source-list")
					.querySelector('[data-path="/docs/gov"]'),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByTestId("knowledge-compile"));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("compile_knowledge", {
				adkPath: "/adk",
			}),
		);
		await waitFor(() =>
			expect(screen.getByTestId("knowledge-status").textContent).toContain("1"),
		);
	});

	it("컴파일 미배선(커맨드 없음) → 정직한 unavailable 표기(UI 무붕괴)", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "read_naia_knowledge_config")
				return JSON.stringify({
					version: 1,
					scope: "default",
					sources: [{ path: "/docs/gov" }],
				});
			if (cmd === "read_naia_knowledge_kb") return "";
			if (cmd === "compile_knowledge")
				throw new Error("Command compile_knowledge not found");
			return undefined;
		});
		render(<KnowledgeSettingsTab />);
		await waitFor(() =>
			expect(
				screen
					.getByTestId("knowledge-source-list")
					.querySelector('[data-path="/docs/gov"]'),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByTestId("knowledge-compile"));
		await waitFor(() =>
			expect(screen.getByTestId("knowledge-compile-error")).toBeTruthy(),
		);
	});
});
