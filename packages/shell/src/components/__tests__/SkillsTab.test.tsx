// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
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
		isGestureDisabled: (..._args: unknown[]) => mockIsGestureDisabled(),
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
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
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

	it("renders web guidance, weather built-in, Radio DJ child, and integration notice without CLI detection in web mode", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");

		render(
			<SkillsTab>
				<div data-testid="radio-dj-order">Youtube Radio DJ</div>
			</SkillsTab>,
		);

		expect(mockRefresh).not.toHaveBeenCalled();
		expect(screen.queryByTestId("skills-cli-refresh")).toBeNull();
		expect(screen.getByTestId("skills-web-notice").textContent).toContain(
			"향후 앱과 동일하게 지원 예정",
		);
		expect(screen.getByText("날씨")).toBeDefined();
		expect(screen.getByText(/get_weather/)).toBeDefined();
		expect(document.querySelector('[data-skill-id="knowledge"]')).toBeNull();
		expect(document.querySelector('[data-skill-id="memory"]')).toBeNull();
		expect(screen.getByTestId("gesture-enable-youtube")).toBeDefined();
		expect(screen.getByTestId("radio-dj-order")).toBeDefined();
		expect(screen.getByTestId("skills-web-unavailable").textContent).toContain(
			"웹버전 통합 진행중",
		);
	});

	it("includes Knowledge and Memory web built-ins alongside Weather and Radio DJ in kiosk demo", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");

		render(
			<SkillsTab>
				<div data-testid="radio-dj-order">Youtube Radio DJ</div>
			</SkillsTab>,
		);

		expect(mockRefresh).not.toHaveBeenCalled();
		expect(screen.getByTestId("skills-web-notice").textContent).toContain(
			"향후 앱과 동일하게 지원 예정",
		);
		expect(document.querySelector('[data-skill-id="knowledge"]')).not.toBeNull();
		expect(document.querySelector('[data-skill-id="memory"]')).not.toBeNull();
		expect(document.querySelector('[data-skill-id="weather"]')).not.toBeNull();
		expect(screen.getByText(/skill_knowledge_search/)).toBeDefined();
		expect(screen.getByText(/skill_memory_save/)).toBeDefined();
		expect(screen.getByText(/get_weather/)).toBeDefined();
		expect(screen.getByTestId("gesture-enable-youtube")).toBeDefined();
		expect(screen.getByTestId("radio-dj-order")).toBeDefined();
		expect(screen.getByTestId("skills-web-unavailable").textContent).toContain(
			"웹버전 통합 진행중",
		);
	});
});
