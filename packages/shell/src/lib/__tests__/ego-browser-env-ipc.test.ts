/**
 * #582 S6c — 감독자 면의 IPC 구현 (계약 4.2·4.8, 9절 S6c).
 *
 * 재는 것 셋.
 *  (1) 각 메서드가 **어느 명령을 어떤 인자로** 부르는가. 이름이나 인자가 어긋나면 Rust 는
 *      아무 일도 하지 않고, 그 침묵은 "감독자가 안 뜬다" 로만 보인다.
 *  (2) 감독자의 형식 있는 거부(`{error, error_code}`)가 뭉개지지 않고 그대로 오르는가.
 *  (3) 세션 프레임이 제 세션의 CDP·종료 처리로 가는가. 남의 세션 프레임은 가지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createIpcEgoHostApi,
	dispatchEgoHostFrame,
	resetEgoHostFrameListener,
} from "../ego-browser-env-ipc";

interface Call {
	readonly command: string;
	readonly args: Record<string, unknown>;
}

/** 명령마다 답을 정하는 대역 `invoke`. 무엇이 불렸는지 순서대로 남긴다. */
function fakeInvoke(responses: Record<string, unknown> = {}) {
	const calls: Call[] = [];
	const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
		calls.push({ command, args: args ?? {} });
		const answer = responses[command];
		if (typeof answer === "function") return (answer as (a: Record<string, unknown>) => unknown)(args ?? {});
		return answer;
	});
	return { calls, call: call as unknown as <T>(c: string, a?: Record<string, unknown>) => Promise<T> };
}

const READY = { socketPath: "/run/user/1000/naia-ego-host-abc.sock", browserPid: 4242, started: true };

beforeEach(() => {
	resetEgoHostFrameListener();
});

