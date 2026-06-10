import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditStats } from "../../lib/types";
import { useProgressStore } from "../../stores/progress";
import { WorkProgressPanel } from "../WorkProgressPanel";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

describe("WorkProgressPanel", () => {
	afterEach(() => {
		cleanup();
		useProgressStore.setState(useProgressStore.getInitialState());
	});

	const sampleEvent: AuditEvent = {
		id: 1,
		timestamp: "2026-02-17T10:30:00Z",
		request_id: "req-1",
		event_type: "tool_use",
		tool_name: "read_file",
		tool_call_id: "tc-1",
		tier: null,
		success: null,
		payload: '{"path":"/test.txt"}',
	};

	const sampleStats: AuditStats = {
		total_events: 42,
		by_event_type: [
			["tool_use", 20],
			["tool_result", 15],
			["usage", 5],
			["error", 2],
		],
		by_tool_name: [
			["read_file", 12],
			["execute_command", 8],
		],
		total_cost: 0.053,
	};

	it("shows loading state", () => {
		useProgressStore.setState({ isLoading: true });
		const { container } = render(<WorkProgressPanel />);
		expect(container.querySelector(".work-progress-loading")).not.toBeNull();
	});

	it("shows empty state when no events", () => {
		useProgressStore.setState({ events: [], stats: null, isLoading: false });
		render(<WorkProgressPanel />);
		expect(screen.getByText(/기록이 없습니다|No events/)).toBeDefined();
	});

	it("renders stats cards when stats are present", () => {
		useProgressStore.setState({ stats: sampleStats, isLoading: false });
		const { container } = render(<WorkProgressPanel />);
		const statCards = container.querySelectorAll(".work-progress-stat");
		expect(statCards.length).toBe(4);
	});

	it("displays total events count in stats", () => {
		useProgressStore.setState({ stats: sampleStats, isLoading: false });
		render(<WorkProgressPanel />);
		expect(screen.getByText("42")).toBeDefined();
	});

	it("displays total cost in stats", () => {
		useProgressStore.setState({ stats: sampleStats, isLoading: false });
		render(<WorkProgressPanel />);
		expect(screen.getByText("$0.053")).toBeDefined();
	});

	it("renders event list", () => {
		useProgressStore.setState({
			events: [sampleEvent],
			stats: sampleStats,
			isLoading: false,
		});
		const { container } = render(<WorkProgressPanel />);
		const events = container.querySelectorAll(".work-progress-event");
		expect(events.length).toBe(1);
	});

	it("shows tool_use icon for tool_use event type", () => {
		useProgressStore.setState({
			events: [sampleEvent],
			stats: sampleStats,
			isLoading: false,
		});
		const { container } = render(<WorkProgressPanel />);
		const icon = container.querySelector(".event-type-icon");
		expect(icon?.textContent).toContain("T");
	});

	it("shows error icon for error event type", () => {
		const errorEvent = {
			...sampleEvent,
			id: 2,
			event_type: "error",
			tool_name: null,
		};
		useProgressStore.setState({
			events: [errorEvent],
			stats: sampleStats,
			isLoading: false,
		});
		const { container } = render(<WorkProgressPanel />);
		const icon = container.querySelector(".event-type-icon");
		expect(icon?.textContent).toContain("E");
	});

	it("has a refresh button", () => {
		useProgressStore.setState({ stats: sampleStats, isLoading: false });
		const { container } = render(<WorkProgressPanel />);
		const btn = container.querySelector(".work-progress-refresh-btn");
		expect(btn).not.toBeNull();
	});

	it("expands event payload on click", () => {
		useProgressStore.setState({
			events: [sampleEvent],
			stats: sampleStats,
			isLoading: false,
		});
		const { container } = render(<WorkProgressPanel />);
		const eventEl = container.querySelector(".work-progress-event-header");
		expect(eventEl).not.toBeNull();

		fireEvent.click(eventEl!);
		const payload = container.querySelector(".work-progress-event-payload");
		expect(payload).not.toBeNull();
		expect(payload?.textContent).toContain("/test.txt");
	});
});
