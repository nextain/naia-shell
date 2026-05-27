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

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock Tauri event listener (#334 — SkillsTab listens for skill_inventory_ready).
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => {
		// Return an unlisten function. The listener is tolerant of the event
		// never firing (3 s timeout fallback), so we don't need to invoke it.
		return () => {};
	}),
}));

// Mock directToolCall
const mockDirectToolCall = vi.fn();
vi.mock("../../lib/chat-service", () => ({
	directToolCall: (...args: unknown[]) => mockDirectToolCall(...args),
}));

// Import after mocks
import { SkillsTab } from "../SkillsTab";

const BUILT_IN_SKILLS: SkillManifestInfo[] = [
	{
		name: "skill_time",
		description: "Get current date and time",
		type: "built-in",
		tier: 0,
		source: "built-in",
		origin: "agent",
	},
	{
		name: "skill_memo",
		description: "Save and retrieve memos",
		type: "built-in",
		tier: 0,
		source: "built-in",
		origin: "agent",
	},
	{
		name: "skill_voicewake",
		description: "Manage voice wake triggers",
		type: "built-in",
		tier: 0,
		source: "built-in",
		origin: "shell",
	},
];

const CUSTOM_SKILLS: SkillManifestInfo[] = [
	{
		name: "skill_code_review",
		description: "Review code changes",
		type: "gateway",
		tier: 2,
		source: "/home/.naia/skills/code-review/skill.json",
		gatewaySkill: "code-review",
	},
	{
		name: "skill_deploy",
		description: "Deploy to production",
		type: "command",
		tier: 2,
		source: "/home/.naia/skills/deploy/skill.json",
	},
];

const ALL_SKILLS = [...BUILT_IN_SKILLS, ...CUSTOM_SKILLS];

describe("SkillsTab", () => {
	afterEach(() => {
		cleanup();
		mockInvoke.mockReset();
		mockDirectToolCall.mockReset();
		useSkillsStore.setState(useSkillsStore.getInitialState());
		localStorage.clear();
	});

	it("shows loading state initially", () => {
		mockInvoke.mockReturnValue(new Promise(() => {})); // never resolves
		render(<SkillsTab />);
		expect(screen.getByText(/로딩|Loading/)).toBeDefined();
	});

	it("renders skill cards after loading", async () => {
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("skill_time")).toBeDefined();
			expect(screen.getByText("skill_code_review")).toBeDefined();
		});
	});

	it("shows empty state when no skills", async () => {
		mockInvoke.mockResolvedValue([]);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText(/등록된 스킬이 없|No skills/)).toBeDefined();
		});
	});

	it("separates skills into source groups (#334)", async () => {
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			// Agent group (skill_time, skill_memo) + shell group (skill_voicewake,
			// skill_code_review, skill_deploy as legacy fallback). adk group
			// renders as empty placeholder.
			const groups = container.querySelectorAll(
				'[data-testid^="skills-group-"]',
			);
			expect(groups.length).toBeGreaterThanOrEqual(2);
		});
	});

	it("renders source badge on each card (#334)", async () => {
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			const badges = container.querySelectorAll(
				'[data-testid="skills-source-badge"]',
			);
			expect(badges.length).toBeGreaterThanOrEqual(ALL_SKILLS.length);
		});
		// Verify agent skill carries origin=agent and shell skill carries origin=shell.
		const agentCard = container.querySelector('[data-origin="agent"]');
		const shellCard = container.querySelector('[data-origin="shell"]');
		expect(agentCard).not.toBeNull();
		expect(shellCard).not.toBeNull();
	});

	it("groups skill_time under the agent group (#334)", async () => {
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			const agentGroup = container.querySelector(
				'[data-testid="skills-group-agent"]',
			);
			expect(agentGroup).not.toBeNull();
			expect(agentGroup?.textContent ?? "").toContain("skill_time");
		});
	});

	it("filters skills by search query", async () => {
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("skill_time")).toBeDefined();
		});

		const searchInput = screen.getByPlaceholderText(/검색|Search/);
		fireEvent.change(searchInput, { target: { value: "deploy" } });

		expect(screen.queryByText("skill_time")).toBeNull();
		expect(screen.getByText("skill_deploy")).toBeDefined();
	});

	it("shows built-in badge when skill is expanded", async () => {
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		const { container } = render(<SkillsTab />);
		await waitFor(() => {
			expect(screen.getByText("skill_time")).toBeDefined();
		});
		// Click to expand the first built-in skill
		const headers = container.querySelectorAll(".skill-card-header");
		fireEvent.click(headers[0]);
		const badges = container.querySelectorAll(".skill-badge.built-in");
		expect(badges.length).toBeGreaterThanOrEqual(1);
	});

	it("calls onAskAI when help button is clicked", async () => {
		const onAskAI = vi.fn();
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		const { container } = render(<SkillsTab onAskAI={onAskAI} />);
		await waitFor(() => {
			expect(screen.getByText("skill_time")).toBeDefined();
		});
		const helpBtns = container.querySelectorAll(".skill-help-btn");
		expect(helpBtns.length).toBeGreaterThan(0);
		fireEvent.click(helpBtns[0]);
		expect(onAskAI).toHaveBeenCalledOnce();
		expect(onAskAI.mock.calls[0][0]).toContain("skill_time");
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
		mockInvoke.mockResolvedValue(ALL_SKILLS);
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
		mockInvoke.mockResolvedValue(ALL_SKILLS);
		render(<SkillsTab />);
		await waitFor(() => {
			// 5 total (2 agent built-ins + 1 shell built-in + 2 custom), 1 disabled → 4 enabled
			expect(screen.getByText("4/5")).toBeDefined();
		});
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
		mockInvoke.mockReset();
		mockDirectToolCall.mockReset();
		useSkillsStore.setState(useSkillsStore.getInitialState());
		localStorage.clear();
	});

	it("renders gateway skill cards with install button", async () => {
		setupGatewayConfig();
		mockInvoke.mockResolvedValue(BUILT_IN_SKILLS);
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
		mockInvoke.mockResolvedValue(BUILT_IN_SKILLS);

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
		mockInvoke.mockResolvedValue(BUILT_IN_SKILLS);

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
		mockInvoke.mockResolvedValue(BUILT_IN_SKILLS);

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
		mockInvoke.mockResolvedValue(BUILT_IN_SKILLS);

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
