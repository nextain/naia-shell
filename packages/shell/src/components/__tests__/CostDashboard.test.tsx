import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { getNaiaKeySecure, hasNaiaKeySecure } from "../../lib/config";
import { clearCachedLabCredits } from "../../lib/lab-balance";
import { CostDashboard, groupCosts } from "../CostDashboard";

describe("CostDashboard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The balance cache is module-level state shared across every test in
		// this file; a test that primes it (a successful fetch) would otherwise
		// leak a fresh value into the next test and skip its own fetch (#402).
		clearCachedLabCredits();
		vi.mocked(getNaiaKeySecure).mockResolvedValue(undefined);
		vi.mocked(hasNaiaKeySecure).mockResolvedValue(false);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 1_250_000 }),
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

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

	it("shows a re-login state instead of a balance error when the key returns 401 (#402)", async () => {
		vi.mocked(getNaiaKeySecure).mockResolvedValue("gw-stale-key");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				json: () => Promise.resolve({}),
			}),
		);

		render(<CostDashboard messages={[]} />);
		// The mount-time `hasNaiaKeySecure()` check and this event both call
		// `setShowLabBalance`; without waiting for the former to settle first,
		// it can resolve after the event and clobber `true` back to `false`.
		await waitFor(() => {
			expect(hasNaiaKeySecure).toHaveBeenCalled();
		});
		window.dispatchEvent(new CustomEvent("naia_auth_ready"));

		await waitFor(() => {
			expect(screen.getByTestId("lab-balance-expired")).toBeDefined();
		});
		expect(screen.queryByText(/잔액 조회 실패|Failed to load balance/)).toBeNull();
	});

	it("flips to a re-login state when a chat completion reports the key as unauthorized (#402)", async () => {
		// A 401 on a chat completion never reaches this component's own balance
		// fetch — ChatArea detects it from the agent's error chunk and
		// broadcasts `markNaiaKeyUnauthorized()` (lib/lab-balance.ts) instead.
		vi.mocked(getNaiaKeySecure).mockResolvedValue("gw-good-key");
		vi.mocked(hasNaiaKeySecure).mockResolvedValue(true);

		render(<CostDashboard messages={[]} />);
		await screen.findByText(/12\.50/);

		const { markNaiaKeyUnauthorized } = await import("../../lib/lab-balance");
		act(() => {
			markNaiaKeyUnauthorized();
		});

		await waitFor(() => {
			expect(screen.getByTestId("lab-balance-expired")).toBeDefined();
		});
	});

	it("fetches Lab balance when startup auth restore is announced", async () => {
		vi.mocked(getNaiaKeySecure).mockResolvedValue("gw-startup-key");

		render(<CostDashboard messages={[]} />);
		await waitFor(() => {
			expect(hasNaiaKeySecure).toHaveBeenCalled();
		});
		window.dispatchEvent(new CustomEvent("naia_auth_ready"));

		await waitFor(() => {
			const [url, init] = vi.mocked(fetch).mock.calls.at(-1) ?? [];
			expect(url).toBe("https://example.test/v1/profile/balance");
			expect(init).toMatchObject({
				headers: { "X-AnyLLM-Key": "Bearer gw-startup-key" },
			});
			expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
		});
		await waitFor(() => {
			expect(screen.getByText(/12\.50/)).toBeDefined();
		});
	});
});
