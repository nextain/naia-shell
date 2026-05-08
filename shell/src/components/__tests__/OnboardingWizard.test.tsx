import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(true),
	convertFileSrc: vi.fn((path: string) => `file://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn().mockResolvedValue(null),
}));

// Mock getLocale to return "ko" (formality locale) so speechStyle step is shown
vi.mock("../../lib/i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/i18n")>();
	return { ...actual, getLocale: () => "ko" as any };
});

// Mock VrmPreview (Three.js doesn't work in jsdom)
vi.mock("../VrmPreview", () => ({
	VrmPreview: ({ modelPath }: { modelPath: string }) => (
		<div data-testid="vrm-preview" data-model={modelPath} />
	),
}));

import { OnboardingWizard } from "../OnboardingWizard";

describe("OnboardingWizard", () => {
	const onComplete = vi.fn();

	afterEach(() => {
		cleanup();
		onComplete.mockReset();
		localStorage.removeItem("naia-config");
	});

	it("renders provider step first", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		expect(screen.getByText(/두뇌|brain/i)).toBeDefined();
		expect(screen.getByText("Naia")).toBeDefined();
	});

	it("shows all onboarding providers", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		expect(screen.getByText("Google Gemini")).toBeDefined();
		expect(screen.getByText(/OpenAI/)).toBeDefined();
		expect(screen.getByText(/Anthropic/)).toBeDefined();
		expect(screen.getByText(/xAI/)).toBeDefined();
		expect(screen.getByText(/Z\.AI/)).toBeDefined();
	});

	it("progresses through steps: provider → apiKey → agentName → ...", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// Provider step → Next
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// API key step
		expect(screen.getByText(/API/)).toBeDefined();
		const apiInput = screen.getByPlaceholderText("API key...");
		fireEvent.change(apiInput, { target: { value: "test-key" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Agent name step
		expect(screen.getByText(/이름|name/i)).toBeDefined();
		const agentInput = screen.getByPlaceholderText(/이름|name/i);
		fireEvent.change(agentInput, { target: { value: "Mochi" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// User name step
		expect(screen.getByText(/Mochi/)).toBeDefined();
		const nameInput = screen.getByPlaceholderText(/이름|name/i);
		fireEvent.change(nameInput, { target: { value: "Luke" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Workspace step (skippable)
		expect(screen.getByRole("heading", { name: /워크스페이스/ })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Character step (VRM)
		expect(screen.getByText(/모습|look/i)).toBeDefined();
		expect(screen.getByTestId("vrm-preview")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Personality step
		expect(screen.getByText(/골라|Choose.*personality/i)).toBeDefined();
		// Check hint about editing later
		expect(screen.getByText(/설정에서|Settings/i)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Speech style step
		expect(screen.getByText(/어떻게 말|How should.*talk/i)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Complete step
		expect(screen.getByText(/Luke/)).toBeDefined();
	});

	it("requires agentName (Next disabled when empty)", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// Provider → Next
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// API key → fill and Next
		const apiInput = screen.getByPlaceholderText("API key...");
		fireEvent.change(apiInput, { target: { value: "key" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Agent name step — Next should be disabled
		const nextBtn = screen.getByRole("button", { name: /^다음$|^Next$/ });
		expect((nextBtn as HTMLButtonElement).disabled).toBe(true);

		// Type a name → Next enabled
		const agentInput = screen.getByPlaceholderText(/이름|name/i);
		fireEvent.change(agentInput, { target: { value: "Naia" } });
		expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
	});

	it("complete step saves all config", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// Provider → Next
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// API key
		const apiInput = screen.getByPlaceholderText("API key...");
		fireEvent.change(apiInput, { target: { value: "test-key" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Agent name
		const agentInput = screen.getByPlaceholderText(/이름|name/i);
		fireEvent.change(agentInput, { target: { value: "Mochi" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// User name
		const nameInput = screen.getByPlaceholderText(/이름|name/i);
		fireEvent.change(nameInput, { target: { value: "Luke" } });
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Workspace step → Next (skip)
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Character → Next
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Personality → Next
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Speech style → Next
		fireEvent.click(screen.getByRole("button", { name: /^다음$|^Next$/ }));

		// Complete → Start
		fireEvent.click(screen.getByText(/시작|Get Started/));
		expect(onComplete).toHaveBeenCalled();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.userName).toBe("Luke");
		expect(config.agentName).toBe("Mochi");
		expect(config.onboardingComplete).toBe(true);
		expect(config.apiKey).toBe("test-key");
		expect(config.persona).toContain("Mochi");
	});
});
