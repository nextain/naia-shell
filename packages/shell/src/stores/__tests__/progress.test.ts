import { afterEach, describe, expect, it } from "vitest";
import { useProgressStore } from "../progress";

describe("useProgressStore", () => {
	afterEach(() => {
		useProgressStore.setState(useProgressStore.getInitialState());
	});

	it("has correct initial state", () => {
		const state = useProgressStore.getState();
		expect(state.events).toEqual([]);
		expect(state.stats).toBeNull();
		expect(state.isLoading).toBe(false);
	});

	it("setEvents replaces the events array", () => {
		const { setEvents } = useProgressStore.getState();
		const events = [
			{
				id: 1,
				timestamp: "2026-02-17T00:00:00Z",
				request_id: "req-1",
				event_type: "tool_use",
				tool_name: "read_file",
				tool_call_id: "tc-1",
				tier: null,
				success: null,
				payload: null,
			},
		];
		setEvents(events);
		expect(useProgressStore.getState().events).toEqual(events);
	});

	it("setStats replaces stats", () => {
		const { setStats } = useProgressStore.getState();
		const stats = {
			total_events: 42,
			by_event_type: [
				["tool_use", 30],
				["usage", 12],
			] as [string, number][],
			by_tool_name: [["read_file", 20]] as [string, number][],
			total_cost: 0.05,
		};
		setStats(stats);
		expect(useProgressStore.getState().stats).toEqual(stats);
	});

	it("setLoading toggles loading state", () => {
		const { setLoading } = useProgressStore.getState();
		setLoading(true);
		expect(useProgressStore.getState().isLoading).toBe(true);
		setLoading(false);
		expect(useProgressStore.getState().isLoading).toBe(false);
	});
});
