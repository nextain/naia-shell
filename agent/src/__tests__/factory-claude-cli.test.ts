import { describe, expect, it, vi } from "vitest";

const markerProvider = {
	stream: vi.fn(),
};

vi.mock("../providers/claude-code-cli.js", () => ({
	createClaudeCodeCliProvider: vi.fn(() => markerProvider),
}));

describe("provider factory - claude code cli", () => {
	it("builds claude-code-cli provider without api key", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const provider = buildProvider({
			provider: "claude-code-cli",
			model: "claude-sonnet-4-5-20250929",
			apiKey: "",
		});
		expect(provider).toBe(markerProvider);
	});

	it("routes claude-code-cli through CLI even when naiaKey is set (not lab-proxy)", async () => {
		// Regression: claude-opus-4-6 was sent to Naia gateway when naiaKey was present,
		// causing 'empty SSE stream' error. claude-code-cli must always use the local CLI.
		const { buildProvider, setAgentNaiaKey } = await import("../providers/factory.js");
		setAgentNaiaKey("gw-test1234567890abcdef1234567890abcdef1234567890ab");
		try {
			const provider = buildProvider({
				provider: "claude-code-cli",
				model: "claude-opus-4-6",
				apiKey: "",
			});
			expect(provider).toBe(markerProvider);
		} finally {
			setAgentNaiaKey(undefined);
		}
	});
});
