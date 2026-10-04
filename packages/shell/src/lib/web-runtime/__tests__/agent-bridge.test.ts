import { beforeEach, describe, expect, it } from "vitest";
import { createAgentBridge, type WorkerLike } from "../agent-bridge";
import {
	getWebModelStatus,
	resetWebModelStatusForTests,
} from "../web-model-status";
import { WEB_LLM_MODEL_ID } from "../webllm-model";

class FakeWorker implements WorkerLike {
	posted: { message: unknown; transfer?: Transferable[] }[] = [];
	listeners: Record<string, ((ev: unknown) => void)[]> = {};

	postMessage(message: unknown, transfer?: Transferable[]): void {
		this.posted.push({ message, transfer });
	}

	addEventListener(type: string, listener: (ev: unknown) => void): void {
		if (!this.listeners[type]) {
			this.listeners[type] = [];
		}
		this.listeners[type].push(listener);
	}

	dispatchMessage(data: unknown): void {
		for (const listener of this.listeners["message"] ?? []) {
			listener({ data });
		}
	}

	dispatchError(error: unknown): void {
		for (const listener of this.listeners["error"] ?? []) {
			listener(error);
		}
	}
}

describe("agent-bridge", () => {
	beforeEach(() => {
		resetWebModelStatusForTests();
	});

	it("creates worker only on start and buffers lines sent before start", async () => {
		let workerCreationCount = 0;
		let workerInstance: FakeWorker | null = null;
		const emittedEvents: { event: string; payload: unknown }[] = [];

		const createWorker = (): WorkerLike => {
			workerCreationCount++;
			workerInstance = new FakeWorker();
			return workerInstance;
		};

		const emit = (event: string, payload: unknown) => {
			emittedEvents.push({ event, payload });
		};

		const bridge = createAgentBridge({ createWorker, emit });

		// 1. sendLine before start: does NOT create worker, buffers line
		bridge.sendLine("buffered-1");
		bridge.sendLine("buffered-2");
		expect(workerCreationCount).toBe(0);
		expect(workerInstance).toBeNull();

		// 2. start: creates worker exactly once, carries model in connect message
		bridge.start({ model: WEB_LLM_MODEL_ID });
		expect(workerCreationCount).toBe(1);
		const capturedWorker = workerInstance!;
		expect(capturedWorker).not.toBeNull();

		// Calling start again does not create another worker
		bridge.start({ model: "another-model" });
		expect(workerCreationCount).toBe(1);

		// Worker connect message checks
		expect(capturedWorker.posted).toHaveLength(1);
		expect(capturedWorker.posted[0].message).toEqual({
			kind: "naia-agent-connect",
			model: WEB_LLM_MODEL_ID,
		});
		const transferred = capturedWorker.posted[0].transfer;
		expect(transferred).toBeDefined();
		expect(transferred).toHaveLength(1);
		const workerPort = transferred![0] as MessagePort;

		// 3. Buffered lines are delivered in order, subsequent sendLine goes directly
		const receivedLines: string[] = [];
		workerPort.onmessage = (ev: MessageEvent) => {
			if (typeof ev.data === "string") {
				receivedLines.push(ev.data);
			}
		};
		workerPort.start?.();

		bridge.sendLine("immediate-3");

		await new Promise((r) => setTimeout(r, 50));
		expect(receivedLines).toEqual(["buffered-1", "buffered-2", "immediate-3"]);

		// Response emitting via MessagePort
		const finishStr = '{"type":"finish"}';
		workerPort.postMessage(finishStr);
		await new Promise((r) => setTimeout(r, 50));
		expect(emittedEvents).toEqual([
			{ event: "agent_response", payload: finishStr },
		]);

		workerPort.close();
	});

	it("updates web-model-status store from control messages", () => {
		let workerInstance: FakeWorker | null = null;
		const bridge = createAgentBridge({
			createWorker: () => {
				workerInstance = new FakeWorker();
				return workerInstance;
			},
			emit: () => {},
		});

		bridge.start({ model: WEB_LLM_MODEL_ID });
		const worker = workerInstance!;

		// engine-progress
		worker.dispatchMessage({
			kind: "engine-progress",
			progress: 0.42,
			text: "fetching weights",
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "loading",
			progress: 0.42,
		});

		// engine-ready with whitelisted model
		worker.dispatchMessage({
			kind: "engine-ready",
			model: WEB_LLM_MODEL_ID,
			elapsedMs: 1234,
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "ready",
			progress: 1,
			model: WEB_LLM_MODEL_ID,
		});

		// engine-ready with unknown model does not update store
		worker.dispatchMessage({
			kind: "engine-ready",
			model: "Unknown-Model",
		});
		expect(getWebModelStatus().model).toBe(WEB_LLM_MODEL_ID);

		// engine-error with WebGPUNotAvailableError
		worker.dispatchMessage({
			kind: "engine-error",
			name: "WebGPUNotAvailableError",
			message: "No WebGPU",
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "error",
			errorKind: "no-webgpu",
			errorMessage: "No WebGPU",
		});

		// progress ignored when in error phase
		worker.dispatchMessage({
			kind: "engine-progress",
			progress: 0.99,
		});
		expect(getWebModelStatus().phase).toBe("error");

		// engine-error with ShaderF16SupportError
		worker.dispatchMessage({
			kind: "engine-error",
			name: "ShaderF16SupportError",
			message: "Shader F16 not supported",
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "error",
			errorKind: "no-shader-f16",
		});

		// engine-error with DeviceLostError
		worker.dispatchMessage({
			kind: "engine-error",
			name: "DeviceLostError",
			message: "Device Lost",
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "error",
			errorKind: "device-lost",
		});

		// engine-error with WebGPUNotFoundError
		worker.dispatchMessage({
			kind: "engine-error",
			name: "WebGPUNotFoundError",
			message: "GPU not found",
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "error",
			errorKind: "no-webgpu",
		});

		// engine-error with unknown error name
		worker.dispatchMessage({
			kind: "engine-error",
			name: "SomethingElseError",
			message: "Failed to compile shader",
		});
		expect(getWebModelStatus()).toMatchObject({
			phase: "error",
			errorKind: "load-failed",
			errorMessage: "Failed to compile shader",
		});

		// worker error event sets load-failed
		worker.dispatchError({ message: "Worker runtime fatal error" });
		expect(getWebModelStatus()).toMatchObject({
			phase: "error",
			errorKind: "load-failed",
			errorMessage: "Worker runtime fatal error",
		});
	});
});
