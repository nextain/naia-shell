import { describe, expect, it } from "vitest";
import { createAgentBridge, type WorkerLike } from "../agent-bridge";

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
}

describe("agent-bridge", () => {
	it("satisfies the worker bridge lifecycle and line forwarding contract", async () => {
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

		// 1. sendLine 전에는 Worker 를 만들지 않는다.
		expect(workerCreationCount).toBe(0);
		expect(workerInstance).toBeNull();

		// 2. sendLine 을 세 번 불러도 Worker 는 하나다.
		bridge.sendLine("line-1");
		expect(workerCreationCount).toBe(1);
		const capturedWorker = workerInstance!;
		expect(capturedWorker).not.toBeNull();

		bridge.sendLine("line-2");
		bridge.sendLine("line-3");
		expect(workerCreationCount).toBe(1);

		// Worker 생성 시 넘긴 port2 확인
		expect(capturedWorker.posted).toHaveLength(1);
		expect(capturedWorker.posted[0].message).toEqual({
			kind: "naia-agent-connect",
		});
		const transferred = capturedWorker.posted[0].transfer;
		expect(transferred).toBeDefined();
		expect(transferred).toHaveLength(1);
		const workerPort = transferred![0] as MessagePort;
		expect(workerPort).toBeDefined();

		// 3. 넘긴 port2 로 Worker 쪽이 받은 줄이 보낸 줄과 같다.
		const receivedLines: string[] = [];
		workerPort.onmessage = (ev: MessageEvent) => {
			if (typeof ev.data === "string") {
				receivedLines.push(ev.data);
			}
		};
		workerPort.start?.();

		// 비동기 틱 대기
		await new Promise((r) => setTimeout(r, 50));
		expect(receivedLines).toEqual(["line-1", "line-2", "line-3"]);

		// 4. Worker 쪽이 port2.postMessage("{\"type\":\"finish\"}") 하면 emit 이 ("agent_response", 그 문자열) 로 한 번 불린다.
		const finishStr = '{"type":"finish"}';
		workerPort.postMessage(finishStr);
		await new Promise((r) => setTimeout(r, 50));
		expect(emittedEvents).toEqual([
			{ event: "agent_response", payload: finishStr },
		]);

		// 5. 문자열이 아닌 메시지는 emit 하지 않는다.
		workerPort.postMessage({ type: "finish" });
		workerPort.postMessage(12345);
		await new Promise((r) => setTimeout(r, 50));
		expect(emittedEvents).toHaveLength(1);

		// 6. 시험이 끝나면 포트를 닫는다.
		workerPort.close();
	});
});
