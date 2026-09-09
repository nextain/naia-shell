// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillManifestInfo } from "../../lib/types";
import { useSkillsStore } from "../../stores/skills";

// Mock the Agent skill-list request and the separate gateway manager request.
const mockFetchAgentSkills = vi.fn();
const mockDirectToolCall = vi.fn();
vi.mock("../../lib/chat-service", () => ({
	directToolCall: (...args: unknown[]) => mockDirectToolCall(...args),
	fetchAgentSkills: (...args: unknown[]) => mockFetchAgentSkills(...args),
}));

// Import after mocks
import { SkillsTab } from "../SkillsTab";

const AGENT_SKILLS = [
	{
		name: "get_time",
		description: "Get current date and time",
		parameters: {},
	},
	{
		name: "skill_code_review",
		description: "Review code changes",
		parameters: {},
	},
	{
		name: "skill_deploy",
		description: "Deploy to production",
		parameters: {},
	},
	{
		name: "workspace_search",
		description: "Search the current workspace",
		parameters: {},
	},
];

const STALE_SKILL: SkillManifestInfo = {
	name: "stale_manifest_skill",
	description: "A stale local manifest row",
	type: "built-in",
};

describe("SkillsTab", () => {
	afterEach(() => {
		cleanup();
		mockFetchAgentSkills.mockReset();
		mockDirectToolCall.mockReset();
		useSkillsStore.setState(useSkillsStore.getInitialState());
		localStorage.clear();
	});

	it("shows loading state initially", () => {
		mockFetchAgentSkills.mockReturnValue(new Promise(() => {})); // never resolves
		render(<SkillsTab />);
		expect(screen.getByText(/로딩|Loading/)).toBeDefined();
	});

	it("renders skill cards after loading", async () => {
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("get_time")).toBeDefined();
			expect(screen.getByText("skill_code_review")).toBeDefined();
		});
	});

	it("shows empty state when no skills", async () => {
		mockFetchAgentSkills.mockResolvedValue([]);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText(/등록된 스킬이 없|No skills/)).toBeDefined();
		});
	});

	it("renders the Agent tools section from the runtime list", async () => {
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			const sections = container.querySelectorAll(".skills-section-title");
			expect(sections.length).toBe(1);
			expect(sections[0]?.textContent).toMatch(/Agent Tools|Agent 도구/);
		});
	});

	it("keeps injected Radio DJ when the Agent list has no memo row", async () => {
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		const { container } = render(
			<SkillsTab>
				<div data-testid="radio-dj-order">Youtube Radio DJ</div>
			</SkillsTab>,
		);
		await waitFor(() => expect(screen.getByText("get_time")).toBeDefined());
		const ordered = Array.from(
			container.querySelectorAll(".skill-card, [data-testid='radio-dj-order']"),
		).map((element) => element.textContent);
		expect(ordered[0]).toContain("Youtube Radio DJ");
		expect(ordered[1]).toContain("get_time");
	});

	it("filters skills by search query", async () => {
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("get_time")).toBeDefined();
		});

		const searchInput = screen.getByPlaceholderText(/검색|Search/);
		fireEvent.change(searchInput, { target: { value: "deploy" } });

		expect(screen.queryByText("get_time")).toBeNull();
		expect(screen.getByText("skill_deploy")).toBeDefined();
	});

	it("shows the Agent badge without fabricating a tier", async () => {
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("get_time")).toBeDefined();
		});
		// Agent ToolSpecs do not carry a legacy tier or source.
		const headers = container.querySelectorAll(".skill-card-header");
		fireEvent.click(headers[0]);
		const badges = container.querySelectorAll(".skill-badge.agent");
		expect(badges.length).toBeGreaterThanOrEqual(1);
		expect(container.querySelectorAll(".skill-badge.tier")).toHaveLength(0);
	});

	it("calls onAskAI when help button is clicked", async () => {
		const onAskAI = vi.fn();
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		const { container } = render(<SkillsTab onAskAI={onAskAI} />);
		await waitFor(() => {
			expect(screen.getByText("get_time")).toBeDefined();
		});
		const helpBtns = container.querySelectorAll(".skill-help-btn");
		expect(helpBtns.length).toBeGreaterThan(0);
		fireEvent.click(helpBtns[0]);
		expect(onAskAI).toHaveBeenCalledOnce();
		expect(onAskAI.mock.calls[0][0]).toContain("get_time");
	});

	it("applies disabled class to disabled skills", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test",
				disabledSkills: ["skill_code_review"],
			}),
		);
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			const disabledCards = container.querySelectorAll(".skill-card.disabled");
			expect(disabledCards.length).toBe(1);
		});
	});

	it("shows enabled/total count using Set-based filtering", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test",
				disabledSkills: ["skill_code_review"],
			}),
		);
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => {
			// 4 total, 1 disabled → 3 enabled
			expect(screen.getByText("3/4")).toBeDefined();
		});
	});

	it("toggles the exact Agent tool name", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "gemini", model: "test", apiKey: "test" }),
		);
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => expect(screen.getByText("get_time")).toBeDefined());

		const card = screen.getByText("get_time").closest(".skill-card");
		const checkbox = card?.querySelector("input[type='checkbox']");
		expect(checkbox).not.toBeNull();
		fireEvent.click(checkbox as HTMLInputElement);

		const config = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(config.disabledSkills).toEqual(["get_time"]);
	});

	it("disables all runtime Agent tools by their returned names", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "gemini", model: "test", apiKey: "test" }),
		);
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => expect(screen.getByText("get_time")).toBeDefined());

		fireEvent.click(
			screen.getByRole("button", { name: /Disable All|전체 비활성/ }),
		);

		const config = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(config.disabledSkills).toEqual(
			AGENT_SKILLS.map((skill) => skill.name),
		);
	});

	it("clears stale rows and distinguishes Agent load failure from empty", async () => {
		useSkillsStore.setState({
			skills: [STALE_SKILL],
			isLoading: false,
			searchQuery: "",
			configVersion: 0,
		});
		mockFetchAgentSkills.mockRejectedValue(new Error("Agent unavailable"));
		render(<SkillsTab />);

		await waitFor(() => {
			expect(screen.getByTestId("skills-load-error")).toBeDefined();
		});
		expect(screen.queryByText("stale_manifest_skill")).toBeNull();
		expect(screen.queryByText(/등록된 스킬이 없|No skills/)).toBeNull();
	});

	it("ignores a late Agent response after the tab is replaced", async () => {
		let resolveFirst: (skills: typeof AGENT_SKILLS) => void = () => {};
		const firstResponse = new Promise<typeof AGENT_SKILLS>((resolve) => {
			resolveFirst = resolve;
		});
		mockFetchAgentSkills
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce([AGENT_SKILLS[0]]);

		const firstRender = render(<SkillsTab />);
		await waitFor(() => expect(mockFetchAgentSkills).toHaveBeenCalled());
		firstRender.unmount();

		render(<SkillsTab />);
		await waitFor(() => expect(screen.getByText("get_time")).toBeDefined());

		resolveFirst([
			{
				name: "late_stale_tool",
				description: "A response from an unmounted tab",
				parameters: {},
			},
		]);
		await waitFor(() =>
			expect(screen.queryByText("late_stale_tool")).toBeNull(),
		);
		expect(screen.getByText("get_time")).toBeDefined();
	});
});

