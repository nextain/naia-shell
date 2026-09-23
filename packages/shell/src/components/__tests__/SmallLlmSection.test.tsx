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
		memoryEmbeddingProvider: "offline",
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

	it("(a) renders on-threshold state when not logged in with naia role and disables naia radio", async () => {
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
		expect(stateEl.textContent).toBe(
			t("settings.surfacingOnThreshold", { threshold: "0.86" }),
		);

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
				t("settings.surfacingThresholdPendingGateway", {
					model: "gpt-5.4-nano",
					threshold: "0.86",
				}),
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

	it("renders off-disabled text, hides level radiogroup, and shows memory tool note when off is selected", async () => {
		const config = makeConfig({
			memorySurfacing: "off",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={vi.fn()}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		expect(stateEl.textContent).toBe(t("settings.surfacingOffDisabled"));
		expect(screen.queryByTestId("surfacing-level")).toBeNull();
		expect(screen.getByTestId("surfacing-memory-tool-note")).toBeVisible();
	});

	it("renders level radios with normal checked by default and calls onPersist when clicking more", async () => {
		const config = makeConfig();
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

		const normalRadio = screen.getByTestId("surfacing-level-normal");
		expect(normalRadio).toBeChecked();

		const moreRadio = screen.getByTestId("surfacing-level-more");
		expect(moreRadio).not.toBeChecked();
		fireEvent.click(moreRadio);

		expect(onPersist).toHaveBeenCalledWith(
			expect.objectContaining({
				memorySurfacingLevel: "more",
			}),
		);
	});

	it("renders off-no-embedding text when memoryEmbeddingProvider is none", async () => {
		const config = makeConfig({
			memoryEmbeddingProvider: "none",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={vi.fn()}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		expect(stateEl.textContent).toBe(t("settings.surfacingOffNoEmbedding"));
	});

	it("renders memory tool note in every state", async () => {
		const onPersist = vi.fn();
		const { rerender } = render(
			<SmallLlmSection
				config={makeConfig({ memoryEmbeddingProvider: "none" })}
				naiaKeyPresent={false}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);
		expect(screen.getByTestId("surfacing-memory-tool-note")).toBeVisible();

		rerender(
			<SmallLlmSection
				config={makeConfig({ memorySurfacing: "off" })}
				naiaKeyPresent={false}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);
		expect(screen.getByTestId("surfacing-memory-tool-note")).toBeVisible();

		rerender(
			<SmallLlmSection
				config={makeConfig()}
				naiaKeyPresent={false}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);
		expect(screen.getByTestId("surfacing-memory-tool-note")).toBeVisible();
	});

	it("not logged in + memorySurfacing: 'off' -> click small-llm-choice-threshold -> onPersist called with memorySurfacing: 'on' and memory role unchanged", async () => {
		const initialMemoryRole = { provider: "nextain", model: "gpt-5.4-nano" };
		const config = makeConfig({
			memorySurfacing: "off",
			llmRoles: {
				memory: initialMemoryRole,
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

		const thresholdRadio = screen.getByTestId("small-llm-choice-threshold");
		fireEvent.click(thresholdRadio);

		expect(onPersist).toHaveBeenCalledTimes(1);
		const persisted = onPersist.mock.calls[0][0];
		expect(persisted.memorySurfacing).toBe("on");
		expect(persisted.memorySurfacingJudge).toBe("threshold");
		expect(persisted.llmRoles?.memory).toEqual(initialMemoryRole);
	});

	it("local ollama role configured -> clicking threshold -> memory role unchanged, memorySurfacingJudge: 'threshold'", async () => {
		const memoryRole = {
			provider: "ollama",
			model: "llama3",
			baseUrl: "http://localhost:11434/v1",
		};
		const config = makeConfig({
			llmRoles: {
				memory: memoryRole,
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

		const thresholdRadio = screen.getByTestId("small-llm-choice-threshold");
		fireEvent.click(thresholdRadio);

		expect(onPersist).toHaveBeenCalledWith(
			expect.objectContaining({
				memorySurfacing: "on",
				memorySurfacingJudge: "threshold",
				llmRoles: expect.objectContaining({
					memory: memoryRole,
				}),
			}),
		);
	});

	it("logged in with Naia role -> the threshold radio is rendered, clicking it calls onPersist with judge threshold, and state text is chosen text after re-render", async () => {
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
				fetchCatalog={vi.fn().mockResolvedValue(new Map([["gpt-5.4-nano", {}]]))}
			/>,
		);

		const thresholdRadio = screen.getByTestId("small-llm-choice-threshold");
		expect(thresholdRadio).toBeInTheDocument();
		fireEvent.click(thresholdRadio);

		expect(onPersist).toHaveBeenCalledWith(
			expect.objectContaining({
				memorySurfacing: "on",
				memorySurfacingJudge: "threshold",
			}),
		);

		rerender(
			<SmallLlmSection
				config={{
					...config,
					memorySurfacing: "on",
					memorySurfacingJudge: "threshold",
				}}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={onPersist}
				fetchCatalog={vi.fn().mockResolvedValue(new Map([["gpt-5.4-nano", {}]]))}
			/>,
		);

		const stateEl = screen.getByTestId("small-llm-state");
		expect(stateEl.textContent).toBe(
			t("settings.surfacingThresholdChosen", { threshold: "0.86" }),
		);
	});

	it("memoryEmbeddingProvider: 'none' -> level group not rendered", async () => {
		const config = makeConfig({
			memoryEmbeddingProvider: "none",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		});
		render(
			<SmallLlmSection
				config={config}
				naiaKeyPresent={true}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={vi.fn()}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		expect(screen.queryByTestId("surfacing-level")).toBeNull();
	});

	it("config={null} renders nothing and does not throw", () => {
		const { container } = render(
			<SmallLlmSection
				config={null}
				naiaKeyPresent={false}
				gatewayHttpUrl="http://localhost:1420"
				onPersist={vi.fn()}
				fetchCatalog={vi.fn().mockResolvedValue(null)}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});
});
