import { describe, expect, it, vi } from "vitest";

const pricedModel = "gpt-4o-mini";
const inputTokens = 1999;
const outputTokens = 42;
const requestId = "r47";

function responseFor(cost: string | undefined, callsTool: boolean) {
	const delta = callsTool
		? {
				tool_calls: [{
					index: 0,
					id: "time-1",
					type: "function",
					function: { name: "get_time", arguments: "{}" },
				}],
			}
		: { content: "Hello" };
	const choice = { delta, finish_reason: callsTool ? "tool_calls" : "stop" };
	const costField = cost === undefined ? "" : `,"cost":${cost}`;
	return new Response(
		`data: ${JSON.stringify({ choices: [choice] })}\n\n` +
		'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":1}}\n\n' +
		`data: {"choices":[],"usage":{"prompt_tokens":${inputTokens},"completion_tokens":${outputTokens}${costField}}}\n\n` +
		"data: [DONE]\n\n",
	);
}

// The real browser agent imports resolve only with --mode web and NAIA_WEB_AGENT_DIR.
describe.skipIf(import.meta.env.MODE !== "web")("browser worker usage", () => {
	it.each([
		{ name: "forwards Terra billing", model: "gpt-6.1-terra", costs: ["0.0069043"], reported: 0.0069043, estimatedRounds: 0 },
		{ name: "keeps a reported zero", costs: ["0"], reported: 0, estimatedRounds: 0 },
		{ name: "estimates a missing cost", costs: [undefined], reported: 0, estimatedRounds: 1 },
		{ name: "ignores a string cost", costs: ['"0.0069043"'], reported: 0, estimatedRounds: 1 },
		{ name: "ignores a negative cost", costs: ["-0.0069043"], reported: 0, estimatedRounds: 1 },
		{ name: "ignores a non-finite JSON number", costs: ["1e309"], reported: 0, estimatedRounds: 1 },
		{ name: "sums billed tool rounds", costs: ["0.004", "0.002"], reported: 0.006, estimatedRounds: 0 },
		{ name: "estimates only the tool round without cost", costs: [undefined, "0.004"], reported: 0.004, estimatedRounds: 1 },
	])("R47 $name", async ({ model = pricedModel, costs, reported, estimatedRounds }) => {
		const { calculateCost } = await import("@naia-agent/domain/cost.js");
		const outer = new MessageChannel();
		const inner = new MessageChannel();
		const worker = Object.assign(new EventTarget(), { postMessage: vi.fn() });
		const notFound = async () => {
			throw new DOMException("missing", "NotFoundError");
		};
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error("Unexpected gateway request");
		});
		costs.forEach((cost, index) => {
			fetcher.mockImplementationOnce(async () => responseFor(cost, index < costs.length - 1));
		});
		vi.resetModules();
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		vi.stubGlobal("self", worker);
		vi.stubGlobal("MessageChannel", function () { return inner; });
		vi.stubGlobal("navigator", {
			storage: { getDirectory: async () => ({ getDirectoryHandle: notFound, getFileHandle: notFound }) },
		});
		vi.stubGlobal("fetch", fetcher);
		try {
			await import("../agent-worker");
			const messages: Array<{ type: string; requestId: string; success?: boolean }> = [];
			outer.port2.onmessage = ({ data }) => messages.push(JSON.parse(data));
			worker.dispatchEvent(new MessageEvent("message", {
				data: { kind: "naia-agent-connect", model: null },
				ports: [outer.port1],
			}));
			outer.port2.postMessage(JSON.stringify({
				type: "chat_request",
				requestId,
				provider: { provider: "nextain", model, naiaKey: "test-key", labGatewayUrl: "https://gateway.test" },
				messages: [{ role: "user", content: "Hello" }],
			}));
			await vi.waitFor(() => expect(messages.at(-1)?.type).toMatch(/^(finish|error)$/));
			expect(messages.at(-1)).toMatchObject({ type: "finish", requestId });
			expect(fetcher).toHaveBeenCalledTimes(costs.length);
			if (costs.length > 1) {
				expect(messages).toContainEqual(expect.objectContaining({ type: "tool_result", success: true }));
			}
			const estimatedCost = calculateCost(model, inputTokens, outputTokens, "nextain");
			if (estimatedRounds > 0) expect(estimatedCost).toBeGreaterThan(0);
			expect(messages.filter((message) => message.type === "usage")).toStrictEqual([{
				type: "usage",
				requestId,
				inputTokens: inputTokens * costs.length,
				outputTokens: outputTokens * costs.length,
				cost: reported + estimatedRounds * estimatedCost,
				model,
			}]);
		} finally {
			outer.port1.close();
			outer.port2.close();
			inner.port1.close();
			inner.port2.close();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});
});
