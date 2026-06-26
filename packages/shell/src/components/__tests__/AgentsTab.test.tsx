import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// AgentsTab 정상화(E1 셸-직결): sessions = conversation-store(로컬 transcript), 구 gateway directToolCall 폐기.
const mockListConversations = vi.fn();
const mockDeleteConversation = vi.fn();
vi.mock("../../lib/conversation-store", () => ({
	listConversations: (...a: unknown[]) => mockListConversations(...a),
	deleteConversation: (...a: unknown[]) => mockDeleteConversation(...a),
	getConversationHistory: vi.fn(),
}));

import { AgentsTab } from "../AgentsTab";

describe("AgentsTab (E1 셸-직결 정상화)", () => {
	afterEach(() => {
		cleanup();
		mockListConversations.mockReset();
		mockDeleteConversation.mockReset();
	});

	it("sessions = conversation-store(E1) 로 렌더 — directToolCall 미사용", async () => {
		mockListConversations.mockResolvedValue([
			{ key: "agent:main:a", label: "세션 A", messageCount: 5, createdAt: 1, updatedAt: 2 },
			{ key: "agent:main:b", label: "세션 B", messageCount: 2, createdAt: 1, updatedAt: 3 },
		]);
		const { container } = render(<AgentsTab />);
		await waitFor(() => {
			expect(container.querySelectorAll(".session-card")).toHaveLength(2);
		});
		expect(screen.getByText("세션 A")).toBeDefined();
		expect(screen.getByText("세션 B")).toBeDefined();
		expect(mockListConversations).toHaveBeenCalled();
	});

	it("세션 없음 = 빈 상태(에러 아님 — 신코어 tool_request error 회귀 방지)", async () => {
		mockListConversations.mockResolvedValue([]);
		const { container } = render(<AgentsTab />);
		await waitFor(() => {
			expect(container.querySelector(".agents-tab")).not.toBeNull();
		});
		expect(container.querySelectorAll(".session-card")).toHaveLength(0);
		// agents 섹션 + sessions 섹션 모두 빈 상태 표기(2개 agents-empty)
		expect(container.querySelectorAll(".agents-empty").length).toBeGreaterThanOrEqual(1);
	});

	it("delete = deleteConversation(키) 호출(E1) 후 재조회", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		mockListConversations.mockResolvedValue([
			{ key: "agent:main:old", label: "삭제대상", messageCount: 1, createdAt: 1, updatedAt: 1 },
		]);
		mockDeleteConversation.mockResolvedValue(true);
		const { container } = render(<AgentsTab />);
		await waitFor(() => expect(screen.getByText("삭제대상")).toBeDefined());

		const delBtn = container.querySelector(".session-action-btn.delete");
		expect(delBtn).not.toBeNull();
		fireEvent.click(delBtn!);

		await waitFor(() => {
			expect(mockDeleteConversation).toHaveBeenCalledWith("agent:main:old");
		});
		expect(mockListConversations.mock.calls.length).toBeGreaterThanOrEqual(2); // 삭제 후 fetchData 재조회
	});

	it("agents 섹션 = 백엔드 미이식이라 항상 빈 상태(깨진 skill_agents 호출 없음)", async () => {
		mockListConversations.mockResolvedValue([]);
		const { container } = render(<AgentsTab />);
		await waitFor(() => expect(container.querySelector(".agents-section")).not.toBeNull());
		// 구 directToolCall(skill_agents) 미사용 → list_conversations 만 호출, 게이트웨이 호출 0
		expect(mockListConversations).toHaveBeenCalledTimes(1);
		// compact 버튼 제거 확인(agent 내부 작업 — 셸 UI op 아님)
		expect(container.querySelector(".session-action-btn.compact")).toBeNull();
	});
});
