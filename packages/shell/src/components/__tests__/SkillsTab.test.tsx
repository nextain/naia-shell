// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSkillsStore } from "../../stores/skills";

const mockRefresh = vi.fn();
const mockRefreshOne = vi.fn();
const mockOpenLogin = vi.fn();
const mockSetCliEnabled = vi.fn();
const mockSetGestureEnabled = vi.fn();
const mockGetEnabledClis = vi.fn(() => ["claude"] as string[]);
const mockIsGestureDisabled = vi.fn(() => false);

vi.mock("../../lib/cli-detection", async () => {
	const actual = await vi.importActual<typeof import("../../lib/cli-detection")>(
		"../../lib/cli-detection",
	);
	return {
		...actual,
		refreshCliDetection: (...args: unknown[]) => mockRefresh(...args),
		refreshCliDetectionOne: (...args: unknown[]) => mockRefreshOne(...args),
		openCliLogin: (...args: unknown[]) => mockOpenLogin(...args),
		setCliEnabled: (...args: unknown[]) => mockSetCliEnabled(...args),
		setGestureEnabled: (...args: unknown[]) => mockSetGestureEnabled(...args),
		getEnabledClis: () => mockGetEnabledClis(),
		isGestureDisabled: (...args: unknown[]) => mockIsGestureDisabled(...args),
	};
});

import { SkillsTab } from "../SkillsTab";

const SNAPSHOT = {
	refreshedAt: "1",
	results: [
		{
			id: "claude",
			displayName: "Claude Code",
			installed: true,
			path: "/usr/bin/claude",
			version: "2.0.0",
			status: "ready",
		},
		{
			id: "codex",
			displayName: "Codex",
			installed: true,
			path: "/usr/bin/codex",
			version: "0.1.0",
			status: "login-required",
		},
		{
			id: "grok",
			displayName: "Grok",
			installed: false,
			status: "not-installed",
		},
	],
};

describe("SkillsTab checkbox model", () => {
	afterEach(() => {
		cleanup();
		mockRefresh.mockReset();
		mockRefreshOne.mockReset();
		mockOpenLogin.mockReset();
		mockSetCliEnabled.mockReset();
		mockSetGestureEnabled.mockReset();
		mockGetEnabledClis.mockReset();
		mockGetEnabledClis.mockReturnValue(["claude"]);
		mockIsGestureDisabled.mockReset();
		mockIsGestureDisabled.mockReturnValue(false);
		useSkillsStore.setState(useSkillsStore.getInitialState());
		localStorage.clear();
	});

	it("shows loading then installed CLI checkboxes only", async () => {
		mockRefresh.mockResolvedValue(SNAPSHOT);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("Claude Code")).toBeDefined();
			expect(screen.getByText("Codex")).toBeDefined();
		});
		expect(screen.queryByText("Grok")).toBeNull();
		expect(screen.getByTestId("skills-cli-section")).toBeDefined();
		expect(screen.getByTestId("skills-gesture-section")).toBeDefined();
	});

	it("does not render agent tool lists or gateway install UI", async () => {
		mockRefresh.mockResolvedValue(SNAPSHOT);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("Claude Code")).toBeDefined();
		});
		expect(container.querySelector('[data-testid="gateway-skill-card"]')).toBeNull();
		expect(container.querySelector('[data-testid="skills-install-btn"]')).toBeNull();
		expect(screen.queryByText(/Agent 도구|Agent Tools/)).toBeNull();
	});

	it("toggles enabled CLI into config helper", async () => {
		mockRefresh.mockResolvedValue(SNAPSHOT);
		render(<SkillsTab />);
		await waitFor(() => screen.getByTestId("cli-enable-codex"));
		fireEvent.click(screen.getByTestId("cli-enable-codex"));
		expect(mockSetCliEnabled).toHaveBeenCalledWith("codex", true);
	});

	it("shows login button for login-required CLI", async () => {
		mockRefresh.mockResolvedValue(SNAPSHOT);
		render(<SkillsTab />);
		await waitFor(() => screen.getByTestId("cli-login-codex"));
		fireEvent.click(screen.getByTestId("cli-login-codex"));
		expect(mockOpenLogin).toHaveBeenCalledWith("codex");
	});

	it("renders youtube gesture toggle and injected Radio DJ child", async () => {
		mockRefresh.mockResolvedValue(SNAPSHOT);
		render(
			<SkillsTab>
				<div data-testid="radio-dj-order">Youtube Radio DJ</div>
			</SkillsTab>,
		);
		await waitFor(() => screen.getByTestId("gesture-enable-youtube"));
		expect(screen.getByTestId("radio-dj-order")).toBeDefined();
	});
});
