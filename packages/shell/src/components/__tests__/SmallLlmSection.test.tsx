// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../lib/config";
import { setLocale, t } from "../../lib/i18n";
import { SmallLlmSection } from "../SmallLlmSection";

function makeConfig(partial: Partial<AppConfig> = {}): AppConfig {
	return {
		provider: "nextain",
		model: "deepseek-v4-flash",
		apiKey: "",
		...partial,
	} as AppConfig;
}

describe("SmallLlmSection", () => {
	beforeEach(async () => {
		await setLocale("en");
	});

	afterEach(async () => {
		cleanup();
		vi.clearAllMocks();
		await setLocale("en");
	});

	it("(a) renders off_no_llm state when not logged in with naia role and disables naia radio", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={false}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		expect(stateEl.textContent).toBe(t("settings.surfacingOffNoLlm"));

		const naiaRadio = screen.getByTestId("small-llm-choice-naia");
		expect(naiaRadio).toBeDisabled();
	});

	it("(b) shows pending-gateway message when logged in and catalog lacks gpt-5.4-nano", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		const fetchCatalog = vi
			.fn()
			.mockResolvedValue(new Map([["other-model", {}]]));
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={fetchCatalog}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		await waitFor(() => {
			expect(stateEl.textContent).toBe(
				t("settings.surfacingPendingGateway", { model: "gpt-5.4-nano" }),
			);
		});
	});

	it("(c) shows on/naia state when logged in and catalog includes gpt-5.4-nano", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		const fetchCatalog = vi
			.fn()
			.mockResolvedValue(new Map([["gpt-5.4-nano", {}]]));
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={fetchCatalog}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		await waitFor(() => {
			expect(stateEl.textContent).toBe(
				t("settings.surfacingOnNaia", { model: "gpt-5.4-nano" }),
			);
		});
	});

	it("(d) calls onPersist with normalized baseUrl and model when choosing ollama, typing model, and blurring", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const ollamaRadio = screen.getByTestId("small-llm-choice-ollama");
		fireEvent.click(ollamaRadio);

		const modelInput = screen.getByTestId("small-llm-model");
		fireEvent.change(modelInput, { target: { value: "qwen3:4b" } });
		fireEvent.blur(modelInput);

		expect(onPersist).toHaveBeenCalledWith(
			expect.objectContaining({
				llmRoles: expect.objectContaining({
					memory: {
						provider: "ollama",
						model: "qwen3:4b",
						baseUrl: "http://localhost:11434/v1",
					},
				}),
				memorySurfacing: "on",
				memoryLlmProvider: "ollama",
			}),
		);
	});

	it("(e) calls onPersist with memorySurfacing off when off choice is selected", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const offRadio = screen.getByTestId("small-llm-choice-off");
		fireEvent.click(offRadio);

		expect(onPersist).toHaveBeenCalledWith(
			expect.objectContaining({
				memorySurfacing: "off",
			}),
		);
	});

	it("(f) treats rejected catalog fetch as unknown and shows on/naia state without pending message", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		const fetchCatalog = vi
			.fn()
			.mockRejectedValue(new Error("network error"));
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={fetchCatalog}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		await waitFor(() => {
			expect(stateEl.textContent).toBe(
				t("settings.surfacingOnNaia", { model: "gpt-5.4-nano" }),
			);
		});
		expect(stateEl.textContent).not.toContain("gateway");
	});

	it("(g) preserves chosen ollama radio and typed model when re-rendered with new but equal config", async () => {
		const config = makeConfig({
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		const onPersist = vi.fn();
		const { rerender } = render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const ollamaRadio = screen.getByTestId("small-llm-choice-ollama");
		fireEvent.click(ollamaRadio);

		const modelInput = screen.getByTestId("small-llm-model") as HTMLInputElement;
		fireEvent.change(modelInput, { target: { value: "qwen" } });

		expect(ollamaRadio).toBeChecked();
		expect(modelInput.value).toBe("qwen");

		rerender(
			<SmallLlmSection
				config={{ ...config }}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const ollamaRadioAfter = screen.getByTestId("small-llm-choice-ollama");
		const modelInputAfter = screen.getByTestId("small-llm-model") as HTMLInputElement;
		expect(ollamaRadioAfter).toBeChecked();
		expect(modelInputAfter.value).toBe("qwen");
	});
});
