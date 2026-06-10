import { cleanup, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../lib/types";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://example.test",
	getNaiaKeySecure: vi.fn().mockResolvedValue(null),
	hasNaiaKeySecure: vi.fn().mockResolvedValue(false),
}));

import { CostDashboard, groupCosts } from "../CostDashboard";

describe("CostDashboard", () => {
	afterEach(cleanup);

	const messagesWithCost: ChatMessage[] = [
		{
			id: "m1",
			role: "assistant",
			content: "Hi",
			timestamp: 1000,
			cost: {
				inputTokens: 100,
				outputTokens: 50,
				cost: 0.001,
				provider: "gemini",
				model: "gemini-2.5-flash",
			},
		},
		{
			id: "m2",
			role: "assistant",
			content: "Hello",
			timestamp: 2000,
			cost: {
				inputTokens: 200,
				outputTokens: 100,
				cost: 0.002,
				provider: "gemini",
				model: "gemini-2.5-flash",
			},
		},
		{
			id: "m3",
			role: "assistant",
			content: "Test",
			timestamp: 3000,
			cost: {
				inputTokens: 500,
				outputTokens: 200,
				cost: 0.01,
				provider: "xai",
				model: "grok-3-mini",
			},
		},
	];

	it("shows empty state when no cost data", () => {
		render(<CostDashboard messages={[]} />);
		expect(screen.getByText(/비용 데이터|No cost/)).toBeDefined();
	});

	it("groups costs by provider+model", () => {
		const groups = groupCosts(messagesWithCost);
		expect(groups).toHaveLength(2);
		const gemini = groups.find((g) => g.provider === "gemini");
		expect(gemini).toBeDefined();
		expect(gemini?.count).toBe(2);
		expect(gemini?.inputTokens).toBe(300);
		expect(gemini?.outputTokens).toBe(150);
		expect(gemini?.cost).toBeCloseTo(0.003);
	});

	it("renders table with correct totals", () => {
		const { container } = render(<CostDashboard messages={messagesWithCost} />);
		const table = container.querySelector(".cost-table");
		expect(table).not.toBeNull();
		// Check that totals row exists
		const tfoot = container.querySelector("tfoot");
		expect(tfoot).not.toBeNull();
	});

	it("skips messages without cost", () => {
		const noCost: ChatMessage[] = [
			{ id: "m1", role: "user", content: "Hi", timestamp: 1000 },
		];
		const groups = groupCosts(noCost);
		expect(groups).toHaveLength(0);
	});
});
