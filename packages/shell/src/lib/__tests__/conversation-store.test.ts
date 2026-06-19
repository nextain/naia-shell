import { beforeEach, describe, expect, it, vi } from "vitest";

// conversation-store 계약(FR-CONV.3/4) — 로컬 transcript read-only. invoke(Rust IPC) + getAdkPath mock.
const mockInvoke = vi.fn();
const mockGetAdkPath = vi.fn(() => "/adk" as string | null);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("../adk-store", () => ({
	getAdkPath: () => mockGetAdkPath(),
}));

import {
	deleteConversation,
	getConversationHistory,
	listConversations,
} from "../conversation-store";

beforeEach(() => {
	mockInvoke.mockReset();
	mockGetAdkPath.mockReset();
	mockGetAdkPath.mockReturnValue("/adk");
});

describe("conversation-store (FR-CONV.3/4 — read-only 로컬 transcript, agent 독립 E1)", () => {
	it("listConversations — {sessions} 파싱 + adkPath 전달", async () => {
		mockInvoke.mockResolvedValue(
			JSON.stringify({
				sessions: [{ key: "s1", label: "안녕", messageCount: 2, createdAt: 1, updatedAt: 2 }],
			}),
		);
		const r = await listConversations();
		expect(mockInvoke).toHaveBeenCalledWith("list_conversations", { adkPath: "/adk" });
		expect(r).toHaveLength(1);
		expect(r[0].key).toBe("s1");
	});
	it("listConversations — adkPath 없음 = 빈목록(invoke 미호출)", async () => {
		mockGetAdkPath.mockReturnValue(null);
		expect(await listConversations()).toEqual([]);
		expect(mockInvoke).not.toHaveBeenCalled();
	});
	it("listConversations — agent-down/IPC 실패 = 빈목록(E1, no-throw)", async () => {
		mockInvoke.mockRejectedValue(new Error("agent down"));
		expect(await listConversations()).toEqual([]);
	});
	it("getConversationHistory — JSONL 파싱(user/assistant만, system/blank/손상 skip)", async () => {
		const jsonl = [
			JSON.stringify({ role: "user", content: "안녕", timestamp: 10 }),
			JSON.stringify({ role: "assistant", content: "반가워요", timestamp: 11 }),
			JSON.stringify({ role: "system", content: "무시", timestamp: 12 }),
			"   ",
			"{broken json",
		].join("\n");
		mockInvoke.mockResolvedValue(jsonl);
		const msgs = await getConversationHistory("s1");
		expect(mockInvoke).toHaveBeenCalledWith("read_conversation", { adkPath: "/adk", sessionId: "s1" });
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(msgs[0].content).toBe("안녕");
		expect(msgs[1].content).toBe("반가워요");
	});
	it("getConversationHistory — 빈 transcript = []", async () => {
		mockInvoke.mockResolvedValue("");
		expect(await getConversationHistory("s1")).toEqual([]);
	});
	it("deleteConversation — delete_conversation invoke + true", async () => {
		mockInvoke.mockResolvedValue(undefined);
		expect(await deleteConversation("s1")).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("delete_conversation", { adkPath: "/adk", sessionId: "s1" });
	});
	it("deleteConversation — 실패 = false(no-throw)", async () => {
		mockInvoke.mockRejectedValue(new Error("nope"));
		expect(await deleteConversation("s1")).toBe(false);
	});
});