describe("SkillsTab gateway install", () => {
	const GATEWAY_SKILLS_RESPONSE = {
		success: true,
		output: JSON.stringify({
			skills: [
				{
					name: "web-search",
					description: "Search the web",
					eligible: false,
					missing: ["chromium"],
					install: [{ id: "node-0", kind: "node", label: "Install chromium" }],
				},
				{
					name: "screenshot",
					description: "Take a screenshot",
					eligible: true,
					missing: [],
					install: [],
				},
			],
		}),
	};

	function setupGatewayConfig() {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test",
				enableTools: true,
				gatewayUrl: "ws://gateway.example.test:18789",
			}),
		);
	}

	afterEach(() => {
		cleanup();
		mockFetchAgentSkills.mockReset();
		mockDirectToolCall.mockReset();
		useSkillsStore.setState(useSkillsStore.getInitialState());
		localStorage.clear();
	});

	it("renders gateway skill cards with install button", async () => {
		setupGatewayConfig();
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);
		mockDirectToolCall.mockResolvedValue(GATEWAY_SKILLS_RESPONSE);

		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			const cards = container.querySelectorAll(
				'[data-testid="gateway-skill-card"]',
			);
			expect(cards.length).toBe(2);
		});

		// web-search is ineligible → should have install button
		const installBtn = container.querySelector(
			'[data-testid="skills-install-btn"]',
		);
		expect(installBtn).not.toBeNull();
		expect(installBtn?.textContent).toMatch(/설치|Install/);

		// screenshot is eligible → should show eligible badge
		const eligibleBadges = container.querySelectorAll(".skill-badge.eligible");
		expect(eligibleBadges.length).toBe(1);
	});

	it("shows success feedback after install", async () => {
		setupGatewayConfig();
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);

		mockDirectToolCall.mockImplementation(async (opts: any) => {
			if (opts.args?.action === "gateway_status") {
				return GATEWAY_SKILLS_RESPONSE;
			}
			if (opts.args?.action === "install") {
				return { success: true, output: "Installed" };
			}
			return { success: false, output: "" };
		});

		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(
				container.querySelector('[data-testid="skills-install-btn"]'),
			).not.toBeNull();
		});

		// Click install
		const installBtn = container.querySelector(
			'[data-testid="skills-install-btn"]',
		) as HTMLButtonElement;
		fireEvent.click(installBtn);

		// Should show success result
		await waitFor(() => {
			const result = container.querySelector(".skill-install-result.success");
			expect(result).not.toBeNull();
			expect(result?.textContent).toMatch(/설치 완료|Installed successfully/);
		});
	});

	it("shows error feedback on install failure", async () => {
		setupGatewayConfig();
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);

		mockDirectToolCall.mockImplementation(async (opts: any) => {
			if (opts.args?.action === "gateway_status") {
				return GATEWAY_SKILLS_RESPONSE;
			}
			if (opts.args?.action === "install") {
				return { success: false, output: "Package not found" };
			}
			return { success: false, output: "" };
		});

		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(
				container.querySelector('[data-testid="skills-install-btn"]'),
			).not.toBeNull();
		});

		const installBtn = container.querySelector(
			'[data-testid="skills-install-btn"]',
		) as HTMLButtonElement;
		fireEvent.click(installBtn);

		await waitFor(() => {
			const result = container.querySelector(".skill-install-result.error");
			expect(result).not.toBeNull();
			expect(result?.textContent).toContain("Package not found");
		});
	});

	it("shows error feedback on install exception", async () => {
		setupGatewayConfig();
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);

		mockDirectToolCall.mockImplementation(async (opts: any) => {
			if (opts.args?.action === "gateway_status") {
				return GATEWAY_SKILLS_RESPONSE;
			}
			if (opts.args?.action === "install") {
				throw new Error("Connection refused");
			}
			return { success: false, output: "" };
		});

		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(
				container.querySelector('[data-testid="skills-install-btn"]'),
			).not.toBeNull();
		});

		const installBtn = container.querySelector(
			'[data-testid="skills-install-btn"]',
		) as HTMLButtonElement;
		fireEvent.click(installBtn);

		await waitFor(() => {
			const result = container.querySelector(".skill-install-result.error");
			expect(result).not.toBeNull();
			expect(result?.textContent).toContain("Connection refused");
		});
	});

	it("clears previous result on new install attempt", async () => {
		setupGatewayConfig();
		mockFetchAgentSkills.mockResolvedValue(AGENT_SKILLS);

		let installCount = 0;
		mockDirectToolCall.mockImplementation(async (opts: any) => {
			if (opts.args?.action === "gateway_status") {
				return GATEWAY_SKILLS_RESPONSE;
			}
			if (opts.args?.action === "install") {
				installCount++;
				if (installCount === 1) {
					return { success: false, output: "First attempt failed" };
				}
				return { success: true, output: "OK" };
			}
			return { success: false, output: "" };
		});

		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(
				container.querySelector('[data-testid="skills-install-btn"]'),
			).not.toBeNull();
		});

		// First attempt — fail
		const installBtn = container.querySelector(
			'[data-testid="skills-install-btn"]',
		) as HTMLButtonElement;
		fireEvent.click(installBtn);
		await waitFor(() => {
			expect(
				container.querySelector(".skill-install-result.error"),
			).not.toBeNull();
		});

		// Second attempt — should clear error, then show success
		fireEvent.click(installBtn);
		await waitFor(() => {
			const success = container.querySelector(".skill-install-result.success");
			expect(success).not.toBeNull();
		});
		// Error result should be gone
		expect(container.querySelector(".skill-install-result.error")).toBeNull();
	});
});
