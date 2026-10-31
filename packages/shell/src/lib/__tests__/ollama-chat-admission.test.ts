import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
	assertOllamaChatAdmitted,
	OllamaRuntimeAdmissionError,
} from "../ollama-chat-admission";

const readyManaged = {
	state: "ready",
	serverState: "ready_managed",
	ownership: "managed_child",
	installedVersion: "0.40.3",
	installedVersions: ["0.40.3"],
	modelCount: 1,
	reservation: {
		kind: "local_llm",
		status: "running",
		bytes: null,
		reasonCode: null,
	},
	operationId: null,
	phase: null,
	error: null,
};

describe("Ollama chat admission boundary (#758/#759)", () => {
	beforeEach(() => invokeMock.mockReset());

	it("uses the existing local runtime reservation for managed Ollama", async () => {
		invokeMock.mockResolvedValue(readyManaged);

		await expect(
			assertOllamaChatAdmitted("http://localhost:11434"),
		).resolves.toBeUndefined();
		expect(invokeMock).toHaveBeenCalledWith("ollama_runtime_status", {
			host: "http://localhost:11434",
			deviceId: null,
		});
	});

	it("keeps the existing connected-local admission path", async () => {
		invokeMock.mockResolvedValue({
			...readyManaged,
			serverState: "ready_external_local",
			ownership: "external_local",
		});

		await expect(
			assertOllamaChatAdmitted("http://127.0.0.1:11434"),
		).resolves.toBeUndefined();
	});

	it("rejects local voice conflicts with the original reason code", async () => {
		invokeMock.mockResolvedValue({
			...readyManaged,
			reservation: {
				kind: "local_llm",
				status: "denied",
				bytes: null,
				reasonCode: "same_device_conflict",
			},
			error: {
				code: "reservation_denied",
				stage: "reservation",
				retryable: true,
				reasonCode: "same_device_conflict",
			},
		});

		const admission = assertOllamaChatAdmitted("http://localhost:11434");
		await expect(admission).rejects.toBeInstanceOf(OllamaRuntimeAdmissionError);
		await expect(admission).rejects.toMatchObject({
			reasonCode: "same_device_conflict",
		});
	});

	it("does not inspect or block remote Ollama hosts", async () => {
		await expect(
			assertOllamaChatAdmitted("https://ollama.example.test/v1"),
		).resolves.toBeUndefined();
		expect(invokeMock).not.toHaveBeenCalled();
	});
});
