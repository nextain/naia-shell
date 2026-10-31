import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
	cancelOllamaModelPull,
	fetchOllamaModelCatalog,
	fetchOllamaModelPullStatus,
	ollamaModelPullErrorMessageKey,
	ollamaModelPullStateMessageKey,
	retryOllamaModelPull,
	startOllamaModelPull,
	type ModelPullSnapshot,
	type QwenModelPolicy,
} from "../ollama-runtime";

const snapshot: ModelPullSnapshot = {
	operationId: "pull-1",
	tag: "huihui_ai/qwen3.5-abliterated:2B",
	state: "pulling",
	stage: "pull",
	digest: null,
	error: null,
};

const policy: QwenModelPolicy = {
	candidates: [
		{
			id: "qwen35-abliterated-2b",
			displayName: "Qwen 3.5 Abliterated 2B",
			tag: "huihui_ai/qwen3.5-abliterated:2B",
			publishedSize: "1.9 GB",
			publishedSizeBytes: null,
			minimumFreeBytes: null,
			quantization: "Q4_K_M",
			sourceUrl: "https://ollama.com/huihui_ai/qwen3.5-abliterated:2B",
			license: "Apache License 2.0",
			licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
			publishedContextTokens: 262144,
			parameterSize: "2B",
		},
	],
	defaultModelTag: null,
	contextDefaultTokens: null,
	pullStartPolicy: null,
	modelStoreOverride: null,
	automaticSelectionPolicy: null,
	diskSpaceMultiplier: null,
	modelStoreAvailableBytes: null,
	showLicense: null,
	measuredPeakVramBytes: null,
	selectionHeadroomBytes: null,
};

describe("Ollama model pull Tauri bridge (#759)", () => {
	beforeEach(() => invokeMock.mockReset());

	it("loads the Rust-owned candidate catalog without inventing defaults", async () => {
		invokeMock.mockResolvedValue(policy);

		await expect(fetchOllamaModelCatalog()).resolves.toEqual(policy);
		expect(invokeMock).toHaveBeenCalledWith("ollama_model_catalog_list");
		expect(policy.defaultModelTag).toBeNull();
		expect(policy.pullStartPolicy).toBeNull();
		expect(policy.diskSpaceMultiplier).toBeNull();
	});

	it("preserves exact camelCase command arguments and snapshots", async () => {
		invokeMock
			.mockResolvedValueOnce(snapshot)
			.mockResolvedValueOnce({ operationId: "pull-2", snapshot })
			.mockResolvedValueOnce({ ...snapshot, state: "paused" })
			.mockResolvedValueOnce({ operationId: "pull-3", snapshot });

		await expect(fetchOllamaModelPullStatus(snapshot.tag)).resolves.toEqual(
			snapshot,
		);
		await expect(
			startOllamaModelPull(snapshot.tag, snapshot.tag),
		).resolves.toEqual({ operationId: "pull-2", snapshot });
		await expect(cancelOllamaModelPull("pull-2")).resolves.toMatchObject({
			state: "paused",
		});
		await expect(retryOllamaModelPull(snapshot.tag)).resolves.toMatchObject({
			operationId: "pull-3",
		});

		expect(invokeMock.mock.calls).toEqual([
			["ollama_model_pull_status", { tag: snapshot.tag }],
			[
				"ollama_model_pull_start",
				{ tag: snapshot.tag, confirmedTag: snapshot.tag },
			],
			["ollama_model_pull_cancel", { operationId: "pull-2" }],
			["ollama_model_pull_retry", { tag: snapshot.tag }],
		]);
	});

	it("maps backend states and groups errors into localized recovery guidance", () => {
		expect(ollamaModelPullStateMessageKey("ready")).toBe(
			"settings.ollamaPullStateReady",
		);
		expect(ollamaModelPullStateMessageKey("unexpected")).toBe(
			"settings.ollamaPullStateUnknown",
		);
		expect(ollamaModelPullErrorMessageKey("disk_margin_unset")).toBe(
			"settings.ollamaPullErrorPolicyPending",
		);
		expect(ollamaModelPullErrorMessageKey("model_digest_mismatch")).toBe(
			"settings.ollamaPullErrorVerification",
		);
		expect(ollamaModelPullErrorMessageKey("model_pull_active")).toBe(
			"settings.ollamaPullErrorBusy",
		);
		expect(ollamaModelPullErrorMessageKey("new_backend_error")).toBe(
			"settings.ollamaPullErrorUnknown",
		);
	});
});