describe("감독자 면의 IPC 구현", () => {
	it("startSupervisor 는 ego_host_ensure 로 ADK 를 넘기고 소켓·PID 를 받는다", async () => {
		const { call, calls } = fakeInvoke({ ego_host_ensure: READY });
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk", platform: "linux" });

		expect(calls).toEqual([{ command: "ego_host_ensure", args: { adkDir: "/adk" } }]);
		expect(supervisor.socketPath).toBe(READY.socketPath);
		expect(supervisor.browserPid).toBe(4242);
	});

	it("issueToken 은 소유자 명령으로 가고 등급·승인을 그대로 싣는다", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_issue_token: { token: "t-1" },
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk" });
		const grant = { tier: "workspace-write" as const, approvalRef: "a-1" };
		const token = await supervisor.server.issueToken({ operationId: "op-1", workspaceId: "5", grant });

		expect(token).toBe("t-1");
		expect(calls[1]).toEqual({
			command: "ego_host_issue_token",
			args: { operationId: "op-1", workspaceId: "5", grant },
		});
	});

	it("감독자가 거부하면 던진다 — 빈 토큰으로 조용히 넘어가지 않는다", async () => {
		const { call } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_issue_token: { error: "관리 연결이 아니다", error_code: "EGO_HOST_ADMIN_REQUIRED" },
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk" });
		await expect(supervisor.server.issueToken({ operationId: "op-1" })).rejects.toThrow(
			/관리 연결이 아니다/,
		);
	});

	it("작업 취소·종결은 소유자 RPC 로 가고 결과를 그대로 옮긴다", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_rpc: { changed: true, status: "cancelled", cleanup: { sessions: ["s1"] } },
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk" });

		const cancelled = await supervisor.server.operations.cancel("op-9");
		expect(cancelled).toEqual({ changed: true, status: "cancelled", cleanup: { sessions: ["s1"] } });
		expect(calls[1].command).toBe("ego_host_rpc");
		expect(calls[1].args).toEqual({
			method: "cancelOperationOwned",
			params: { operationId: "op-9" },
		});

		await supervisor.server.operations.complete("op-9", { status: "completed" });
		expect(calls[2].args).toEqual({
			method: "endOperationOwned",
			params: { operationId: "op-9", status: "completed" },
		});
	});

	it("연결은 ego_host_session_open 으로 서고 RPC·CDP·닫기가 제 명령으로 간다", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_session_open: 7,
			ego_host_session_rpc: { tabs: [] },
			ego_host_session_cdp: null,
			ego_host_session_close: null,
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const client = await api.connectSupervisor({
			socketPath: READY.socketPath,
			token: "t-1",
			grant: { tier: "observe" },
			operationId: "op-2",
			workspaceId: "3",
			deadline: 12_000,
		});
		expect(calls[0]).toEqual({
			command: "ego_host_session_open",
			args: {
				token: "t-1",
				grant: { tier: "observe" },
				operationId: "op-2",
				workspaceId: "3",
				deadline: 12_000,
			},
		});

		await client.call("listTabs", { id: 3 });
		expect(calls[1]).toEqual({
			command: "ego_host_session_rpc",
			args: { session: 7, method: "listTabs", params: { id: 3 } },
		});

		client.sendCdp('{"id":1,"method":"Page.enable"}', { operationId: "op-2" });
		await Promise.resolve();
		expect(calls[2]).toEqual({
			command: "ego_host_session_cdp",
			args: { session: 7, payload: '{"id":1,"method":"Page.enable"}', operationId: "op-2" },
		});

		client.close();
		await Promise.resolve();
		expect(calls[3]).toEqual({ command: "ego_host_session_close", args: { session: 7 } });
	});

	it("다리가 끊기면 형식 있는 disconnected 로 옮긴다 — 던져서 상한을 채우지 않는다", async () => {
		const { call } = fakeInvoke({
			ego_host_session_open: 8,
			ego_host_session_rpc: () => {
				throw new Error("그런 세션이 없다: 8");
			},
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const client = await api.connectSupervisor({ token: "t-2" });
		const result = await client.call("snapshot", {});
		expect(result.error_code).toBe("EGO_HOST_DISCONNECTED");
		expect(String(result.error)).toContain("그런 세션이 없다");
	});

	it("세션 프레임은 제 세션으로만 간다", async () => {
		const { call } = fakeInvoke({ ego_host_session_open: 11 });
		const api = createIpcEgoHostApi(call, async () => undefined);
		const client = await api.connectSupervisor({ token: "t-3" });

		const seen: string[] = [];
		const closes: string[] = [];
		client.onCdp((raw) => seen.push(raw));
		client.onClose((error) => closes.push(error.message));

		dispatchEgoHostFrame({ session: 11, type: "cdp", payload: '{"id":1,"result":{}}' });
		dispatchEgoHostFrame({ session: 99, type: "cdp", payload: '{"id":2,"result":{}}' });
		expect(seen).toEqual(['{"id":1,"result":{}}']);

		dispatchEgoHostFrame({ session: 11, type: "closed" });
		dispatchEgoHostFrame({ session: 11, type: "closed" });
		expect(closes).toHaveLength(1);

		// 닫힌 뒤의 RPC 는 왕복하지 않고 그 자리에서 형식 있는 실패다.
		const after = await client.call("snapshot", {});
		expect(after.error_code).toBe("EGO_HOST_DISCONNECTED");
	});

	it("묶음 실행과 자리 만들기·`.env` 쓰기는 소유자 RPC 로 간다", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_rpc: (args: Record<string, unknown>) => {
				if (args.method === "runScript") {
					return { status: 0, stdout: "결과", stderr: "", timedOut: false };
				}
				if (args.method === "writeEnvFiles") return { written: ["/adk/ego-host/agent-workspace/.env"] };
				if (args.method === "waitForPidExit") return { exited: true };
				if (args.method === "reconcileLease") return { status: "no-lease", orphans: 0, note: "" };
				return {};
			},
		});
		const api = createIpcEgoHostApi(call, async () => undefined);

		// 감독자 전에는 자리를 만들 통로가 없다. 데몬이 기동하며 같은 자리를 만들므로
		// 여기서는 아무 명령도 나가지 않는다 — 없는 통로에 대고 실패를 만들지 않는다.
		await api.ensureDirs(["/adk/ego-host"]);
		expect(calls).toHaveLength(0);

		await api.startSupervisor({ adkDir: "/adk" });
		await api.ensureDirs(["/adk/ego-host"]);
		expect(calls[1].args).toEqual({ method: "ensureDirs", params: { dirs: ["/adk/ego-host"] } });

		const written = await api.writeEnvFiles([{ path: "/adk/ego-host/agent-workspace/.env", values: { HOME: "/adk" } }]);
		expect(written).toEqual(["/adk/ego-host/agent-workspace/.env"]);

		const run = await api.runEgoScript({ code: "console.log(1)", env: {}, timeoutMs: 5_000 });
		expect(run).toEqual({ status: 0, stdout: "결과", stderr: "", timedOut: false });

		expect(await api.waitForPidExit(4242, 1_000)).toBe(true);
		expect(await api.reconcileLease({ adkDir: "/adk" })).toEqual({
			status: "no-lease",
			orphans: 0,
			note: "",
		});
	});

	it("이 다리가 재지 않는 것은 재지 않는다고 말한다", async () => {
		const { call } = fakeInvoke({});
		const api = createIpcEgoHostApi(call, async () => undefined);
		// 프로세스 생존은 Rust 쪽 사실이다. 참을 지어내면 그 거짓이 판정 근거가 된다.
		expect(() => api.pidAlive(1)).toThrow(/재지 않는다/);
	});
});
